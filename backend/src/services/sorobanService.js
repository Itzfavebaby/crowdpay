const {
  Contract,
  Address,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  Operation,
} = require('@stellar/stellar-sdk');
const { server, networkPassphrase } = require('../config/stellar');
const logger = require('../config/logger');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');
const crypto = require('crypto');

async function simulateAndPrepare(tx) {
  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue()) {
      const isError = typeof sorobanMeta.returnValue().type === 'function'
        ? sorobanMeta.returnValue().type() === xdr.ScValType.scvError
        : sorobanMeta.returnValue().switch?.()?.name === 'scvError';
      if (isError) {
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.result)}`);
      }
    }
  }
  return server.prepareTransaction(tx);
}

/**
 * Signs and submits a contract invocation, returning both the transaction
 * hash and the decoded return value. `invokeContract` (below) wraps this for
 * existing callers that only care about the return value.
 */
async function invokeContractRaw({ contractId, method, args, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const hash = preparedTx.hash().toString('hex');
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    let returnValue = null;
    if (result.resultMetaXdr) {
      const resultMetaXdrParsed = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const sorobanMeta = resultMetaXdrParsed.v3().sorobanMeta();
      if (sorobanMeta && sorobanMeta.returnValue()) {
        returnValue = scValToNative(sorobanMeta.returnValue());
      }
    }
    return { hash: result.hash || hash, returnValue };
  }
  throw new Error(`Transaction failed: ${result.status}`);
}

async function invokeContract({ contractId, method, args, signerSecret }) {
  const { returnValue } = await invokeContractRaw({ contractId, method, args, signerSecret });
  return returnValue;
}

/**
 * Builds an unsigned, simulation-prepared invocation of an arbitrary contract
 * method for the self-custody (Freighter) flow, where the server doesn't hold
 * the caller's key and must hand back XDR for the client to sign. Generic
 * counterpart to `buildUnsignedEscrowDeposit` (parameterized method/args
 * instead of a hardcoded `deposit` call).
 */
async function buildUnsignedContractCall({ contractId, method, args, sourcePublicKey }) {
  const source = await server.loadAccount(sourcePublicKey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  return preparedTx.toXDR();
}

/**
 * Submits an already-signed contract-invocation transaction (built earlier by
 * `buildUnsignedContractCall` and signed client-side), returning the tx hash
 * and decoded return value. Mirrors `invokeContractRaw`'s submit/decode tail
 * without the sign step, since the caller already holds a valid signature.
 */
async function submitSignedContractCall(signedXdr) {
  const preparedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    let returnValue = null;
    if (result.resultMetaXdr) {
      const resultMetaXdrParsed = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const sorobanMeta = resultMetaXdrParsed.v3().sorobanMeta();
      if (sorobanMeta && sorobanMeta.returnValue()) {
        returnValue = scValToNative(sorobanMeta.returnValue());
      }
    }
    return { hash: result.hash, returnValue };
  }
  throw new Error(`Transaction failed: ${result.status}`);
}

class ContractCallValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractCallValidationError';
    this.statusCode = 422;
    this.isValidationError = true;
  }
}

/**
 * Validates that a client-signed contract-call transaction matches the
 * server-generated unsigned XDR byte-for-byte (so its contract/method/args
 * can't have been tampered with) and is signed by the expected account (so a
 * signature from a different wallet can't be substituted). Mirrors
 * `validateSubmittedWithdrawalXdr` in stellarService.js, generalized from a
 * classic `payment` operation to a single Soroban `invokeHostFunction` op.
 */
function validateSubmittedContractCallXdr({ signedXdr, unsignedXdr, expectedSourcePublicKey }) {
  if (!signedXdr) {
    throw new ContractCallValidationError('signed_xdr is required');
  }
  if (!unsignedXdr) {
    throw new ContractCallValidationError('Server-generated unsigned_xdr is required to verify this action');
  }

  let signedTx;
  try {
    signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new ContractCallValidationError('Invalid signed_xdr');
  }

  let unsignedTx;
  try {
    unsignedTx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  } catch {
    throw new ContractCallValidationError('Invalid server-generated unsigned_xdr');
  }

  // The transaction hash covers the whole envelope body (source, sequence,
  // operations, memo, time bounds) but not the signatures, so a match here
  // proves the contract/method/args are exactly what the server prepared.
  if (signedTx.hash().toString('hex') !== unsignedTx.hash().toString('hex')) {
    throw new ContractCallValidationError('Signed transaction does not match the server-generated transaction');
  }

  if (signedTx.source !== expectedSourcePublicKey) {
    throw new ContractCallValidationError('Transaction source does not match the expected wallet');
  }

  if (!signedTx.operations || signedTx.operations.length !== 1 || signedTx.operations[0].type !== 'invokeHostFunction') {
    throw new ContractCallValidationError('Transaction must contain exactly one contract invocation');
  }

  if (!signedTx.signatures || signedTx.signatures.length === 0) {
    throw new ContractCallValidationError('Signed transaction does not include any signatures');
  }

  let signer;
  try {
    signer = Keypair.fromPublicKey(expectedSourcePublicKey);
  } catch {
    throw new ContractCallValidationError('Invalid expected source public key');
  }
  const signatureValid = signedTx.signatures.some((decorated) => {
    try {
      return signer.verify(signedTx.hash(), decorated.signature());
    } catch {
      return false;
    }
  });
  if (!signatureValid) {
    throw new ContractCallValidationError('Signed transaction does not include a valid signature from the expected wallet');
  }

  return true;
}

async function invokeContractReadOnly({ contractId, method, args }) {
  const source = await server.loadAccount(
    Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey()
  );

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (simulation.result) {
    const meta = xdr.TransactionMeta.fromXDR(simulation.result.meta, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    if (sorobanMeta && sorobanMeta.returnValue()) {
      const isError = typeof sorobanMeta.returnValue().type === 'function'
        ? sorobanMeta.returnValue().type() === xdr.ScValType.scvError
        : sorobanMeta.returnValue().switch?.()?.name === 'scvError';
      if (isError) {
        throw new Error(`Simulation returned error: ${JSON.stringify(simulation.result)}`);
      }
      return scValToNative(sorobanMeta.returnValue());
    }
  }
  throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
}

async function initializeEscrow({
  contractId,
  adminAddress,
  campaignId,
  target,
  deadline,
  assetContractAddress,
  platformFeeBps,
  platformFeeRecipientAddress,
  signerSecret,
}) {
  return invokeContract({
    contractId,
    method: 'initialize',
    args: [
      nativeToScVal(Address.fromString(adminAddress), { type: 'address' }),
      nativeToScVal(campaignId, { type: 'u64' }),
      nativeToScVal(target, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
      nativeToScVal(Address.fromString(assetContractAddress), { type: 'address' }),
      nativeToScVal(platformFeeBps, { type: 'u32' }),
      nativeToScVal(Address.fromString(platformFeeRecipientAddress), { type: 'address' }),
    ],
    signerSecret,
  });
}

async function initializeMilestones({
  contractId,
  creatorAddress,
  platformAddress,
  escrowContractId,
  milestones,
  signerSecret,
}) {
  const milestoneScVals = milestones.map((m) => {
    const titleHash = Buffer.alloc(32);
    Buffer.from(crypto.createHash('sha256').update(m.title).digest()).copy(titleHash);
    return nativeToScVal({
      title_hash: titleHash,
      release_bps: m.release_percentage_units || Math.round(parseFloat(m.release_percentage) * 100),
      status: 0,
      evidence_hash: null,
    });
  });

  return invokeContract({
    contractId,
    method: 'initialize',
    args: [
      nativeToScVal(Address.fromString(creatorAddress), { type: 'address' }),
      nativeToScVal(Address.fromString(platformAddress), { type: 'address' }),
      nativeToScVal(Address.fromString(escrowContractId), { type: 'address' }),
      nativeToScVal(milestoneScVals),
    ],
    signerSecret,
  });
}

/**
 * Deposits `amount` (already scaled to the contract's i128 unit) into the
 * escrow contract, authorized by `fromAddress` — the depositor must sign the
 * transaction themselves (signerSecret must correspond to fromAddress), since
 * the contract's `deposit` call expects the source account to satisfy
 * `from.require_auth()`. Returns the on-chain tx hash alongside the decoded
 * contract return value so callers can record the contribution immediately.
 */
async function depositToEscrow({ contractId, fromAddress, amount, signerSecret }) {
  const { hash, returnValue } = await invokeContractRaw({
    contractId,
    method: 'deposit',
    args: [
      nativeToScVal(Address.fromString(fromAddress), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    ],
    signerSecret,
  });
  return { txHash: hash, returnValue };
}

/**
 * Builds an unsigned, simulation-prepared `deposit` invocation for the
 * self-custody (Freighter) flow, where we don't hold the contributor's key
 * and must hand back XDR for the client to sign.
 */
async function buildUnsignedEscrowDeposit({ contractId, fromAddress, amount }) {
  const source = await server.loadAccount(fromAddress);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'deposit',
        nativeToScVal(Address.fromString(fromAddress), { type: 'address' }),
        nativeToScVal(amount, { type: 'i128' }),
      ),
    )
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  return preparedTx.toXDR();
}

/**
 * Contract-mode deposits require Soroban to actually be enabled — when it's
 * off, `deployCampaignContracts` still stamps a mock (non-real) contract id
 * on every campaign, so gating on `escrow_contract_id` alone would try to
 * invoke a fake contract. See issue #710.
 */
function isContractDepositEligible(campaign) {
  return process.env.SOROBAN_ENABLED === 'true' && !!campaign?.escrow_contract_id;
}

/**
 * Returns true if the given escrow contract ID is a real deployed Soroban
 * contract (not a mock ID generated when SOROBAN_ENABLED=false).
 * 
 * Mock IDs are random hex strings starting with 'C', but they're only stamped
 * when SOROBAN_ENABLED is not 'true'. Real contract IDs are also 'C...' but
 * they're deployed on-chain.
 */
function isRealSorobanContract(escrowContractId) {
  if (!escrowContractId) return false;
  return process.env.SOROBAN_ENABLED === 'true';
}

async function requestRefund({ contractId, contributorAddress, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'refund',
    args: [
      nativeToScVal(Address.fromString(contributorAddress), { type: 'address' }),
    ],
    signerSecret,
  });
}

async function approveEscrowWithdrawal({ contractId, releaseAmount, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'approve_withdrawal',
    args: [
      nativeToScVal(releaseAmount, { type: 'i128' }),
    ],
    signerSecret,
  });
}

async function executeEscrowWithdrawal({ contractId, toAddress, releaseAmount, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'execute_withdrawal',
    args: [
      nativeToScVal(Address.fromString(toAddress), { type: 'address' }),
      nativeToScVal(releaseAmount, { type: 'i128' }),
    ],
    signerSecret,
  });
}

async function getEscrowTotalRaised(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_total_raised',
    args: [],
  });
}

async function getEscrowAsset(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_asset',
    args: [],
  });
}

async function getEscrowPlatformFeeConfig(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_platform_fee_config',
    args: [],
  });
}

function encodeMilestone(m) {
  const titleHash = Buffer.alloc(32);
  Buffer.from(crypto.createHash('sha256').update(m.title).digest()).copy(titleHash);

  return nativeToScVal({
    title_hash: titleHash,
    release_bps: m.release_percentage_units ||
      Math.round(parseFloat(m.release_percentage || m.release_percentage_units || 0) * 100),
    status: 0,
    evidence_hash: null,
  });
}

function scvAddressFromString(addressString) {
  return nativeToScVal(Address.fromString(addressString), { type: 'address' });
}

async function createContractFromWasmHash({ wasmHash, signerSecret, address }) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const wasmBuf = Buffer.isBuffer(wasmHash) ? wasmHash : Buffer.from(wasmHash, 'hex');
  const op = typeof Operation.createContract === 'function'
    ? Operation.createContract(wasmHash)
    : Operation.createCustomContract({
        address: Address.fromString(address || signer.publicKey()),
        wasmHash: wasmBuf,
      });

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  tx.sign(signer);
  const result = await server.submitTransaction(tx);

  if (result.status === 'SUCCESS') {
    if (result.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const sorobanMeta = meta.v3().sorobanMeta();
      const created = sorobanMeta && typeof sorobanMeta.createdContracts === 'function' ? sorobanMeta.createdContracts() : null;
      if (created && created.length > 0) {
        return {
          contractId: created[0].contractId().toString('hex'),
          txHash: result.hash || null,
        };
      }
    }
    return { contractId: 'created_contract_id', txHash: result.hash || null };
  }
  throw new Error(`Contract creation failed: ${result.status}`);
}

async function uploadContractWasm(wasmBuffer, signerSecret) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const op = typeof Operation.uploadContractWasm === 'function'
    ? (() => {
        try {
          return Operation.uploadContractWasm({ wasm: wasmBuffer });
        } catch {
          return Operation.uploadContractWasm(wasmBuffer);
        }
      })()
    : Operation.uploadContractWasm({ wasm: wasmBuffer });

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);

  if (result.status === 'SUCCESS') {
    if (result.resultMetaXdr) {
      const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
      const retVal = meta.v3().sorobanMeta().returnValue();
      return scValToNative(retVal);
    }
  }
  throw new Error(`WASM upload failed: ${result.status}`);
}

async function refund(contractId, contributorPublicKey) {
  return invokeContract({
    contractId,
    method: 'refund',
    args: [nativeToScVal(Address.fromString(contributorPublicKey), { type: 'address' })],
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });
}

/**
 * Deploy and initialize both escrow and milestones contracts for a campaign.
 * Uses pre-deployed contract IDs from env when set, otherwise deploys new instances.
 * Falls back to mock IDs if SOROBAN_ENABLED is not true.
 */
async function deployCampaignContracts({
  creatorPublicKey,
  platformPublicKey,
  campaignId,
  targetAmount,
  deadlineUnix,
  assetContractAddress,
  platformFeeBps,
  milestones,
  signerSecret,
}) {
  const envEscrowId = process.env.ESCROW_CONTRACT_ID || null;
  const envMilestonesId = process.env.MILESTONES_CONTRACT_ID || null;

  if (envEscrowId || envMilestonesId) {
    if (envEscrowId) {
      await initializeEscrow({
        contractId: envEscrowId,
        adminAddress: creatorPublicKey,
        campaignId,
        target: targetAmount,
        deadline: deadlineUnix,
        assetContractAddress,
        platformFeeBps,
        platformFeeRecipientAddress: platformPublicKey,
        signerSecret,
      });
    }

    if (envMilestonesId && milestones && milestones.length) {
      await initializeMilestones({
        contractId: envMilestonesId,
        creatorAddress: creatorPublicKey,
        platformAddress: platformPublicKey,
        escrowContractId: envEscrowId,
        milestones,
        signerSecret,
      });
    }

    return { escrowContractId: envEscrowId, milestonesContractId: envMilestonesId };
  }

  const sorobanEnabled = process.env.SOROBAN_ENABLED === 'true';
  const escrowWasmHash = process.env.ESCROW_WASM_HASH;
  const milestonesWasmHash = process.env.MILESTONES_WASM_HASH;

  if (!sorobanEnabled) {
    const mockEscrowId = 'C' + crypto.randomBytes(24).toString('hex').toUpperCase();
    const mockMilestonesId = 'C' + crypto.randomBytes(24).toString('hex').toUpperCase();
    logger.info('Soroban disabled (SOROBAN_ENABLED != true), using mock contract IDs for development', {
      mockEscrowId,
      mockMilestonesId,
      hint: 'Set SOROBAN_ENABLED=true and configure ESCROW_CONTRACT_ID/MILESTONES_CONTRACT_ID or ESCROW_WASM_HASH/MILESTONES_WASM_HASH for real contracts',
    });
    return { escrowContractId: mockEscrowId, milestonesContractId: mockMilestonesId };
  }

  if (!escrowWasmHash || !milestonesWasmHash) {
    throw new Error(
      'SOROBAN_ENABLED is true but no contracts configured. Either set ESCROW_CONTRACT_ID and MILESTONES_CONTRACT_ID (demo mode) or ESCROW_WASM_HASH and MILESTONES_WASM_HASH (deploy mode).'
    );
  }

  try {
    logger.info('Deploying escrow contract instance...');
    const escrow = await createContractFromWasmHash({
      wasmHash: escrowWasmHash,
      signerSecret,
    });

    logger.info('Deploying milestones contract instance...');
    const milestones = await createContractFromWasmHash({
      wasmHash: milestonesWasmHash,
      signerSecret,
    });

    logger.info('Initializing escrow contract...');
    await initializeEscrow({
      contractId: escrow.contractId,
      adminAddress: milestones.contractId,
      campaignId: parseInt(campaignId.replace(/-/g, '').slice(0, 8), 16) || 1,
      target: targetAmount,
      deadline: deadlineUnix,
      assetContractAddress,
      platformFeeBps,
      platformFeeRecipientAddress: platformPublicKey,
      signerSecret,
    });

    logger.info('Initializing milestones contract...');
    await initializeMilestones({
      contractId: milestones.contractId,
      creatorAddress: creatorPublicKey,
      platformAddress: platformPublicKey,
      escrowContractId: escrow.contractId,
      milestones,
      signerSecret,
    });

    return {
      escrowContractId: escrow.contractId,
      milestonesContractId: milestones.contractId,
      deploymentTxHash: escrow.txHash,
    };
  } catch (err) {
    logger.error('Soroban contract deployment failed', { error: err.message });
    throw new Error(`Soroban contract deployment failed: ${err.message}`);
  }
}

async function submitMilestone({ contractId, creatorAddress, title, releaseBps, signerSecret }) {
  const titleHash = Buffer.alloc(32);
  Buffer.from(crypto.createHash('sha256').update(title).digest()).copy(titleHash);

  return invokeContract({
    contractId,
    method: 'submit_milestone',
    args: [
      nativeToScVal(Address.fromString(creatorAddress), { type: 'address' }),
      nativeToScVal(titleHash, { type: 'bytes' }),
      nativeToScVal(releaseBps, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function approveMilestone({ contractId, milestoneIndex, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'approve_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function rejectMilestone({ contractId, milestoneIndex, signerSecret }) {
  return invokeContract({
    contractId,
    method: 'reject_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
    signerSecret,
  });
}

async function getMilestone(contractId, milestoneIndex) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_milestone',
    args: [
      nativeToScVal(milestoneIndex, { type: 'u32' }),
    ],
  });
}

async function getAllMilestones(contractId) {
  return invokeContractReadOnly({
    contractId,
    method: 'get_all_milestones',
    args: [],
  });
}

const MILESTONE_STATUS_LABELS = {
  0: 'pending',
  1: 'submitted',
  2: 'released',
  3: 'rejected',
};

function mapMilestoneOnChainStatus(statusValue) {
  if (statusValue && typeof statusValue === 'object' && 'tag' in statusValue) {
    const tag = String(statusValue.tag).toLowerCase();
    if (tag.includes('approved')) return 'released';
    if (tag.includes('submitted')) return 'submitted';
    if (tag.includes('rejected')) return 'rejected';
    return 'pending';
  }
  return MILESTONE_STATUS_LABELS[Number(statusValue)] || 'pending';
}

/**
 * Deploy and initialize Soroban contracts for a campaign.
 * Returns the primary contract address (escrow) plus milestones contract ID.
 */
async function initializeCampaignContract({
  campaignId,
  creator,
  goal,
  deadline,
  milestones,
  platformPublicKey,
  assetContractAddress,
  platformFeeBps = 0,
  signerSecret,
}) {
  const { escrowContractId, milestonesContractId } = await deployCampaignContracts({
    creatorPublicKey: creator,
    platformPublicKey,
    campaignId,
    targetAmount: goal,
    deadlineUnix: deadline,
    assetContractAddress,
    platformFeeBps,
    milestones,
    signerSecret,
  });

  return {
    contractAddress: escrowContractId,
    escrowContractId,
    milestonesContractId,
  };
}

/**
 * Release a milestone on-chain via the milestones contract.
 */
async function releaseMilestone({ milestonesContractId, milestoneIndex, signerSecret }) {
  if (!milestonesContractId) {
    throw new Error('Campaign does not have a milestones contract deployed');
  }

  try {
    return await approveMilestone({
      contractId: milestonesContractId,
      milestoneIndex,
      signerSecret,
    });
  } catch (err) {
    throw new Error(`On-chain milestone release failed: ${err.message}`);
  }
}

/**
 * Trigger an on-chain refund for a contributor via the escrow contract.
 */
async function triggerRefund({ escrowContractId, contributorAddress, signerSecret }) {
  if (!escrowContractId) {
    throw new Error('Campaign does not have an escrow contract deployed');
  }

  try {
    return await requestRefund({
      contractId: escrowContractId,
      contributorAddress,
      signerSecret,
    });
  } catch (err) {
    throw new Error(`On-chain refund failed: ${err.message}`);
  }
}

/**
 * Deploy a milestones V2 contract instance from MILESTONES_V2_WASM_HASH.
 * Its `initialize` ABI is identical to V1's, so initializeMilestones() above
 * is reused to initialize it once deployed.
 */
async function deployMilestonesV2Contract({ signerSecret }) {
  const wasmHash = process.env.MILESTONES_V2_WASM_HASH;
  if (!wasmHash) {
    throw new Error('MILESTONES_V2_WASM_HASH is not configured');
  }
  return createContractFromWasmHash({ wasmHash, signerSecret });
}

/**
 * Deploy the standalone migration orchestrator contract from
 * MIGRATION_WASM_HASH and initialize it with the platform address that will
 * be authorized to drive migrations.
 */
async function deployMigrationContract({ platformAddress, signerSecret }) {
  const wasmHash = process.env.MIGRATION_WASM_HASH;
  if (!wasmHash) {
    throw new Error('MIGRATION_WASM_HASH is not configured');
  }
  const deployed = await createContractFromWasmHash({ wasmHash, signerSecret });
  await invokeContract({
    contractId: deployed.contractId,
    method: 'initialize',
    args: [nativeToScVal(Address.fromString(platformAddress), { type: 'address' })],
    signerSecret,
  });
  return deployed;
}

/**
 * Invoke migrate(v1_contract_id, v2_contract_id) on the migration
 * orchestrator and parse the MigrationCompleted event out of the same
 * transaction result, so the caller learns the milestone count without a
 * separate event-polling round trip.
 */
async function runMigration({ migrationContractId, v1ContractId, v2ContractId, signerSecret }) {
  const signer = Keypair.fromSecret(signerSecret);
  const source = await server.loadAccount(signer.publicKey());

  const contract = new Contract(migrationContractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(
      'migrate',
      scvAddressFromString(v1ContractId),
      scvAddressFromString(v2ContractId),
    ))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build();

  const preparedTx = await simulateAndPrepare(tx);
  preparedTx.sign(signer);
  const result = await server.submitTransaction(preparedTx);

  if (result.status !== 'SUCCESS') {
    throw new Error(`Migration transaction failed: ${result.status}`);
  }

  let milestoneCount = null;
  if (result.resultMetaXdr) {
    const meta = xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
    const sorobanMeta = meta.v3().sorobanMeta();
    const events = sorobanMeta && typeof sorobanMeta.events === 'function' ? sorobanMeta.events() : [];
    for (const event of events) {
      try {
        const topics = event.body().v0().topics().map((t) => scValToNative(t));
        if (topics[0] === 'MigrationCompleted') {
          const data = scValToNative(event.body().v0().data());
          milestoneCount = Array.isArray(data) ? Number(data[2]) : null;
          break;
        }
      } catch (err) {
        logger.warn('Could not decode a contract event while parsing MigrationCompleted', { error: err.message });
      }
    }
  }

  return { txHash: result.hash || null, milestoneCount };
}

/**
 * Release escrow funds to the creator (dispute resolved in creator's favor).
 * Approves and executes the withdrawal in a single call.
 * Returns the transaction hash on success.
 * 
 * NOTE: This is for REAL Soroban escrow contracts only. It is NOT a substitute
 * for stellarService.releaseEscrowFreeze which handles the multisig freeze.
 */
async function releaseEscrowToCreator({ escrowContractId, creatorAddress, releaseAmount, signerSecret }) {
  if (!escrowContractId) {
    throw new Error('Campaign does not have an escrow contract deployed');
  }

  const signer = signerSecret || process.env.PLATFORM_SECRET_KEY;

  try {
    await approveEscrowWithdrawal({
      contractId: escrowContractId,
      releaseAmount,
      signerSecret: signer,
    });

    const result = await executeEscrowWithdrawal({
      contractId: escrowContractId,
      toAddress: creatorAddress,
      releaseAmount,
      signerSecret: signer,
    });

    return result;
  } catch (err) {
    throw new Error(`On-chain escrow release failed: ${err.message}`);
  }
}

/**
 * Read on-chain campaign status from deployed Soroban contracts.
 */
async function getContractStatus({
  escrowContractId,
  milestonesContractId,
  deadlineUnix,
  targetAmount,
}) {
  const result = {
    status: 'unknown',
    totalRaised: 0,
    milestones: [],
  };

  if (!escrowContractId && !milestonesContractId) {
    return result;
  }

  if (escrowContractId) {
    result.totalRaised = Number(await getEscrowTotalRaised(escrowContractId)) || 0;
    const target = Number(targetAmount) || 0;
    const now = Math.floor(Date.now() / 1000);

    if (target > 0 && result.totalRaised >= target) {
      result.status = 'funded';
    } else if (deadlineUnix && now >= deadlineUnix) {
      result.status = 'failed';
    } else {
      result.status = 'active';
    }
  }

  if (milestonesContractId) {
    const onChainMilestones = await getAllMilestones(milestonesContractId);
    const items = Array.isArray(onChainMilestones) ? onChainMilestones : [];
    result.milestones = items.map((milestone, index) => ({
      index,
      on_chain_status: mapMilestoneOnChainStatus(milestone?.status),
      released: mapMilestoneOnChainStatus(milestone?.status) === 'released',
    }));
  }

  return result;
}

module.exports = {
  invokeContract,
  invokeContractRaw,
  invokeContractReadOnly,
  initializeEscrow,
  initializeMilestones,
  depositToEscrow,
  buildUnsignedEscrowDeposit,
  buildUnsignedContractCall,
  submitSignedContractCall,
  validateSubmittedContractCallXdr,
  ContractCallValidationError,
  isContractDepositEligible,
  isRealSorobanContract,
  requestRefund,
  approveEscrowWithdrawal,
  executeEscrowWithdrawal,
  releaseEscrowToCreator,
  getEscrowTotalRaised,
  getEscrowAsset,
  getEscrowPlatformFeeConfig,
  createContractFromWasmHash,
  uploadContractWasm,
  deployCampaignContracts,
  encodeMilestone,
  scvAddressFromString,
  nativeToScVal,
  submitMilestone,
  approveMilestone,
  rejectMilestone,
  getMilestone,
  getAllMilestones,
  initializeCampaignContract,
  releaseMilestone,
  triggerRefund,
  getContractStatus,
  mapMilestoneOnChainStatus,
  refund,
  deployMilestonesV2Contract,
  deployMigrationContract,
  runMigration,
};
