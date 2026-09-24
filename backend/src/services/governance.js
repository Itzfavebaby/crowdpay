const {
  invokeContract,
  invokeContractReadOnly,
  buildUnsignedContractCall,
  submitSignedContractCall,
  nativeToScVal,
} = require('./sorobanService');
const { server } = require('../config/stellar');
const logger = require('../config/logger');
const db = require('../config/database');

const FEE_REGISTRY_CONTRACT_ID = process.env.FEE_REGISTRY_CONTRACT_ID;
const GOVERNANCE_TOKEN_ID = process.env.GOVERNANCE_TOKEN_ID;
const MIN_TOKEN_BALANCE = 1000;
const QUORUM_THRESHOLD = 1000; // 10% of total supply (assuming 10,000 total)

/**
 * Get the current pending proposal from the contract.
 * @returns {Promise<object|null>} Proposal data or null if no active proposal
 */
async function getPendingProposal() {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    return null;
  }

  try {
    const proposal = await invokeContractReadOnly({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'get_pending_proposal',
      args: [],
    });

    if (!proposal) {
      return null;
    }

    return {
      id: proposal.id,
      proposed_fee_bps: proposal.proposed_fee_bps,
      proposed_creator_share_bps: proposal.proposed_creator_share_bps,
      votes_for: Number(proposal.votes_for),
      votes_against: Number(proposal.votes_against),
      deadline: Number(proposal.deadline),
      status: mapProposalStatus(proposal.status),
    };
  } catch (error) {
    logger.error('Failed to get pending proposal', { error: error.message });
    return null;
  }
}

/**
 * Map contract proposal status to API status.
 */
function mapProposalStatus(status) {
  if (typeof status === 'object' && status !== null) {
    if (status.tag === 'Active') return 'active';
    if (status.tag === 'Passed') return 'passed';
    if (status.tag === 'Failed') return 'failed';
    if (status.tag === 'Executed') return 'executed';
  }
  return String(status).toLowerCase();
}

/**
 * Get all proposals (active and historical) from the database.
 * @returns {Promise<Array>} List of proposals
 */
async function getAllProposals() {
  const query = `
    SELECT 
      gp.id,
      gp.stellar_proposal_id,
      gp.proposer,
      gp.rationale_text,
      gp.created_at,
      gp.proposed_fee_bps,
      gp.proposed_creator_share_bps,
      gp.status,
      gp.votes_for,
      gp.votes_against,
      gp.deadline,
      gp.executed_at
    FROM governance_proposals_meta gp
    ORDER BY gp.created_at DESC
  `;

  const result = await db.query(query);
  return result.rows;
}

/**
 * Get a single proposal by ID with full details.
 * @param {number} proposalId - Database proposal ID
 * @returns {Promise<object|null>} Proposal details
 */
