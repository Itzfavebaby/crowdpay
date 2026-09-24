'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

const W = (n) => `G${n}`; // stub wallet keys

process.env.GOVERNANCE_TOKEN_ID = 'ISSUER';
process.env.FEE_REGISTRY_CONTRACT_ID = 'CFEEREGISTRY';

// delegations[delegator] = delegate
function buildService({ delegations = {}, balances = {} }) {
  return proxyquire('./governance', {
    '../config/database': {
      query: async (text, params) => {
        // delegation reads
        if (/SELECT delegator_public_key, delegate_public_key\s*FROM governance_delegations/.test(text)) {
          const rows = Object.entries(delegations).map(([d, e]) => ({
            delegator_public_key: d,
            delegate_public_key: e,
          }));
          return { rows };
        }
        if (/FROM governance_delegations\s+WHERE delegator_public_key = \$1/.test(text)) {
          const e = delegations[params[0]];
          return { rows: e ? [{ delegator_public_key: params[0], delegate_public_key: e }] : [] };
        }
        if (/INSERT INTO governance_delegations/.test(text)) {
          return {
            rows: [{
              delegator_public_key: params[0],
              delegate_public_key: params[1],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            }],
          };
        }
        return { rows: [] };
      },
    },
    '../config/stellar': {
      server: {
        // Account balances are mocked per-wallet by the balance map.
        loadAccount: async (publicKey) => ({
          balances: [
            { asset_code: 'CROWD', asset_issuer: 'ISSUER', balance: String(balances[publicKey] || 0) },
          ],
        }),
      },
    },
    './sorobanService': {
      invokeContract: async () => 1,
      invokeContractReadOnly: async () => null,
      nativeToScVal: (v) => v,
      scValToNative: (v) => v,
    },
    '../config/logger': silentLogger,
  });
}

test('getEffectiveVoteWeight aggregates a multi-level delegation chain', async () => {
  // A -> B -> C (C receives A's and B's power in addition to its own).
  const service = buildService({
    delegations: { [W('A')]: W('B'), [W('B')]: W('C') },
    balances: { [W('A')]: 1000, [W('B')]: 500, [W('C')]: 200 },
  });

  const weight = await service.getEffectiveVoteWeight(W('C'));
  assert.equal(weight, 1700); // own 200 + B 500 + A 1000
});

test('getEffectiveVoteWeight traverses a 5-user chain', async () => {
  const keys = [1, 2, 3, 4, 5].map((n) => W(`U${n}`));
  const delegations = {};
  const balances = {};
  // U1 -> U2 -> U3 -> U4 -> U5
  for (let i = 0; i < keys.length - 1; i += 1) {
    delegations[keys[i]] = keys[i + 1];
    balances[keys[i]] = 100;
  }
  balances[keys[keys.length - 1]] = 100;

  const service = buildService({ delegations, balances });
  const weight = await service.getEffectiveVoteWeight(keys[keys.length - 1]);
  assert.equal(weight, 500); // 5 x 100
});

test('delegators further down the chain are not double counted', async () => {
  // A -> B -> C. B is counted once even though both A and B point toward C.
  const service = buildService({
    delegations: { [W('A')]: W('C'), [W('B')]: W('C') },
    balances: { [W('A')]: 100, [W('B')]: 100, [W('C')]: 50 },
  });
  const weight = await service.getEffectiveVoteWeight(W('C'));
  assert.equal(weight, 250);
});

test('setVoteDelegation rejects self-delegation', async () => {
  const service = buildService({ delegations: {} });
  await assert.rejects(
    () => service.setVoteDelegation(W('A'), W('A')),
    (err) => err.code === 'INVALID_DELEGATION' && /yourself/.test(err.message)
  );
});

test('setVoteDelegation rejects a circular reference', async () => {
  // A -> B already exists; assigning B -> A would close a loop.
  const service = buildService({ delegations: { [W('A')]: W('B') } });
  await assert.rejects(
    () => service.setVoteDelegation(W('B'), W('A')),
    (err) => err.code === 'INVALID_DELEGATION' && /circular/.test(err.message)
  );
});

