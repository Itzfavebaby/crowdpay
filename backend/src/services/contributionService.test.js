const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ sorobanImpl, stellarImpl, stellarTxImpl } = {}) {
  const depositCalls = [];
  const insertCalls = [];

  const sorobanStub = {
    depositToEscrow: async (args) => {
      depositCalls.push(args);
      return { txHash: 'contract-tx-hash', returnValue: null };
    },
    isContractDepositEligible: (campaign) => Boolean(campaign?.escrow_contract_id),
    ...sorobanImpl,
  };

  const stellarStub = {
    prepareSignedContributionPayment: async () => ({ unsignedXdr: 'u-xdr', signedXdr: 's-xdr' }),
    prepareSignedContributionPathPayment: async () => ({ unsignedXdr: 'u-xdr', signedXdr: 's-xdr' }),
    submitPreparedTransaction: async () => 'classic-tx-hash',
    getPathPaymentQuote: async () => [],
    ensureCustodialAccountFundedAndTrusted: async () => null,
    ...stellarImpl,
  };

  const stellarTxStub = {
    insertContributionPending: async (_client, row) => {
      insertCalls.push(row);
      return { id: 'stellar-row-id', reused: false };
    },
    markContributionSubmitted: async () => {},
    markContributionFailed: async () => {},
    ...stellarTxImpl,
  };

  const service = proxyquire('./contributionService', {
    './stellarService': stellarStub,
    './sorobanService': sorobanStub,
    './walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SDECRYPTEDSECRET'),
    },
    './stellarTransactionService': stellarTxStub,
    '../config/constants': { SLIPPAGE_BPS: 500, STELLAR_ASSET_DECIMALS_SCALE: 10_000_000 },
  });

  return { service, depositCalls, insertCalls };
}

const CONTRACT_CAMPAIGN = {
  asset_type: 'USDC',
  wallet_public_key: 'GCAMPAIGNWALLET',
  escrow_contract_id: 'CESCROWCONTRACT',
};

const CLASSIC_CAMPAIGN = {
  asset_type: 'USDC',
  wallet_public_key: 'GCAMPAIGNWALLET',
  escrow_contract_id: null,
};

test('submitCustodialContribution deposits directly into the escrow contract for a contract-mode, same-asset campaign', async () => {
  const { service, depositCalls, insertCalls } = buildService();

  const result = await service.submitCustodialContribution({
    campaign: CONTRACT_CAMPAIGN,
    campaignId: 'camp-1',
    userId: 'user-1',
    walletPublicKey: 'GCONTRIBUTOR',
    walletSecretEncrypted: 'ENCRYPTED',
    amount: '10.0000000',
    sendAsset: 'USDC',
    client: {},
  });

  assert.equal(depositCalls.length, 1);
  assert.equal(depositCalls[0].contractId, 'CESCROWCONTRACT');
  assert.equal(depositCalls[0].fromAddress, 'GCONTRIBUTOR');
  assert.equal(depositCalls[0].amount, 100_000_000); // 10 * 10^7
  assert.equal(depositCalls[0].signerSecret, 'SDECRYPTEDSECRET');

  assert.equal(result.txHash, 'contract-tx-hash');
  assert.equal(result.contractMode, true);
  assert.equal(result.unsignedXdr, null);
  assert.equal(result.signedXdr, null);
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].metadata.contract_mode, true);
});

test('submitCustodialContribution rejects a cross-asset contribution to a contract-mode campaign', async () => {
  const { service, depositCalls } = buildService();

  await assert.rejects(
    () =>
      service.submitCustodialContribution({
        campaign: CONTRACT_CAMPAIGN,
        campaignId: 'camp-1',
        userId: 'user-1',
        walletPublicKey: 'GCONTRIBUTOR',
        walletSecretEncrypted: 'ENCRYPTED',
        amount: '10.0000000',
        sendAsset: 'XLM',
        client: {},
      }),
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /cross-asset/i);
      return true;
    }
  );
  assert.equal(depositCalls.length, 0);
});

test('submitCustodialContribution falls back to a classic payment when the campaign is not contract-mode eligible', async () => {
  const { service, depositCalls } = buildService();

  const result = await service.submitCustodialContribution({
    campaign: CLASSIC_CAMPAIGN,
    campaignId: 'camp-1',
    userId: 'user-1',
    walletPublicKey: 'GCONTRIBUTOR',
    walletSecretEncrypted: 'ENCRYPTED',
    amount: '10.0000000',
    sendAsset: 'USDC',
    client: {},
  });

  assert.equal(depositCalls.length, 0);
  assert.equal(result.txHash, 'classic-tx-hash');
  assert.equal(result.contractMode, false);
  assert.equal(result.unsignedXdr, 'u-xdr');
  assert.equal(result.signedXdr, 's-xdr');
});