async function getProposalById(proposalId) {
  const query = `
    SELECT 
      gp.id,
      gp.stellar_proposal_id,
      gp.proposer,
      gp.rationale_text,
      gp.created_at,
      gp.proposed_fee_bps,
      gp.proposed_creator_share_bps,
      gp.status,
      gp.votes_for,
      gp.votes_against,
      gp.deadline,
      gp.executed_at
    FROM governance_proposals_meta gp
    WHERE gp.id = $1
  `;

  const result = await db.query(query, [proposalId]);
  
  if (result.rows.length === 0) {
    return null;
  }

  const proposal = result.rows[0];

  // Get vote statistics
  const voteStatsQuery = `
    SELECT 
      COUNT(*) as total_votes,
      COUNT(CASE WHEN in_favor = true THEN 1 END) as votes_for,
      COUNT(CASE WHEN in_favor = false THEN 1 END) as votes_against,
      SUM(token_balance_at_vote) as total_token_weight
    FROM governance_votes_log
    WHERE proposal_id = $1
  `;

  const voteStats = await db.query(voteStatsQuery, [proposalId]);
  const stats = voteStats.rows[0];

  // Get current on-chain proposal if active
  let onChainProposal = null;
  if (proposal.status === 'active') {
    onChainProposal = await getPendingProposal();
  }

  // Calculate participation rate and outcome projection
  const totalVotes = Number(stats.total_votes) || 0;
  const votesFor = Number(stats.votes_for) || 0;
  const votesAgainst = Number(stats.votes_against) || 0;
  const totalTokenWeight = Number(stats.total_token_weight) || 0;
  const participationRate = QUORUM_THRESHOLD > 0 ? (totalTokenWeight / QUORUM_THRESHOLD) * 100 : 0;
  
  let outcomeProjection = 'pending';
  if (proposal.status !== 'active') {
    outcomeProjection = proposal.status;
  } else if (votesFor > votesAgainst && totalTokenWeight >= QUORUM_THRESHOLD) {
    outcomeProjection = 'likely_pass';
  } else if (votesFor > votesAgainst) {
    outcomeProjection = 'needs_quorum';
  } else {
    outcomeProjection = 'likely_fail';
  }

  return {
    ...proposal,
    vote_stats: {
      total_votes: totalVotes,
      votes_for: votesFor,
      votes_against: votesAgainst,
      total_token_weight: totalTokenWeight,
      participation_rate: participationRate.toFixed(2),
    },
    outcome_projection: outcomeProjection,
    on_chain_data: onChainProposal,
  };
}

/**
 * Check if a user holds governance tokens.
 * @param {string} publicKey - Stellar public key
 * @returns {Promise<boolean>} Whether user holds tokens
 */
async function checkUserTokenBalance(publicKey) {
  if (!GOVERNANCE_TOKEN_ID) {
    logger.warn('GOVERNANCE_TOKEN_ID not configured');
    return false;
  }

  try {
    const account = await server.loadAccount(publicKey);
    const balance = account.balances.find(
      (b) => b.asset_code === 'CROWD' && b.asset_issuer === GOVERNANCE_TOKEN_ID
    );

    if (!balance) {
      return false;
    }

    const balanceNum = parseFloat(balance.balance);
    return balanceNum >= MIN_TOKEN_BALANCE;
  } catch (error) {
    logger.error('Failed to check user token balance', { error: error.message, publicKey });
    return false;
  }
}

/**
 * Get user's token balance.
 * @param {string} publicKey - Stellar public key
 * @returns {Promise<number>} Token balance
 */
async function getUserTokenBalance(publicKey) {
  if (!GOVERNANCE_TOKEN_ID) {
    return 0;
  }

  try {
    const account = await server.loadAccount(publicKey);
    const balance = account.balances.find(
      (b) => b.asset_code === 'CROWD' && b.asset_issuer === GOVERNANCE_TOKEN_ID
    );

    return balance ? parseFloat(balance.balance) : 0;
  } catch (error) {
    logger.error('Failed to get user token balance', { error: error.message, publicKey });
    return 0;
  }
}

/**
 * Load every vote delegation edge into an in-memory map.
 * Returns { delegatorToDelegate, delegateToDelegators }.
 */
async function loadDelegationMap() {
  const { rows } = await db.query(
    `SELECT delegator_public_key, delegate_public_key
     FROM governance_delegations`
  );

  const delegatorToDelegate = new Map();
  const delegateToDelegators = new Map();

  for (const row of rows) {
    delegatorToDelegate.set(row.delegator_public_key, row.delegate_public_key);
    if (!delegateToDelegators.has(row.delegate_public_key)) {
      delegateToDelegators.set(row.delegate_public_key, []);
    }
    delegateToDelegators.get(row.delegate_public_key).push(row.delegator_public_key);
  }

  return { delegatorToDelegate, delegateToDelegators };
}

/**
 * Check whether assigning delegator -> delegate would introduce a cycle or a
 * self-delegation. The delegation graph is a collection of trees (each wallet
 * points at at most one target), so a cycle is introduced only when following
 * the delegate's own delegate chain eventually reaches the delegator.
 */
