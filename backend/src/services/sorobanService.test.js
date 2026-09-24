'use strict';

/**
 * Soroban service unit tests — run with node:test (no DB or testnet required).
 *
 * Covers both the manual mock at services/__mocks__/sorobanService.js
 * and all real functions in services/sorobanService.js using proxyquire.
 *
 * Run:
 *   NODE_ENV=test node --test src/services/sorobanService.test.js
 */

const { describe, it, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair, xdr, nativeToScVal, StrKey, Account } = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// 1. Tests for the manual mock at services/__mocks__/sorobanService.js
// ---------------------------------------------------------------------------
const sorobanMock = require('./__mocks__/sorobanService');
const { __mock } = sorobanMock;

describe('encodeMilestone (manual mock)', () => {
  it('encodes a valid milestone without throwing', () => {
    const result = sorobanMock.encodeMilestone({
      title: 'Pump procurement',
      release_percentage_units: 4000,
    });
    assert.ok(result !== null && result !== undefined, 'result should not be null');
    assert.equal(typeof result, 'object', 'result should be an object');
  });

  it('throws when title is missing', () => {
    assert.throws(
      () => sorobanMock.encodeMilestone({ release_percentage_units: 5000 }),
      /title is required/i
    );
  });

  it('throws when milestone argument is falsy', () => {
    assert.throws(
      () => sorobanMock.encodeMilestone(null),
      /title is required/i
    );
  });

  it('encodes a 100% single-milestone campaign (10000 bps)', () => {
    assert.doesNotThrow(() =>
      sorobanMock.encodeMilestone({
        title: 'Full release',
        release_percentage_units: 10000,
      })
    );
  });
});

