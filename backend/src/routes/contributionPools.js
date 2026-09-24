const express = require('express');
const { body, param, query } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { validateRequest: validate } = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const poolQueries = require('../services/poolQueries');

const router = express.Router();

// ── Validation ──────────────────────────────────────────────────────────────

const createPoolValidation = [
  body('campaign_id').isUUID().withMessage('Valid campaign ID is required'),
  body('title').trim().isLength({ min: 1, max: 200 }).withMessage('Title is required (max 200 chars)'),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('target_amount').isFloat({ min: 0.01 }).withMessage('Target amount must be at least 0.01'),
  body('expires_at').optional().isISO8601().withMessage('Expiry must be a valid ISO date'),
];

const joinPoolValidation = [
  param('poolId').isUUID().withMessage('Valid pool ID is required'),
  body('share_amount').isFloat({ min: 0.01 }).withMessage('Share amount must be at least 0.01'),
  body('display_name').optional().trim().isLength({ max: 50 }),
];

const updatePoolValidation = [
  param('poolId').isUUID().withMessage('Valid pool ID is required'),
  body('title').optional().trim().isLength({ min: 1, max: 200 }),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('target_amount').optional().isFloat({ min: 0.01 }),
  body('status').optional().isIn(['open', 'closed', 'cancelled']),
];

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/contribution-pools/campaign/:campaignId — list pools for a campaign
router.get(
  '/campaign/:campaignId',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const pools = await poolQueries.listByCampaign(campaignId);
    res.json({ success: true, data: pools });
  })
);

// GET /api/contribution-pools/mine — list pools the current user is in or leads
router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const pools = await poolQueries.listByUser(req.user.userId);
    res.json({ success: true, data: pools });
  })
);

// GET /api/contribution-pools/:poolId — get pool details with members
router.get(
  '/:poolId',
  asyncHandler(async (req, res) => {
    const pool = await poolQueries.getById(req.params.poolId);
    if (!pool) return res.status(404).json({ success: false, error: 'Pool not found' });
    res.json({ success: true, data: pool });
  })
);

// POST /api/contribution-pools — create a new pool
router.post(
  '/',
  requireAuth,
  createPoolValidation,
  validate,
  asyncHandler(async (req, res) => {
    const pool = await poolQueries.create({
      campaign_id: req.body.campaign_id,
      leader_id: req.user.userId,
      title: req.body.title,
      description: req.body.description || null,
      target_amount: req.body.target_amount,
      expires_at: req.body.expires_at || null,
    });
    res.status(201).json({ success: true, data: pool });
  })
);

// POST /api/contribution-pools/:poolId/join — join a pool with a share amount
router.post(
  '/:poolId/join',
  requireAuth,
  joinPoolValidation,
  validate,
  asyncHandler(async (req, res) => {
    const membership = await poolQueries.join({
      pool_id: req.params.poolId,
      user_id: req.user.userId,
      share_amount: req.body.share_amount,
      display_name: req.body.display_name || null,
    });
    res.status(201).json({ success: true, data: membership });
  })
);

// POST /api/contribution-pools/:poolId/leave — leave a pool
router.post(
  '/:poolId/leave',
  requireAuth,
  asyncHandler(async (req, res) => {
    await poolQueries.leave(req.params.poolId, req.user.userId);
    res.json({ success: true });
  })
);

// PATCH /api/contribution-pools/:poolId — update pool (leader only)
router.patch(
  '/:poolId',
  requireAuth,
  updatePoolValidation,
  validate,
  asyncHandler(async (req, res) => {
    const pool = await poolQueries.update(req.params.poolId, req.user.userId, req.body);
    if (!pool) return res.status(403).json({ success: false, error: 'Not authorized or pool not found' });
    res.json({ success: true, data: pool });
  })
);

// POST /api/contribution-pools/:poolId/submit — leader submits the pooled contribution
router.post(
  '/:poolId/submit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await poolQueries.submitPool(req.params.poolId, req.user.userId);
    res.json({ success: true, data: result });
  })
);

module.exports = router;