async function assignmentIsValid(delegatorPublicKey, delegatePublicKey) {
  if (delegatorPublicKey === delegatePublicKey) {
    return { ok: false, reason: 'cannot delegate to yourself' };
  }

  const { delegatorToDelegate } = await loadDelegationMap();

  let cursor = delegatePublicKey;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    if (cursor === delegatorPublicKey) {
      return { ok: false, reason: 'delegation would create a circular reference' };
    }
    seen.add(cursor);
    cursor = delegatorToDelegate.get(cursor);
  }

  return { ok: true };
}

/**
 * Set (or replace) a wallet's voting-power delegation.
 * @param {string} delegatorPublicKey - Wallet giving up its vote power
 * @param {string} delegatePublicKey - Wallet receiving the delegated power
 * @returns {Promise<object>} The active delegation edge
 */
async function setVoteDelegation(delegatorPublicKey, delegatePublicKey) {
  const { ok, reason } = await assignmentIsValid(delegatorPublicKey, delegatePublicKey);
  if (!ok) {
    throw Object.assign(new Error(reason), { code: 'INVALID_DELEGATION' });
  }

  const { rows } = await db.query(
    `INSERT INTO governance_delegations (delegator_public_key, delegate_public_key)
     VALUES ($1, $2)
     ON CONFLICT (delegator_public_key)
     DO UPDATE SET delegate_public_key = EXCLUDED.delegate_public_key,
                   updated_at = NOW()
     RETURNING delegator_public_key, delegate_public_key, created_at, updated_at`,
    [delegatorPublicKey, delegatePublicKey]
  );

  return rows[0];
}

/**
 * Revoke a wallet's vote delegation (returns its power directly to the wallet).
 * @param {string} delegatorPublicKey - Wallet withdrawing its delegation
 * @returns {Promise<boolean>} Whether a delegation existed and was removed
 */
async function revokeVoteDelegation(delegatorPublicKey) {
  const { rows } = await db.query(
    `DELETE FROM governance_delegations
     WHERE delegator_public_key = $1
     RETURNING id`,
    [delegatorPublicKey]
  );
  return rows.length > 0;
}

/**
 * Get the wallet a given delegator currently points at (or null).
 */
