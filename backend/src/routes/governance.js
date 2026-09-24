const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const {
  getAllProposals,
  getProposalById,
  getUserTokenBalance,
  getEffectiveVoteWeight,
  setVoteDelegation,
  revokeVoteDelegation,
  getDelegateForWallet,
  createProposal,
  buildUnsignedProposal,
  createProposalFromSignedXdr,
  voteOnProposal,
  buildUnsignedVote,
  voteFromSignedXdr,
  executeProposal,
  syncProposalData,
} = require('../services/governance');
const { validateSubmittedContractCallXdr } = require('../services/sorobanService');
const {
  getFeeRegistryInfo,
  invalidateFeeCache,
} = require('../services/feeRegistry');
const { requireAuth } = require('../middleware/auth');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const db = require('../config/database');
const { body, param, validationResult } = require('express-validator');
const logger = require('../config/logger');

const GOVERNANCE_PREPARE_TOKEN_TTL = '10m';

/**
 * Resolves the authenticated user's wallet server-side by userId and attaches
 * it to req.wallet. Governance actions must never trust a wallet identity
 * supplied by the client (see #802).
 */
async function attachWallet(req, res, next) {
  try {
    const { rows } = await db.query(
      'SELECT wallet_public_key, wallet_secret_encrypted, wallet_type FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows.length || !rows[0].wallet_public_key) {
      return res.status(400).json({ error: 'No wallet configured for this account' });
    }
    req.wallet = {
      publicKey: rows[0].wallet_public_key,
      secretEncrypted: rows[0].wallet_secret_encrypted,
      type: rows[0].wallet_type,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function verifyPrepareToken(token, expectedAction) {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Invalid or expired prepare token');
    err.statusCode = 422;
    throw err;
  }
  if (decoded.action !== expectedAction) {
    const err = new Error('Prepare token does not match this action');
    err.statusCode = 422;
    throw err;
  }
  return decoded;
}

/**
 * GET /api/governance/proposals
 * List all proposals (active and historical)
 */
router.get('/proposals', async (req, res, next) => {
  try {
    const proposals = await getAllProposals();
    res.json({ proposals });
  } catch (error) {
    logger.error('Failed to get proposals', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/proposals/:id
 * Get single proposal detail with votes and outcome projection
 */
router.get('/proposals/:id', 
  param('id').isUUID(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const proposal = await getProposalById(req.params.id);
      
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }

      res.json({ proposal });
    } catch (error) {
      logger.error('Failed to get proposal', { error: error.message, proposalId: req.params.id });
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/:id/vote
 * User votes on a proposal. Custodial wallets sign and submit inline;
 * Freighter wallets get back an unsigned XDR + prepare_token to sign in the
 * browser and finalize via POST /proposals/:id/vote/submit-signed.
 */
router.post('/proposals/:id/vote',
  requireAuth,
  attachWallet,
  param('id').isUUID(),
  body('in_favor').isBoolean(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { in_favor } = req.body;
    const voterPublicKey = req.wallet.publicKey;

    try {
      if (req.wallet.type === 'freighter') {
        const unsignedXdr = await buildUnsignedVote({
          proposalId: req.params.id,
          voterPublicKey,
          inFavor: in_favor,
        });
        const prepareToken = jwt.sign(
          { action: 'vote', sourcePublicKey: voterPublicKey, proposalId: req.params.id, inFavor: in_favor, unsignedXdr },
          process.env.JWT_SECRET,
          { expiresIn: GOVERNANCE_PREPARE_TOKEN_TTL }
        );
        return res.status(200).json({ mode: 'prepare', unsigned_xdr: unsignedXdr, prepare_token: prepareToken });
      }

      const result = await withDecryptedWalletSecret(
        req.wallet.secretEncrypted,
        { userId: req.user.userId, walletPublicKey: voterPublicKey },
        (secret) => voteOnProposal(req.params.id, voterPublicKey, in_favor, secret)
      );

      res.json({ success: true, vote: result });
    } catch (error) {
      logger.error('Failed to vote on proposal', { error: error.message, proposalId: req.params.id });

      if (error.message.includes('not active') || error.message.includes('not found')) {
        return res.status(400).json({ error: error.message });
      }
      if (error.message.includes('must hold')) {
        return res.status(403).json({ error: error.message });
      }

      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/:id/vote/submit-signed
 * Finalizes a Freighter-signed vote. Rejects a cross-wallet signature or a
 * signed transaction whose args don't match what was prepared (#802).
 */
router.post('/proposals/:id/vote/submit-signed',
  requireAuth,
  param('id').isUUID(),
  body('prepare_token').isString(),
  body('signed_xdr').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const decoded = verifyPrepareToken(req.body.prepare_token, 'vote');
      if (decoded.proposalId !== req.params.id) {
        return res.status(422).json({ error: 'Prepare token does not match this proposal' });
      }

      validateSubmittedContractCallXdr({
        signedXdr: req.body.signed_xdr,
        unsignedXdr: decoded.unsignedXdr,
        expectedSourcePublicKey: decoded.sourcePublicKey,
      });

      const result = await voteFromSignedXdr({
        signedXdr: req.body.signed_xdr,
        proposalId: req.params.id,
        voterPublicKey: decoded.sourcePublicKey,
        inFavor: decoded.inFavor,
      });

      res.json({ success: true, vote: result });
    } catch (error) {
      if (error.isValidationError || error.statusCode === 422) {
        return res.status(422).json({ error: error.message });
      }
      logger.error('Failed to submit signed vote', { error: error.message, proposalId: req.params.id });
      if (error.message.includes('not active') || error.message.includes('not found')) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals
 * Create a new proposal (gated by token balance check). Custodial wallets
 * sign and submit inline; Freighter wallets get back an unsigned XDR +
 * prepare_token to sign in the browser and finalize via
 * POST /proposals/submit-signed.
 */
router.post('/proposals',
  requireAuth,
  attachWallet,
  body('new_fee_bps').isInt({ min: 0, max: 10000 }),
  body('new_creator_share_bps').isInt({ min: 0, max: 10000 }),
  body('rationale_text').isString().isLength({ min: 10, max: 1000 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { new_fee_bps, new_creator_share_bps, rationale_text } = req.body;
    const proposerPublicKey = req.wallet.publicKey;

    try {
      if (req.wallet.type === 'freighter') {
        const unsignedXdr = await buildUnsignedProposal({
          proposerPublicKey,
          newFeeBps: new_fee_bps,
          newCreatorShareBps: new_creator_share_bps,
        });
        const prepareToken = jwt.sign(
          {
            action: 'propose',
            sourcePublicKey: proposerPublicKey,
            newFeeBps: new_fee_bps,
            newCreatorShareBps: new_creator_share_bps,
            rationaleText: rationale_text,
            unsignedXdr,
          },
          process.env.JWT_SECRET,
          { expiresIn: GOVERNANCE_PREPARE_TOKEN_TTL }
        );
        return res.status(200).json({ mode: 'prepare', unsigned_xdr: unsignedXdr, prepare_token: prepareToken });
      }

      const proposal = await withDecryptedWalletSecret(
        req.wallet.secretEncrypted,
        { userId: req.user.userId, walletPublicKey: proposerPublicKey },
        (secret) => createProposal(proposerPublicKey, new_fee_bps, new_creator_share_bps, rationale_text, secret)
      );

      res.status(201).json({ success: true, proposal });
    } catch (error) {
      logger.error('Failed to create proposal', { error: error.message });

      if (error.message.includes('must hold')) {
        return res.status(403).json({ error: error.message });
      }

      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/submit-signed
 * Finalizes a Freighter-signed proposal creation. Rejects a cross-wallet
 * signature or a signed transaction whose args don't match what was
 * prepared (#802).
 */
router.post('/proposals/submit-signed',
  requireAuth,
  body('prepare_token').isString(),
  body('signed_xdr').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const decoded = verifyPrepareToken(req.body.prepare_token, 'propose');

      validateSubmittedContractCallXdr({
        signedXdr: req.body.signed_xdr,
        unsignedXdr: decoded.unsignedXdr,
        expectedSourcePublicKey: decoded.sourcePublicKey,
      });

      const proposal = await createProposalFromSignedXdr({
        signedXdr: req.body.signed_xdr,
        proposerPublicKey: decoded.sourcePublicKey,
        newFeeBps: decoded.newFeeBps,
        newCreatorShareBps: decoded.newCreatorShareBps,
        rationaleText: decoded.rationaleText,
      });

      res.status(201).json({ success: true, proposal });
    } catch (error) {
      if (error.isValidationError || error.statusCode === 422) {
        return res.status(422).json({ error: error.message });
      }
      logger.error('Failed to submit signed proposal', { error: error.message });
      if (error.message.includes('must hold')) {
        return res.status(403).json({ error: error.message });
      }
      next(error);
    }
  }
);

/**
 * POST /api/governance/proposals/:id/execute
 * Execute a proposal (after deadline). Relayed via the platform key — no
 * user-supplied signer, since execute_proposal isn't gated on a specific
 * caller's authorization (#802).
 */
router.post('/proposals/:id/execute',
  requireAuth,
  param('id').isUUID(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const result = await executeProposal(req.params.id, process.env.PLATFORM_SECRET_KEY);

      // Invalidate fee cache after successful execution
      if (result.status === 'executed') {
        invalidateFeeCache();
      }

      res.json({ success: true, execution: result });
    } catch (error) {
      logger.error('Failed to execute proposal', { error: error.message, proposalId: req.params.id });

      if (error.message.includes('not active') || error.message.includes('not found') || error.message.includes('deadline')) {
        return res.status(400).json({ error: error.message });
      }

      next(error);
    }
  }
);

/**
 * GET /api/governance/fee
 * Get current fee from cache + contract ID for verification
 */
router.get('/fee', async (req, res, next) => {
  try {
    const feeInfo = await getFeeRegistryInfo();
    res.json(feeInfo);
  } catch (error) {
    logger.error('Failed to get fee info', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/user/token-balance
 * Get current user's governance token balance
 */
router.get('/user/token-balance', requireAuth, attachWallet, async (req, res, next) => {
  try {
    const publicKey = req.wallet.publicKey;
    const balance = await getUserTokenBalance(publicKey);
    const canPropose = balance >= 1000;

    res.json({
      balance,
      can_propose: canPropose,
      min_required: 1000,
    });
  } catch (error) {
    logger.error('Failed to get user token balance', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/governance/sync
 * Sync proposal data from on-chain (admin/internal use)
 */
router.post('/sync', async (req, res, next) => {
  try {
    await syncProposalData();
    res.json({ success: true, message: 'Proposal data synced' });
  } catch (error) {
    logger.error('Failed to sync proposal data', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/user/vote-weight
 * Get the current user's effective vote weight, including delegated power (#735).
 */
router.get('/user/vote-weight', requireAuth, attachWallet, async (req, res, next) => {
  try {
    const publicKey = req.wallet.publicKey;
    const [weight, delegate] = await Promise.all([
      getEffectiveVoteWeight(publicKey),
      getDelegateForWallet(publicKey),
    ]);

    res.json({
      effective_vote_weight: weight,
      own_balance: await getUserTokenBalance(publicKey),
      delegate_public_key: delegate ? delegate.delegate_public_key : null,
    });
  } catch (error) {
    logger.error('Failed to get effective vote weight', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/governance/delegations
 * Get the current user's active delegation edge (if any).
 */
router.get('/delegations', requireAuth, attachWallet, async (req, res, next) => {
  try {
    const delegate = await getDelegateForWallet(req.wallet.publicKey);
    res.json({ delegation: delegate });
  } catch (error) {
    logger.error('Failed to get delegation', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/governance/delegations
 * Delegate the current user's governance voting power to another wallet.
 */
router.post('/delegations',
  requireAuth,
  attachWallet,
  body('delegate_public_key').isString().notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const delegation = await setVoteDelegation(
        req.wallet.publicKey,
        req.body.delegate_public_key
      );
      res.status(201).json({ success: true, delegation });
    } catch (error) {
      if (error.code === 'INVALID_DELEGATION') {
        return res.status(400).json({ error: error.message });
      }
      logger.error('Failed to set delegation', { error: error.message });
      next(error);
    }
  }
);

/**
 * DELETE /api/governance/delegations
 * Revoke the current user's vote delegation.
 */
router.delete('/delegations', requireAuth, attachWallet, async (req, res, next) => {
  try {
    const removed = await revokeVoteDelegation(req.wallet.publicKey);
    res.json({ success: true, revoked: removed });
  } catch (error) {
    logger.error('Failed to revoke delegation', { error: error.message });
    next(error);
  }
});

module.exports = router;
