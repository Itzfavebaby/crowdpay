const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

const WALLET = {
  custodial: {
    wallet_public_key: 'GCUSTODIAL',
    wallet_secret_encrypted: 'ENCRYPTED_BLOB',
    wallet_type: 'custodial',
  },
  freighter: {
    wallet_public_key: 'GFREIGHTER',
    wallet_secret_encrypted: null,
    wallet_type: 'freighter',
  },
};

function buildApp({ userId = 'user-1', wallet = WALLET.custodial, governanceImpl = {}, sorobanImpl = {} } = {}) {
  const calls = { createProposal: [], voteOnProposal: [], executeProposal: [], createProposalFromSignedXdr: [], voteFromSignedXdr: [] };

  const governanceStub = {
    getAllProposals: async () => [],
    getProposalById: async () => null,
    getUserTokenBalance: async () => 5000,
    getEffectiveVoteWeight: async () => 5000,
    setVoteDelegation: async () => ({}),
    revokeVoteDelegation: async () => true,
    getDelegateForWallet: async () => null,
    createProposal: async (...args) => {
      calls.createProposal.push(args);
      return { id: 'db-proposal-1', stellar_proposal_id: 42, status: 'active' };
    },
    buildUnsignedProposal: async () => 'UNSIGNED_PROPOSE_XDR',
    createProposalFromSignedXdr: async (args) => {
      calls.createProposalFromSignedXdr.push(args);
      return { id: 'db-proposal-1', stellar_proposal_id: 42, status: 'active' };
    },
    voteOnProposal: async (...args) => {
      calls.voteOnProposal.push(args);
      return { proposal_id: args[0], voter: args[1], in_favor: args[2], token_balance: 5000 };
    },
    buildUnsignedVote: async () => 'UNSIGNED_VOTE_XDR',
    voteFromSignedXdr: async (args) => {
      calls.voteFromSignedXdr.push(args);
      return { proposal_id: args.proposalId, voter: args.voterPublicKey, in_favor: args.inFavor, token_balance: 5000 };
    },
    executeProposal: async (...args) => {
      calls.executeProposal.push(args);
      return { proposal_id: args[0], status: 'executed', executed_at: new Date() };
    },
    syncProposalData: async () => {},
    ...governanceImpl,
  };

  const sorobanStub = {
    validateSubmittedContractCallXdr: () => true,
    ...sorobanImpl,
  };

  const router = proxyquire('./governance', {
    '../services/governance': governanceStub,
    '../services/sorobanService': sorobanStub,
    '../services/feeRegistry': {
      getFeeRegistryInfo: async () => ({}),
      invalidateFeeCache: () => {},
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SDECRYPTEDSECRET'),
    },
    '../config/database': {
      query: async () => ({ rows: [wallet] }),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/governance', router);
  return { app, calls };
}

test('POST /api/governance/proposals (custodial) creates a proposal without any signer_secret in the request', async () => {
  const prevPlatformKey = process.env.PLATFORM_SECRET_KEY;
  const { app, calls } = buildApp({ wallet: WALLET.custodial });

  const res = await request(app)
    .post('/api/governance/proposals')
    .send({ new_fee_bps: 300, new_creator_share_bps: 500, rationale_text: 'Reduce fees for creators' });

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(calls.createProposal.length, 1);
  const [proposerPublicKey, newFeeBps, newCreatorShareBps, rationaleText, signerSecret] = calls.createProposal[0];
  assert.equal(proposerPublicKey, WALLET.custodial.wallet_public_key);
  assert.equal(newFeeBps, 300);
  assert.equal(newCreatorShareBps, 500);
  assert.equal(rationaleText, 'Reduce fees for creators');
  // The decrypted secret comes from withDecryptedWalletSecret, never the request body.
  assert.equal(signerSecret, 'SDECRYPTEDSECRET');
  process.env.PLATFORM_SECRET_KEY = prevPlatformKey;
});

test('POST /api/governance/proposals ignores a client-supplied signer_secret entirely', async () => {
  const { app, calls } = buildApp({ wallet: WALLET.custodial });

  await request(app)
    .post('/api/governance/proposals')
    .send({
      new_fee_bps: 300,
      new_creator_share_bps: 500,
      rationale_text: 'Reduce fees for creators',
      signer_secret: 'SATTACKERSUPPLIEDSECRET',
    });

  const [, , , , signerSecret] = calls.createProposal[0];
  assert.notEqual(signerSecret, 'SATTACKERSUPPLIEDSECRET');
  assert.equal(signerSecret, 'SDECRYPTEDSECRET');
});

test('POST /api/governance/proposals (freighter) returns an unsigned XDR and prepare token instead of creating anything', async () => {
  const { app, calls } = buildApp({ wallet: WALLET.freighter });

  const res = await request(app)
    .post('/api/governance/proposals')
    .send({ new_fee_bps: 300, new_creator_share_bps: 500, rationale_text: 'Reduce fees for creators' });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'prepare');
  assert.equal(res.body.unsigned_xdr, 'UNSIGNED_PROPOSE_XDR');
  assert.ok(res.body.prepare_token);
  assert.equal(calls.createProposal.length, 0);
});

test('POST /api/governance/proposals/submit-signed finalizes with the prepare token contents, not client-supplied values', async () => {
  const { app, calls } = buildApp({ wallet: WALLET.freighter });

  const prepareRes = await request(app)
    .post('/api/governance/proposals')
    .send({ new_fee_bps: 300, new_creator_share_bps: 500, rationale_text: 'Reduce fees for creators' });

  const submitRes = await request(app)
    .post('/api/governance/proposals/submit-signed')
    .send({ prepare_token: prepareRes.body.prepare_token, signed_xdr: 'SIGNED_XDR' });

  assert.equal(submitRes.status, 201);
  assert.equal(calls.createProposalFromSignedXdr.length, 1);
  const submitted = calls.createProposalFromSignedXdr[0];
  assert.equal(submitted.proposerPublicKey, WALLET.freighter.wallet_public_key);
  assert.equal(submitted.newFeeBps, 300);
  assert.equal(submitted.signedXdr, 'SIGNED_XDR');
});

test('POST /api/governance/proposals/submit-signed rejects a cross-wallet or tampered signed_xdr (validator failure)', async () => {
  const { app } = buildApp({
    wallet: WALLET.freighter,
    sorobanImpl: {
      validateSubmittedContractCallXdr: () => {
        const err = new Error('Transaction source does not match the expected wallet');
        err.statusCode = 422;
        err.isValidationError = true;
        throw err;
      },
    },
  });

  const prepareRes = await request(app)
    .post('/api/governance/proposals')
    .send({ new_fee_bps: 300, new_creator_share_bps: 500, rationale_text: 'Reduce fees for creators' });

  const submitRes = await request(app)
    .post('/api/governance/proposals/submit-signed')
    .send({ prepare_token: prepareRes.body.prepare_token, signed_xdr: 'SIGNED_BY_SOMEONE_ELSE' });

  assert.equal(submitRes.status, 422);
  assert.match(submitRes.body.error, /does not match the expected wallet/);
});

test('POST /api/governance/proposals/submit-signed rejects a prepare token minted for a different action', async () => {
  const { app } = buildApp({ wallet: WALLET.freighter });

  const voteRes = await request(app)
    .post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/vote')
    .send({ in_favor: true });

  const submitRes = await request(app)
    .post('/api/governance/proposals/submit-signed')
    .send({ prepare_token: voteRes.body.prepare_token, signed_xdr: 'SIGNED_XDR' });

  assert.equal(submitRes.status, 422);
  assert.match(submitRes.body.error, /does not match this action/);
});

test('POST /api/governance/proposals/:id/vote (custodial) votes without any signer_secret in the request', async () => {
  const { app, calls } = buildApp({ wallet: WALLET.custodial });

  const res = await request(app)
    .post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/vote')
    .send({ in_favor: true });

  assert.equal(res.status, 200);
  assert.equal(calls.voteOnProposal.length, 1);
  const [proposalId, voterPublicKey, inFavor, signerSecret] = calls.voteOnProposal[0];
  assert.equal(proposalId, '11111111-1111-4111-8111-111111111111');
  assert.equal(voterPublicKey, WALLET.custodial.wallet_public_key);
  assert.equal(inFavor, true);
  assert.equal(signerSecret, 'SDECRYPTEDSECRET');
});

test('POST /api/governance/proposals/:id/vote/submit-signed finalizes a Freighter vote using the prepared values', async () => {
  const { app, calls } = buildApp({ wallet: WALLET.freighter });

  const prepareRes = await request(app)
    .post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/vote')
    .send({ in_favor: false });

  const submitRes = await request(app)
    .post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/vote/submit-signed')
    .send({ prepare_token: prepareRes.body.prepare_token, signed_xdr: 'SIGNED_VOTE_XDR' });

  assert.equal(submitRes.status, 200);
  assert.equal(calls.voteFromSignedXdr.length, 1);
  assert.equal(calls.voteFromSignedXdr[0].voterPublicKey, WALLET.freighter.wallet_public_key);
  assert.equal(calls.voteFromSignedXdr[0].inFavor, false);
});

test('POST /api/governance/proposals/:id/vote/submit-signed rejects a token prepared for a different proposal id', async () => {
  const { app } = buildApp({ wallet: WALLET.freighter });

  const prepareRes = await request(app)
    .post('/api/governance/proposals/22222222-2222-4222-8222-222222222222/vote')
    .send({ in_favor: true });

  const submitRes = await request(app)
    .post('/api/governance/proposals/33333333-3333-4333-8333-333333333333/vote/submit-signed')
    .send({ prepare_token: prepareRes.body.prepare_token, signed_xdr: 'SIGNED_VOTE_XDR' });

  assert.equal(submitRes.status, 422);
  assert.match(submitRes.body.error, /does not match this proposal/);
});

test('POST /api/governance/proposals/:id/execute always relays via the platform key, ignoring any client-supplied secret', async () => {
  const prevPlatformKey = process.env.PLATFORM_SECRET_KEY;
  process.env.PLATFORM_SECRET_KEY = 'SPLATFORMRELAYERSECRET';
  const { app, calls } = buildApp({ wallet: WALLET.custodial });

  const res = await request(app)
    .post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/execute')
    .send({ signer_secret: 'SATTACKERSUPPLIEDSECRET' });

  assert.equal(res.status, 200);
  assert.equal(calls.executeProposal.length, 1);
  const [proposalId, signerSecret] = calls.executeProposal[0];
  assert.equal(proposalId, '11111111-1111-4111-8111-111111111111');
  assert.equal(signerSecret, 'SPLATFORMRELAYERSECRET');
  process.env.PLATFORM_SECRET_KEY = prevPlatformKey;
});

test('POST /api/governance/proposals/:id/execute surfaces a deadline/status error as 400', async () => {
  const { app } = buildApp({
    wallet: WALLET.custodial,
    governanceImpl: {
      executeProposal: async () => {
        throw new Error('Proposal deadline has not passed yet');
      },
    },
  });

  const res = await request(app).post('/api/governance/proposals/11111111-1111-4111-8111-111111111111/execute').send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /deadline has not passed/);
});