describe('invokeContract (manual mock)', () => {
  beforeEach(() => {
    __mock.reset();
    __mock.clearCalls();
  });

  it('resolves with the configured return value', async () => {
    __mock.setReturnValue(BigInt(42));
    const result = await sorobanMock.invokeContract({
      contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
      method: 'get_balance',
      args: [],
      signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
    });
    assert.equal(result, BigInt(42));
  });

  it('records each call for inspection', async () => {
    await sorobanMock.invokeContract({
      contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
      method: 'register_campaign',
      args: [{ id: 'camp-1', milestones: [] }],
      signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
    });
    const calls = __mock.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'register_campaign');
  });

  it('throws when simulateFailure is enabled', async () => {
    __mock.simulateFailure(true);
    await assert.rejects(
      () => sorobanMock.invokeContract({
        contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
        method: 'release_funds',
        args: [],
        signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
      }),
      /simulated soroban contract failure/i
    );
  });

  it('throws when contractId is missing', async () => {
    await assert.rejects(
      () => sorobanMock.invokeContract({
        contractId: '',
        method: 'register_campaign',
        args: [],
        signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
      }),
      /contractId is required/i
    );
  });

  it('throws when method is missing', async () => {
    await assert.rejects(
      () => sorobanMock.invokeContract({
        contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
        method: '',
        args: [],
        signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
      }),
      /method is required/i
    );
  });

  it('throws when signerSecret is missing', async () => {
    await assert.rejects(
      () => sorobanMock.invokeContract({
        contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
        method: 'release_funds',
        args: [],
        signerSecret: '',
      }),
      /signerSecret is required/i
    );
  });

  it('reset clears call history', async () => {
    await sorobanMock.invokeContract({
      contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
      method: 'noop',
      args: [],
      signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
    });
    assert.equal(__mock.getCalls().length, 1);

    __mock.clearCalls();
    assert.equal(__mock.getCalls().length, 0);
  });

  it('reset restores return value to BigInt(0)', async () => {
    __mock.setReturnValue(BigInt(999));
    __mock.reset();

    const result = await sorobanMock.invokeContract({
      contractId: 'CCONTRACT123456789012345678901234567890123456789012345',
      method: 'noop',
      args: [],
      signerSecret: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
    });
    assert.equal(result, BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// 2. Tests for real sorobanService.js using proxyquire
// ---------------------------------------------------------------------------

const testKeypair = Keypair.random();
const TEST_SECRET = testKeypair.secret();
const TEST_PUBLIC = testKeypair.publicKey();
const TEST_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const TEST_WASM_HASH = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function createMockMetaXdr(returnValue) {
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: xdr.SorobanTransactionMetaExt.fromXDR(Buffer.from([0, 0, 0, 0])),
    events: [],
    returnValue: returnValue || xdr.ScVal.scvVoid(),
    diagnosticEvents: [],
  });

  const v3 = new xdr.TransactionMetaV3({
    ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
  });
  const meta = new xdr.TransactionMeta(3, v3);
  return meta.toXDR('base64');
}

function buildService(serverOverrides = {}) {
  const defaultServer = {
    loadAccount: async (pk) => new Account(pk || TEST_PUBLIC, '1'),
    simulateTransaction: async () => ({ result: null }),
    prepareTransaction: (tx) => tx,
    submitTransaction: async () => ({ status: 'SUCCESS' }),
  };

  const server = { ...defaultServer, ...serverOverrides };

  return proxyquire('./sorobanService', {
    '../config/stellar': {
      server,
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {} },
    '../config/constants': { TX_TIMEOUT_CONTRIBUTION_S: 30 },
  });
}

describe('sorobanService real implementation tests', () => {
  // Helper & Status Mapping tests
  test('scvAddressFromString encodes a valid address', () => {
    const service = buildService();
    const scv = service.scvAddressFromString(TEST_PUBLIC);
    assert.ok(scv);
    assert.equal(typeof scv, 'object');
  });

  test('encodeMilestone computes title hash and release_bps correctly', () => {
    const service = buildService();

    const m1 = service.encodeMilestone({ title: 'M1', release_percentage_units: 3000 });
    assert.ok(m1);

    const m2 = service.encodeMilestone({ title: 'M2', release_percentage: '25.5' });
    assert.ok(m2);

    const m3 = service.encodeMilestone({ title: 'M3' });
    assert.ok(m3);
  });

  test('mapMilestoneOnChainStatus maps numeric and object statuses', () => {
    const { mapMilestoneOnChainStatus } = buildService();
    assert.equal(mapMilestoneOnChainStatus(0), 'pending');
    assert.equal(mapMilestoneOnChainStatus(1), 'submitted');
    assert.equal(mapMilestoneOnChainStatus(2), 'released');
    assert.equal(mapMilestoneOnChainStatus(3), 'rejected');
    assert.equal(mapMilestoneOnChainStatus(99), 'pending');

    assert.equal(mapMilestoneOnChainStatus({ tag: 'Approved' }), 'released');
    assert.equal(mapMilestoneOnChainStatus({ tag: 'Submitted' }), 'submitted');
    assert.equal(mapMilestoneOnChainStatus({ tag: 'Rejected' }), 'rejected');
    assert.equal(mapMilestoneOnChainStatus({ tag: 'Other' }), 'pending');
  });

  // invokeContract & invokeContractReadOnly tests
  describe('invokeContract & invokeContractReadOnly error propagation', () => {
    test('invokeContract throws on non-SUCCESS status', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'FAILED' }),
      });

      await assert.rejects(
        () => service.invokeContract({
          contractId: TEST_CONTRACT_ID,
          method: 'test_method',
          args: [],
          signerSecret: TEST_SECRET,
        }),
        /Transaction failed: FAILED/
      );
    });

    test('invokeContract throws on simulateAndPrepare error (scvError)', async () => {
      const errorScVal = xdr.ScVal.scvError(xdr.ScError.sceContract(1));
      const metaBase64 = createMockMetaXdr(errorScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      await assert.rejects(
        () => service.invokeContract({
          contractId: TEST_CONTRACT_ID,
          method: 'test_method',
          args: [],
          signerSecret: TEST_SECRET,
        }),
        /Simulation failed/
      );
    });

    test('invokeContract returns scValToNative result when resultMetaXdr present', async () => {
      const returnScVal = nativeToScVal(12345);
      const metaBase64 = createMockMetaXdr(returnScVal);

      const service = buildService({
        submitTransaction: async () => ({
          status: 'SUCCESS',
          resultMetaXdr: metaBase64,
        }),
      });

      const res = await service.invokeContract({
        contractId: TEST_CONTRACT_ID,
        method: 'test_method',
        args: [],
        signerSecret: TEST_SECRET,
      });

      assert.equal(res, BigInt(12345));
    });

    test('invokeContractReadOnly throws when simulation errors out', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;
      const service = buildService({
        simulateTransaction: async () => ({
          error: 'Simulation error',
        }),
      });

      await assert.rejects(
        () => service.invokeContractReadOnly({
          contractId: TEST_CONTRACT_ID,
          method: 'get_something',
          args: [],
        }),
        /Simulation failed/
      );
    });

    test('invokeContractReadOnly returns value on successful simulation', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;
      const returnScVal = nativeToScVal('hello_world');
      const metaBase64 = createMockMetaXdr(returnScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      const res = await service.invokeContractReadOnly({
        contractId: TEST_CONTRACT_ID,
        method: 'get_something',
        args: [],
      });

      assert.equal(res, 'hello_world');
    });

    test('invokeContractReadOnly throws on scvError in simulation', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;
      const errorScVal = xdr.ScVal.scvError(xdr.ScError.sceContract(5));
      const metaBase64 = createMockMetaXdr(errorScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      await assert.rejects(
        () => service.invokeContractReadOnly({
          contractId: TEST_CONTRACT_ID,
          method: 'get_something',
          args: [],
        }),
        /Simulation returned error/
      );
    });
  });

  // Action wrapper functions
  describe('Service contract call wrappers', () => {
    test('initializeEscrow invokes contract with correct method', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      const res = await service.initializeEscrow({
        contractId: TEST_CONTRACT_ID,
        adminAddress: TEST_PUBLIC,
        campaignId: 101,
        target: 5000,
        deadline: 1700000000,
        assetContractAddress: TEST_CONTRACT_ID,
        platformFeeBps: 250,
        platformFeeRecipientAddress: TEST_PUBLIC,
        signerSecret: TEST_SECRET,
      });

      assert.equal(res, null);
    });

    test('initializeMilestones formats milestones and invokes contract', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      const res = await service.initializeMilestones({
        contractId: TEST_CONTRACT_ID,
        creatorAddress: TEST_PUBLIC,
        platformAddress: TEST_PUBLIC,
        escrowContractId: TEST_CONTRACT_ID,
        milestones: [{ title: 'M1', release_percentage_units: 5000 }],
        signerSecret: TEST_SECRET,
      });

      assert.equal(res, null);
    });

    test('depositToEscrow invokes contract with deposit method and returns the tx hash', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      const res = await service.depositToEscrow({
        contractId: TEST_CONTRACT_ID,
        fromAddress: TEST_PUBLIC,
        amount: 1000,
        signerSecret: TEST_SECRET,
      });

      assert.equal(res.returnValue, null);
      assert.equal(typeof res.txHash, 'string');
      assert.equal(res.txHash.length, 64);
    });

    test('depositToEscrow surfaces a distinct tx hash per call (derived from the signed envelope)', async () => {
      const service = buildService({
        loadAccount: async (pk) => new Account(pk || TEST_PUBLIC, '1'),
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      const res1 = await service.depositToEscrow({
        contractId: TEST_CONTRACT_ID,
        fromAddress: TEST_PUBLIC,
        amount: 1000,
        signerSecret: TEST_SECRET,
      });
      const res2 = await service.depositToEscrow({
        contractId: TEST_CONTRACT_ID,
        fromAddress: TEST_PUBLIC,
        amount: 2000,
        signerSecret: TEST_SECRET,
      });

      assert.notEqual(res1.txHash, res2.txHash);
    });

    test('buildUnsignedEscrowDeposit returns unsigned prepared XDR without a signerSecret', async () => {
      const service = buildService();

      const xdrString = await service.buildUnsignedEscrowDeposit({
        contractId: TEST_CONTRACT_ID,
        fromAddress: TEST_PUBLIC,
        amount: 1000,
      });

      assert.equal(typeof xdrString, 'string');
      assert.ok(xdrString.length > 0);
    });

    test('buildUnsignedContractCall builds an unsigned XDR for an arbitrary method without a signerSecret', async () => {
      const service = buildService();

      const xdrString = await service.buildUnsignedContractCall({
        contractId: TEST_CONTRACT_ID,
        method: 'propose_change',
        args: [],
        sourcePublicKey: TEST_PUBLIC,
      });

      assert.equal(typeof xdrString, 'string');
      assert.ok(xdrString.length > 0);
    });

    test('submitSignedContractCall submits an already-signed transaction and decodes its return value', async () => {
      const returnScVal = nativeToScVal(7);
      const metaBase64 = createMockMetaXdr(returnScVal);
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS', hash: 'submitted-hash', resultMetaXdr: metaBase64 }),
      });

      const unsignedXdr = await service.buildUnsignedContractCall({
        contractId: TEST_CONTRACT_ID,
        method: 'vote',
        args: [],
        sourcePublicKey: TEST_PUBLIC,
      });
      const { TransactionBuilder } = require('@stellar/stellar-sdk');
      const tx = TransactionBuilder.fromXDR(unsignedXdr, 'Test SDF Network ; September 2015');
      tx.sign(testKeypair);

      const result = await service.submitSignedContractCall(tx.toXDR());
      assert.equal(result.hash, 'submitted-hash');
      assert.equal(result.returnValue, BigInt(7));
    });

    test('submitSignedContractCall throws on a non-SUCCESS submission status', async () => {
      const service = buildService({ submitTransaction: async () => ({ status: 'FAILED' }) });
      const unsignedXdr = await service.buildUnsignedContractCall({
        contractId: TEST_CONTRACT_ID,
        method: 'vote',
        args: [],
        sourcePublicKey: TEST_PUBLIC,
      });
      const { TransactionBuilder } = require('@stellar/stellar-sdk');
      const tx = TransactionBuilder.fromXDR(unsignedXdr, 'Test SDF Network ; September 2015');
      tx.sign(testKeypair);

      await assert.rejects(() => service.submitSignedContractCall(tx.toXDR()), /Transaction failed: FAILED/);
    });

    describe('validateSubmittedContractCallXdr (#802 — cross-wallet and tampered-args rejection)', () => {
      async function buildSignedAndUnsigned(service, { method = 'vote', args = [], signer = testKeypair, sourcePublicKey = TEST_PUBLIC } = {}) {
        const unsignedXdr = await service.buildUnsignedContractCall({
          contractId: TEST_CONTRACT_ID,
          method,
          args,
          sourcePublicKey,
        });
        const { TransactionBuilder } = require('@stellar/stellar-sdk');
        const tx = TransactionBuilder.fromXDR(unsignedXdr, 'Test SDF Network ; September 2015');
        tx.sign(signer);
        return { unsignedXdr, signedXdr: tx.toXDR() };
      }

      test('accepts a signed transaction that matches the unsigned XDR and is signed by the expected wallet', async () => {
        const service = buildService();
        const { unsignedXdr, signedXdr } = await buildSignedAndUnsigned(service);

        assert.equal(
          service.validateSubmittedContractCallXdr({
            signedXdr,
            unsignedXdr,
            expectedSourcePublicKey: TEST_PUBLIC,
          }),
          true,
        );
      });

      test('rejects a transaction signed by a different wallet than expected (cross-wallet signature)', async () => {
        const service = buildService();
        const attacker = Keypair.random();
        // Attacker's own account is the tx source, but we claim the victim's key is expected.
        const { unsignedXdr, signedXdr } = await buildSignedAndUnsigned(service, {
          signer: attacker,
          sourcePublicKey: attacker.publicKey(),
        });

        assert.throws(
          () => service.validateSubmittedContractCallXdr({
            signedXdr,
            unsignedXdr,
            expectedSourcePublicKey: TEST_PUBLIC,
          }),
          /does not match the expected wallet/,
        );
      });

      test('rejects a signed transaction whose operation args were tampered with after preparing', async () => {
        const service = buildService();
        const { unsignedXdr } = await buildSignedAndUnsigned(service, { args: [nativeToScVal(false, { type: 'bool' })] });
        // Build a DIFFERENT transaction (different args) but present it as satisfying the same prepare token.
        const { signedXdr: tamperedSignedXdr } = await buildSignedAndUnsigned(service, { args: [nativeToScVal(true, { type: 'bool' })] });

        assert.throws(
          () => service.validateSubmittedContractCallXdr({
            signedXdr: tamperedSignedXdr,
            unsignedXdr,
            expectedSourcePublicKey: TEST_PUBLIC,
          }),
          /does not match the server-generated transaction/,
        );
      });

      test('rejects when signed_xdr or unsigned_xdr is missing', () => {
        const service = buildService();
        assert.throws(
          () => service.validateSubmittedContractCallXdr({ signedXdr: null, unsignedXdr: 'x', expectedSourcePublicKey: TEST_PUBLIC }),
          /signed_xdr is required/,
        );
        assert.throws(
          () => service.validateSubmittedContractCallXdr({ signedXdr: 'x', unsignedXdr: null, expectedSourcePublicKey: TEST_PUBLIC }),
          /unsigned_xdr is required/,
        );
      });
    });

    test('isContractDepositEligible requires SOROBAN_ENABLED=true and an escrow_contract_id', () => {
      const service = buildService();
      const prevEnabled = process.env.SOROBAN_ENABLED;

      process.env.SOROBAN_ENABLED = 'true';
      assert.equal(
        service.isContractDepositEligible({ escrow_contract_id: TEST_CONTRACT_ID }),
        true,
      );
      assert.equal(service.isContractDepositEligible({ escrow_contract_id: null }), false);

      process.env.SOROBAN_ENABLED = 'false';
      assert.equal(
        service.isContractDepositEligible({ escrow_contract_id: TEST_CONTRACT_ID }),
        false,
      );

      if (prevEnabled === undefined) delete process.env.SOROBAN_ENABLED;
      else process.env.SOROBAN_ENABLED = prevEnabled;
    });

    test('requestRefund & refund invoke contract with refund method', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      await service.requestRefund({
        contractId: TEST_CONTRACT_ID,
        contributorAddress: TEST_PUBLIC,
        signerSecret: TEST_SECRET,
      });

      await service.refund(TEST_CONTRACT_ID, TEST_PUBLIC);
    });

    test('submitMilestone, approveMilestone, rejectMilestone invoke contract methods', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      await service.submitMilestone({
        contractId: TEST_CONTRACT_ID,
        creatorAddress: TEST_PUBLIC,
        title: 'Phase 1',
        releaseBps: 5000,
        signerSecret: TEST_SECRET,
      });

      await service.approveMilestone({
        contractId: TEST_CONTRACT_ID,
        milestoneIndex: 0,
        signerSecret: TEST_SECRET,
      });

      await service.rejectMilestone({
        contractId: TEST_CONTRACT_ID,
        milestoneIndex: 0,
        signerSecret: TEST_SECRET,
      });
    });

    test('read-only getters', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;

      const returnScVal = nativeToScVal(500);
      const metaBase64 = createMockMetaXdr(returnScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      assert.equal(await service.getEscrowTotalRaised(TEST_CONTRACT_ID), BigInt(500));
      assert.equal(await service.getEscrowAsset(TEST_CONTRACT_ID), BigInt(500));
      assert.equal(await service.getEscrowPlatformFeeConfig(TEST_CONTRACT_ID), BigInt(500));
      assert.equal(await service.getMilestone(TEST_CONTRACT_ID, 0), BigInt(500));
      assert.equal(await service.getAllMilestones(TEST_CONTRACT_ID), BigInt(500));
    });
  });