async function getDelegateForWallet(publicKey) {
  const { rows } = await db.query(
    `SELECT delegator_public_key, delegate_public_key
     FROM governance_delegations
     WHERE delegator_public_key = $1`,
    [publicKey]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Collect every wallet that, directly or transitively, delegates its vote
 * power to `publicKey`. A voter's power is the sum of their own balance plus
 * the balances of every wallet in this set (their own balances, not balances
 * further delegated down the chain, which are already attributed one level up).
 */
async function getAllTransitiveDelegatorWallets(publicKey) {
  const { delegateToDelegators } = await loadDelegationMap();
  const delegators = new Set();
  const queue = [publicKey];

  while (queue.length) {
    const current = queue.shift();
    const direct = delegateToDelegators.get(current) || [];
    for (const wallet of direct) {
      if (!delegators.has(wallet)) {
        delegators.add(wallet);
        queue.push(wallet);
      }
    }
  }

  return Array.from(delegators);
}

/**
 * Compute a wallet's effective governance voting weight by traversing the
 * delegation chain: its own CROWD balance plus the CROWD balance of every
 * delegator that points at it (recursively through the chain).
 * @param {string} publicKey - Stellar public key
 * @returns {Promise<number>} Effective vote weight
 */
async function getEffectiveVoteWeight(publicKey) {
  const delegateWallets = await getAllTransitiveDelegatorWallets(publicKey);
  let weight = await getUserTokenBalance(publicKey);

  for (const wallet of delegateWallets) {
    weight += await getUserTokenBalance(wallet);
  }

  return weight;
}

/**
 * Args for the contract's `propose_change` method, shared by the custodial
 * inline-sign path and the Freighter build-unsigned-XDR path so both produce
 * an identical operation for the same inputs.
 */
function proposeChangeArgs(proposerPublicKey, newFeeBps, newCreatorShareBps) {
  return [
    nativeToScVal(proposerPublicKey, { type: 'address' }),
    nativeToScVal(newFeeBps, { type: 'u32' }),
    nativeToScVal(newCreatorShareBps, { type: 'u32' }),
  ];
}

/** Persists a just-created on-chain proposal's metadata. */
async function recordProposalCreated({
  stellarProposalId,
  proposerPublicKey,
  newFeeBps,
  newCreatorShareBps,
  rationaleText,
}) {
  const insertQuery = `
    INSERT INTO governance_proposals_meta
    (stellar_proposal_id, proposer, rationale_text, proposed_fee_bps, proposed_creator_share_bps, status, votes_for, votes_against, deadline)
    VALUES ($1, $2, $3, $4, $5, 'active', 0, 0, NOW() + INTERVAL '7 days')
    RETURNING id
  `;

  const result = await db.query(insertQuery, [
    Number(stellarProposalId),
    proposerPublicKey,
    rationaleText,
    newFeeBps,
    newCreatorShareBps,
  ]);

  logger.info('Proposal created', {
    proposalId: result.rows[0].id,
    stellarProposalId,
    proposer: proposerPublicKey,
  });

  return {
    id: result.rows[0].id,
    stellar_proposal_id: Number(stellarProposalId),
    proposer: proposerPublicKey,
    rationale_text: rationaleText,
    proposed_fee_bps: newFeeBps,
    proposed_creator_share_bps: newCreatorShareBps,
    status: 'active',
  };
}

/**
 * Create a proposal on-chain (custodial wallets — server holds the signing key).
 * @param {string} proposerPublicKey - Proposer's Stellar public key, resolved
 *   server-side from the authenticated user; never trust a client-supplied key.
 * @param {number} newFeeBps - Proposed platform fee in basis points
 * @param {number} newCreatorShareBps - Proposed creator share in basis points
 * @param {string} rationaleText - Rationale for the proposal
 * @param {string} signerSecret - Decrypted custodial secret for proposerPublicKey
 * @returns {Promise<object>} Created proposal data
 */
async function createProposal(proposerPublicKey, newFeeBps, newCreatorShareBps, rationaleText, signerSecret) {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    throw new Error('FEE_REGISTRY_CONTRACT_ID not configured');
  }

  const hasTokens = await checkUserTokenBalance(proposerPublicKey);
  if (!hasTokens) {
    throw new Error('Proposer must hold at least 1,000 governance tokens');
  }

  try {
    const proposalId = await invokeContract({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'propose_change',
      args: proposeChangeArgs(proposerPublicKey, newFeeBps, newCreatorShareBps),
      signerSecret,
    });

    return await recordProposalCreated({
      stellarProposalId: proposalId,
      proposerPublicKey,
      newFeeBps,
      newCreatorShareBps,
      rationaleText,
    });
  } catch (error) {
    logger.error('Failed to create proposal', { error: error.message });
    throw error;
  }
}

/**
 * Builds the unsigned `propose_change` XDR for a Freighter (self-custody)
 * proposer to sign in the browser. Checks the token-balance gate up front so
 * the client isn't asked to sign a transaction that will just be rejected.
 */
async function buildUnsignedProposal({ proposerPublicKey, newFeeBps, newCreatorShareBps }) {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    throw new Error('FEE_REGISTRY_CONTRACT_ID not configured');
  }
  const hasTokens = await checkUserTokenBalance(proposerPublicKey);
  if (!hasTokens) {
    throw new Error('Proposer must hold at least 1,000 governance tokens');
  }
  return buildUnsignedContractCall({
    contractId: FEE_REGISTRY_CONTRACT_ID,
    method: 'propose_change',
    args: proposeChangeArgs(proposerPublicKey, newFeeBps, newCreatorShareBps),
    sourcePublicKey: proposerPublicKey,
  });
}

/**
 * Submits a client-signed `propose_change` transaction (already validated by
 * the route against the prepare token it was built from) and records the
 * resulting proposal.
 */
async function createProposalFromSignedXdr({
  signedXdr,
  proposerPublicKey,
  newFeeBps,
  newCreatorShareBps,
  rationaleText,
}) {
  const { returnValue: stellarProposalId } = await submitSignedContractCall(signedXdr);
  return recordProposalCreated({
    stellarProposalId,
    proposerPublicKey,
    newFeeBps,
    newCreatorShareBps,
    rationaleText,
  });
}