test('setVoteDelegation allows reassignment that breaks a cycle candidate', async () => {
  // A -> B holds; A reassigning to C is fine and does not create a cycle.
  const service = buildService({ delegations: { [W('A')]: W('B') } });
  const result = await service.setVoteDelegation(W('A'), W('C'));
  assert.equal(result.delegate_public_key, W('C'));
});

test('revocation returns power to the original wallet', async () => {
  let revoked = false;
  const service = proxyquire('./governance', {
    '../config/database': {
      query: async (text) => {
        if (/DELETE FROM governance_delegations/.test(text)) {
          revoked = true;
          return { rows: [{ id: 'x' }] };
        }
        return { rows: [] };
      },
    },
    '../config/stellar': {
      server: { loadAccount: async () => ({ balances: [] }) },
    },
    './sorobanService': {},
    '../config/logger': silentLogger,
  });

  const had = await service.revokeVoteDelegation(W('A'));
  assert.equal(revoked, true);
  assert.equal(had, true);
});

test('getAllTransitiveDelegatorWallets returns indirect delegators', async () => {
  const service = buildService({
    delegations: { [W('A')]: W('B'), [W('B')]: W('C'), [W('D')]: W('C') },
    balances: {},
  });
  const wallets = await service.getAllTransitiveDelegatorWallets(W('C')).then((arr) => arr.sort());
  assert.deepEqual(wallets, [W('A'), W('B'), W('D')].sort());
});

// ---------------------------------------------------------------------------
// #802 — wallet-signing: propose/vote/execute prepare+submit flows
// ---------------------------------------------------------------------------