const proxyquire = require('proxyquire').noCallThru();

  // WASM upload & contract creation tests
  describe('createContractFromWasmHash & uploadContractWasm', () => {
    test('createContractFromWasmHash throws when submit fails', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'FAILED' }),
      });

      await assert.rejects(
        () => service.createContractFromWasmHash({
          wasmHash: TEST_WASM_HASH,
          signerSecret: TEST_SECRET,
        }),
        /Contract creation failed: FAILED/
      );
    });

    test('createContractFromWasmHash parses created contract ID on success', async () => {
      const metaBase64 = createMockMetaXdr(xdr.ScVal.scvVoid());

      const service = buildService({
        submitTransaction: async () => ({
          status: 'SUCCESS',
          hash: 'txhash123',
          resultMetaXdr: metaBase64,
        }),
      });

      const res = await service.createContractFromWasmHash({
        wasmHash: TEST_WASM_HASH,
        signerSecret: TEST_SECRET,
      });

      assert.ok(res.contractId);
      assert.equal(res.txHash, 'txhash123');
    });

    test('uploadContractWasm throws when submit fails', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'FAILED' }),
      });

      await assert.rejects(
        () => service.uploadContractWasm(Buffer.from('0061736d01000000', 'hex'), TEST_SECRET),
        /WASM upload failed: FAILED/
      );
    });

    test('uploadContractWasm parses return value on success', async () => {
      const returnScVal = nativeToScVal('wasm_hash_result');
      const metaBase64 = createMockMetaXdr(returnScVal);

      const service = buildService({
        submitTransaction: async () => ({
          status: 'SUCCESS',
          resultMetaXdr: metaBase64,
        }),
      });

      const res = await service.uploadContractWasm(Buffer.from('0061736d01000000', 'hex'), TEST_SECRET);
      assert.equal(res, 'wasm_hash_result');
    });
  });

  // Contract deployment & high-level initialization tests
  describe('deployCampaignContracts & initializeCampaignContract', () => {
    test('deployCampaignContracts uses pre-deployed contract IDs from env if set', async () => {
      process.env.ESCROW_CONTRACT_ID = TEST_CONTRACT_ID;
      process.env.MILESTONES_CONTRACT_ID = TEST_CONTRACT_ID;

      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      const result = await service.deployCampaignContracts({
        creatorPublicKey: TEST_PUBLIC,
        platformPublicKey: TEST_PUBLIC,
        campaignId: '1001',
        targetAmount: 1000,
        deadlineUnix: 1800000000,
        assetContractAddress: TEST_CONTRACT_ID,
        platformFeeBps: 200,
        milestones: [{ title: 'M1', release_percentage_units: 5000 }],
        signerSecret: TEST_SECRET,
      });

      assert.equal(result.escrowContractId, TEST_CONTRACT_ID);
      assert.equal(result.milestonesContractId, TEST_CONTRACT_ID);

      delete process.env.ESCROW_CONTRACT_ID;
      delete process.env.MILESTONES_CONTRACT_ID;
    });

    test('deployCampaignContracts returns mock contract IDs if SOROBAN_ENABLED is false', async () => {
      delete process.env.ESCROW_CONTRACT_ID;
      delete process.env.MILESTONES_CONTRACT_ID;
      process.env.SOROBAN_ENABLED = 'false';

      const service = buildService();
      const result = await service.deployCampaignContracts({
        creatorPublicKey: TEST_PUBLIC,
        platformPublicKey: TEST_PUBLIC,
        campaignId: '1001',
        targetAmount: 1000,
        deadlineUnix: 1800000000,
        assetContractAddress: TEST_CONTRACT_ID,
        platformFeeBps: 200,
        milestones: [],
        signerSecret: TEST_SECRET,
      });

      assert.ok(result.escrowContractId.startsWith('C'));
      assert.ok(result.milestonesContractId.startsWith('C'));
    });

    test('deployCampaignContracts throws wrapped error on deployment failure', async () => {
      delete process.env.ESCROW_CONTRACT_ID;
      delete process.env.MILESTONES_CONTRACT_ID;
      process.env.SOROBAN_ENABLED = 'true';
      process.env.ESCOW_WASM_HASH = TEST_WASM_HASH;
      process.env.ESCROW_WASM_HASH = TEST_WASM_HASH;
      process.env.MILESTONES_WASM_HASH = TEST_WASM_HASH;

      const service = buildService({
        submitTransaction: async () => ({ status: 'FAILED' }),
      });

      await assert.rejects(
        () => service.deployCampaignContracts({
          creatorPublicKey: TEST_PUBLIC,
          platformPublicKey: TEST_PUBLIC,
          campaignId: '1001',
          targetAmount: 1000,
          deadlineUnix: 1800000000,
          assetContractAddress: TEST_CONTRACT_ID,
          platformFeeBps: 200,
          milestones: [],
          signerSecret: TEST_SECRET,
        }),
        /Soroban contract deployment failed/
      );

      delete process.env.SOROBAN_ENABLED;
      delete process.env.ESCOW_WASM_HASH;
      delete process.env.ESCROW_WASM_HASH;
      delete process.env.MILESTONES_WASM_HASH;
    });

    test('initializeCampaignContract returns escrow & milestone contract addresses', async () => {
      process.env.SOROBAN_ENABLED = 'false';
      const service = buildService();

      const res = await service.initializeCampaignContract({
        campaignId: '1001',
        creator: TEST_PUBLIC,
        goal: 5000,
        deadline: 1800000000,
        milestones: [],
        platformPublicKey: TEST_PUBLIC,
        assetContractAddress: TEST_CONTRACT_ID,
        platformFeeBps: 100,
        signerSecret: TEST_SECRET,
      });

      assert.ok(res.contractAddress);
      assert.ok(res.escrowContractId);
      assert.ok(res.milestonesContractId);
    });

    test('releaseMilestone & triggerRefund handle success and errors', async () => {
      const service = buildService({
        submitTransaction: async () => ({ status: 'SUCCESS' }),
      });

      // Success
      await service.releaseMilestone({
        milestonesContractId: TEST_CONTRACT_ID,
        milestoneIndex: 0,
        signerSecret: TEST_SECRET,
      });

      await service.triggerRefund({
        escrowContractId: TEST_CONTRACT_ID,
        contributorAddress: TEST_PUBLIC,
        signerSecret: TEST_SECRET,
      });

      // Error when submit fails
      const failingService = buildService({
        submitTransaction: async () => ({ status: 'FAILED' }),
      });

      await assert.rejects(
        () => failingService.releaseMilestone({
          milestonesContractId: TEST_CONTRACT_ID,
          milestoneIndex: 0,
          signerSecret: TEST_SECRET,
        }),
        /On-chain milestone release failed/
      );

      await assert.rejects(
        () => failingService.triggerRefund({
          escrowContractId: TEST_CONTRACT_ID,
          contributorAddress: TEST_PUBLIC,
          signerSecret: TEST_SECRET,
        }),
        /On-chain refund failed/
      );
    });
  });

  // getContractStatus tests
  describe('getContractStatus', () => {
    test('returns unknown status when contract IDs are missing', async () => {
      const service = buildService();
      const status = await service.getContractStatus({
        escrowContractId: null,
        milestonesContractId: null,
      });

      assert.deepEqual(status, {
        status: 'unknown',
        totalRaised: 0,
        milestones: [],
      });
    });

    test('returns funded status when totalRaised >= target', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;

      const totalRaisedScVal = nativeToScVal(1000);
      const metaBase64 = createMockMetaXdr(totalRaisedScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      const res = await service.getContractStatus({
        escrowContractId: TEST_CONTRACT_ID,
        targetAmount: 1000,
        deadlineUnix: Math.floor(Date.now() / 1000) + 1000,
      });

      assert.equal(res.status, 'funded');
      assert.equal(res.totalRaised, 1000);
    });

    test('returns active status when totalRaised < target and before deadline', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;

      const totalRaisedScVal = nativeToScVal(500);
      const metaBase64 = createMockMetaXdr(totalRaisedScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      const res = await service.getContractStatus({
        escrowContractId: TEST_CONTRACT_ID,
        targetAmount: 1000,
        deadlineUnix: Math.floor(Date.now() / 1000) + 1000,
      });

      assert.equal(res.status, 'active');
      assert.equal(res.totalRaised, 500);
    });

    test('returns failed status when totalRaised < target and past deadline', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;

      const totalRaisedScVal = nativeToScVal(500);
      const metaBase64 = createMockMetaXdr(totalRaisedScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      const res = await service.getContractStatus({
        escrowContractId: TEST_CONTRACT_ID,
        targetAmount: 1000,
        deadlineUnix: Math.floor(Date.now() / 1000) - 1000, // past deadline
      });

      assert.equal(res.status, 'failed');
      assert.equal(res.totalRaised, 500);
    });

    test('parses and maps milestones status array when milestonesContractId provided', async () => {
      process.env.PLATFORM_SECRET_KEY = TEST_SECRET;

      const milestonesScVal = nativeToScVal([
        { status: 0 },
        { status: 2 },
      ]);
      const metaBase64 = createMockMetaXdr(milestonesScVal);

      const service = buildService({
        simulateTransaction: async () => ({
          result: { meta: metaBase64 },
        }),
      });

      const res = await service.getContractStatus({
        milestonesContractId: TEST_CONTRACT_ID,
      });

      assert.equal(res.milestones.length, 2);
      assert.equal(res.milestones[0].on_chain_status, 'pending');
      assert.equal(res.milestones[0].released, false);
      assert.equal(res.milestones[1].on_chain_status, 'released');
      assert.equal(res.milestones[1].released, true);
    });
  });
});