function voteArgs(voterPublicKey, stellarProposalId, inFavor) {
  return [
    nativeToScVal(voterPublicKey, { type: 'address' }),
    nativeToScVal(stellarProposalId, { type: 'u32' }),
    nativeToScVal(inFavor, { type: 'bool' }),
  ];
}

/**
 * Loads a proposal and computes the voter's effective weight, validating both
 * before any transaction is built or submitted. Shared by the custodial vote
 * path, the Freighter prepare step, and the Freighter submit step, so all
 * three enforce identical eligibility rules.
 */
async function prepareVoteContext(proposalId, voterPublicKey) {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    throw new Error('FEE_REGISTRY_CONTRACT_ID not configured');
  }

  const proposalResult = await db.query(
    'SELECT stellar_proposal_id, status FROM governance_proposals_meta WHERE id = $1',
    [proposalId]
  );
  if (proposalResult.rows.length === 0) {
    throw new Error('Proposal not found');
  }
  const proposal = proposalResult.rows[0];
  if (proposal.status !== 'active') {
    throw new Error('Proposal is not active for voting');
  }

  // Effective vote weight accounts for delegated power (#735): the voter's own
  // balance plus every wallet that delegates to them, traversed recursively.
  const effectiveWeight = await getEffectiveVoteWeight(voterPublicKey);
  if (effectiveWeight <= 0) {
    throw new Error('Voter must hold governance tokens');
  }

  return { proposal, effectiveWeight };
}