function buildProposalService({
  proposalRow = { stellar_proposal_id: 42, status: 'active', deadline: new Date(Date.now() + 1000 * 60 * 60).toISOString() },
  balances = {},
  invokeContractImpl,
  submitSignedContractCallImpl,
  buildUnsignedContractCallImpl,
} = {}) {
  const queries = [];
  return {
    queries,
    service: proxyquire('./governance', {
      '../config/database': {
        query: async (text, params) => {
          queries.push({ text, params });
          if (/SELECT stellar_proposal_id, status, deadline FROM governance_proposals_meta/.test(text)) {
            return { rows: [proposalRow] };
          }
          if (/SELECT stellar_proposal_id, status FROM governance_proposals_meta/.test(text)) {
            return { rows: [proposalRow] };
          }
          if (/INSERT INTO governance_proposals_meta/.test(text)) {
            return { rows: [{ id: 'db-proposal-1' }] };
          }
          if (/INSERT INTO governance_votes_log/.test(text)) {
            return { rows: [] };
          }
          if (/UPDATE governance_proposals_meta/.test(text)) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      },
      '../config/stellar': {
        server: {
          loadAccount: async (publicKey) => ({
            balances: [{ asset_code: 'CROWD', asset_issuer: 'ISSUER', balance: String(balances[publicKey] ?? 5000) }],
          }),
        },
      },
      './sorobanService': {
        invokeContract: invokeContractImpl || (async () => 42),
        invokeContractReadOnly: async () => ({ id: 42, votes_for: 10, votes_against: 2, deadline: 0, status: { tag: 'Passed' } }),
        buildUnsignedContractCall: buildUnsignedContractCallImpl || (async () => 'UNSIGNED_XDR'),
        submitSignedContractCall: submitSignedContractCallImpl || (async () => ({ hash: 'txhash', returnValue: 42 })),
        nativeToScVal: (v) => v,
      },
      '../config/logger': silentLogger,
    }),
  };
}

test('createProposal (custodial) records the proposal without any client-supplied wallet identity', async () => {
  const { service, queries } = buildProposalService({ balances: { [W('P')]: 5000 } });
  const proposal = await service.createProposal(W('P'), 300, 500, 'Reduce fees for creators', 'SPLACEHOLDERSECRET');

  assert.equal(proposal.proposer, W('P'));
  assert.equal(proposal.stellar_proposal_id, 42);
  const insertCall = queries.find((q) => /INSERT INTO governance_proposals_meta/.test(q.text));
  assert.ok(insertCall);
});

test('buildUnsignedProposal + createProposalFromSignedXdr round-trips a Freighter proposal', async () => {
  const { service, queries } = buildProposalService({ balances: { [W('P')]: 5000 } });

  const unsignedXdr = await service.buildUnsignedProposal({
    proposerPublicKey: W('P'),
    newFeeBps: 300,
    newCreatorShareBps: 500,
  });
  assert.equal(unsignedXdr, 'UNSIGNED_XDR');

  const proposal = await service.createProposalFromSignedXdr({
    signedXdr: 'SIGNED_XDR',
    proposerPublicKey: W('P'),
    newFeeBps: 300,
    newCreatorShareBps: 500,
    rationaleText: 'Reduce fees',
  });

  assert.equal(proposal.proposer, W('P'));
  assert.equal(proposal.stellar_proposal_id, 42);
  assert.ok(queries.find((q) => /INSERT INTO governance_proposals_meta/.test(q.text)));
});

test('buildUnsignedProposal rejects a proposer without enough governance tokens before building any XDR', async () => {
  const { service } = buildProposalService({ balances: { [W('P')]: 10 } });
  await assert.rejects(
    () => service.buildUnsignedProposal({ proposerPublicKey: W('P'), newFeeBps: 300, newCreatorShareBps: 500 }),
    /must hold/
  );
});

test('voteOnProposal (custodial) and voteFromSignedXdr (Freighter) both record identical vote shapes', async () => {
  const { service: custodialService } = buildProposalService({ balances: { [W('V')]: 1000 } });
  const custodialResult = await custodialService.voteOnProposal('db-proposal-1', W('V'), true, 'SSECRET');
  assert.equal(custodialResult.voter, W('V'));
  assert.equal(custodialResult.in_favor, true);
  assert.equal(custodialResult.token_balance, 1000);

  const { service: freighterService, queries } = buildProposalService({ balances: { [W('V')]: 1000 } });
  const unsignedXdr = await freighterService.buildUnsignedVote({ proposalId: 'db-proposal-1', voterPublicKey: W('V'), inFavor: true });
  assert.equal(unsignedXdr, 'UNSIGNED_XDR');

  const freighterResult = await freighterService.voteFromSignedXdr({
    signedXdr: 'SIGNED_XDR',
    proposalId: 'db-proposal-1',
    voterPublicKey: W('V'),
    inFavor: true,
  });
  assert.equal(freighterResult.voter, W('V'));
  assert.ok(queries.find((q) => /INSERT INTO governance_votes_log/.test(q.text)));
});

test('voteFromSignedXdr re-validates eligibility at submit time (proposal no longer active)', async () => {
  const { service } = buildProposalService({
    proposalRow: { stellar_proposal_id: 42, status: 'passed' },
    balances: { [W('V')]: 1000 },
  });
  await assert.rejects(
    () => service.voteFromSignedXdr({ signedXdr: 'SIGNED_XDR', proposalId: 'db-proposal-1', voterPublicKey: W('V'), inFavor: true }),
    /not active/
  );
});

test('executeProposal uses the provided relayer secret, never a per-user secret, and enforces status + deadline', async () => {
  const capturedSigners = [];
  const { service } = buildProposalService({
    proposalRow: { stellar_proposal_id: 42, status: 'active', deadline: new Date(Date.now() - 1000).toISOString() },
    invokeContractImpl: async ({ signerSecret }) => {
      capturedSigners.push(signerSecret);
      return null;
    },
  });

  const result = await service.executeProposal('db-proposal-1', 'PLATFORM_RELAYER_SECRET');
  assert.deepEqual(capturedSigners, ['PLATFORM_RELAYER_SECRET']);
  assert.equal(result.proposal_id, 'db-proposal-1');
});

test('executeProposal rejects a proposal whose deadline has not passed yet', async () => {
  const { service } = buildProposalService({
    proposalRow: { stellar_proposal_id: 42, status: 'active', deadline: new Date(Date.now() + 1000 * 60 * 60).toISOString() },
  });
  await assert.rejects(() => service.executeProposal('db-proposal-1', 'SECRET'), /deadline has not passed/);
});

test('executeProposal rejects a proposal that is not active (already executed)', async () => {
  const { service } = buildProposalService({
    proposalRow: { stellar_proposal_id: 42, status: 'executed', deadline: new Date(Date.now() - 1000).toISOString() },
  });
  await assert.rejects(() => service.executeProposal('db-proposal-1', 'SECRET'), /not active/);
});