async function recordVoteCast({ proposalId, voterPublicKey, inFavor, effectiveWeight }) {
  await db.query(
    `INSERT INTO governance_votes_log (proposal_id, voter_public_key, in_favor, token_balance_at_vote, voted_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [proposalId, voterPublicKey, inFavor, effectiveWeight]
  );
  logger.info('Vote recorded', { proposalId, voter: voterPublicKey, inFavor, weight: effectiveWeight });
  return {
    proposal_id: proposalId,
    voter: voterPublicKey,
    in_favor: inFavor,
    token_balance: effectiveWeight,
  };
}

/**
 * Vote on a proposal on-chain (custodial wallets — server holds the signing key).
 * @param {number} proposalId - Database proposal ID
 * @param {string} voterPublicKey - Voter's Stellar public key, resolved
 *   server-side from the authenticated user; never trust a client-supplied key.
 * @param {boolean} inFavor - Whether vote is in favor
 * @param {string} signerSecret - Decrypted custodial secret for voterPublicKey
 * @returns {Promise<object>} Vote result
 */
async function voteOnProposal(proposalId, voterPublicKey, inFavor, signerSecret) {
  const { proposal, effectiveWeight } = await prepareVoteContext(proposalId, voterPublicKey);

  try {
    await invokeContract({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'vote',
      args: voteArgs(voterPublicKey, proposal.stellar_proposal_id, inFavor),
      signerSecret,
    });

    return await recordVoteCast({ proposalId, voterPublicKey, inFavor, effectiveWeight });
  } catch (error) {
    logger.error('Failed to vote on proposal', { error: error.message, proposalId });
    throw error;
  }
}

/** Builds the unsigned `vote` XDR for a Freighter voter to sign in the browser. */
async function buildUnsignedVote({ proposalId, voterPublicKey, inFavor }) {
  const { proposal } = await prepareVoteContext(proposalId, voterPublicKey);
  return buildUnsignedContractCall({
    contractId: FEE_REGISTRY_CONTRACT_ID,
    method: 'vote',
    args: voteArgs(voterPublicKey, proposal.stellar_proposal_id, inFavor),
    sourcePublicKey: voterPublicKey,
  });
}

/**
 * Submits a client-signed `vote` transaction (already validated by the route
 * against the prepare token it was built from) and records the vote.
 * Re-validates eligibility at submit time in case anything changed since the
 * vote was prepared (proposal closed, delegation revoked, etc).
 */
async function voteFromSignedXdr({ signedXdr, proposalId, voterPublicKey, inFavor }) {
  const { effectiveWeight } = await prepareVoteContext(proposalId, voterPublicKey);
  await submitSignedContractCall(signedXdr);
  return recordVoteCast({ proposalId, voterPublicKey, inFavor, effectiveWeight });
}

/**
 * Execute a proposal on-chain via the platform relayer key. No per-user
 * signature is meaningful here — the contract doesn't gate execution on a
 * specific caller's authorization, so the platform key (already used as a
 * relayer/co-signer elsewhere, e.g. withdrawal platform-approval) submits on
 * behalf of whichever authenticated user triggers it. Status and deadline are
 * pre-checked here so an ineligible proposal fails fast with a clear error
 * rather than only via the contract's own on-chain rejection.
 * @param {number} proposalId - Database proposal ID
 * @param {string} signerSecret - Platform relayer secret key (never a user's own key)
 * @returns {Promise<object>} Execution result
 */
async function executeProposal(proposalId, signerSecret) {
  if (!FEE_REGISTRY_CONTRACT_ID) {
    throw new Error('FEE_REGISTRY_CONTRACT_ID not configured');
  }

  const proposalResult = await db.query(
    'SELECT stellar_proposal_id, status, deadline FROM governance_proposals_meta WHERE id = $1',
    [proposalId]
  );
  if (proposalResult.rows.length === 0) {
    throw new Error('Proposal not found');
  }

  const proposal = proposalResult.rows[0];

  if (proposal.status !== 'active') {
    throw new Error('Proposal is not active');
  }
  if (new Date(proposal.deadline) > new Date()) {
    throw new Error('Proposal deadline has not passed yet');
  }

  try {
    await invokeContract({
      contractId: FEE_REGISTRY_CONTRACT_ID,
      method: 'execute_proposal',
      args: [
        nativeToScVal(proposal.stellar_proposal_id, { type: 'u32' }),
      ],
      signerSecret,
    });

    // Get updated proposal status from contract
    const onChainProposal = await getPendingProposal();
    const newStatus = onChainProposal ? onChainProposal.status : 'failed';

    // Update database
    const updateQuery = `
      UPDATE governance_proposals_meta
      SET status = $1, executed_at = NOW()
      WHERE id = $2
    `;

    await db.query(updateQuery, [newStatus, proposalId]);

    logger.info('Proposal executed', { proposalId, status: newStatus });

    return {
      proposal_id: proposalId,
      status: newStatus,
      executed_at: new Date(),
    };
  } catch (error) {
    logger.error('Failed to execute proposal', { error: error.message, proposalId });
    throw error;
  }
}

/**
 * Sync proposal data from on-chain to database.
 * Called periodically to keep database in sync.
 */
async function syncProposalData() {
  try {
    const onChainProposal = await getPendingProposal();
    
    if (!onChainProposal) {
      return;
    }

    const updateQuery = `
      UPDATE governance_proposals_meta
      SET 
        votes_for = $1,
        votes_against = $2,
        status = $3
      WHERE stellar_proposal_id = $4
    `;

    await db.query(updateQuery, [
      onChainProposal.votes_for,
      onChainProposal.votes_against,
      onChainProposal.status,
      onChainProposal.id,
    ]);

    logger.info('Proposal data synced from on-chain', { proposalId: onChainProposal.id });
  } catch (error) {
    logger.error('Failed to sync proposal data', { error: error.message });
  }
}

module.exports = {
  getPendingProposal,
  getAllProposals,
  getProposalById,
  checkUserTokenBalance,
  getUserTokenBalance,
  createProposal,
  buildUnsignedProposal,
  createProposalFromSignedXdr,
  voteOnProposal,
  buildUnsignedVote,
  voteFromSignedXdr,
  executeProposal,
  syncProposalData,
  setVoteDelegation,
  revokeVoteDelegation,
  getDelegateForWallet,
  getEffectiveVoteWeight,
  getAllTransitiveDelegatorWallets,
};
