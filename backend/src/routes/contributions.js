const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { contributionValidation, validateRequest } = require('../middleware/validation');
const { contributionRateLimiter } = require('../middleware/contributionRateLimiter');
const contributionService = require('../services/contributionService');
const stellarService = require('../services/stellarService');
const embedTokenService = require('../services/embedTokenService');
const { resolveReferralLink } = require('../services/referral');
const { getReferralCodeFromRequest } = require('../services/referralService');
const { reserveTierSlot } = require('../services/rewardTierService');
const { assertUserKycVerified } = require('../services/kycService');
const db = require('../config/database');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');

async function resolveContributorWallet(req) {
  if (req.user?.walletPublicKey && req.user?.walletSecretEncrypted) {
    return {
      walletPublicKey: req.user.walletPublicKey,
      walletSecretEncrypted: req.user.walletSecretEncrypted,
    };
  }

  const { rows } = await db.query(
    'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (!rows.length || !rows[0].wallet_public_key) {
    const err = new Error('User does not have a custodial wallet configured');
    err.statusCode = 400;
    throw err;
  }
  return {
    walletPublicKey: rows[0].wallet_public_key,
    walletSecretEncrypted: rows[0].wallet_secret_encrypted,
  };
}

router.post(
  '/',
  requireAuth,
  contributionRateLimiter,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, tier_id, display_name, idempotency_key } = req.body;
    const userId = req.user.userId;

    await assertUserKycVerified(userId);

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    const { walletPublicKey, walletSecretEncrypted } = await resolveContributorWallet(req);

    const referralCode = getReferralCodeFromRequest(req);
    let referralLink = null;
    if (referralCode) {
      referralLink = await resolveReferralLink({ campaignId: campaign_id, code: referralCode });
    }

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');

      if (tier_id) {
        const reserved = await reserveTierSlot(client, { tierId: tier_id, campaignId: campaign_id });
        if (!reserved) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Reward tier is no longer available' });
        }
      }

      result = await contributionService.submitCustodialContribution({
        campaign,
        campaignId: campaign_id,
        userId,
        walletPublicKey,
        walletSecretEncrypted,
        amount,
        sendAsset: send_asset || campaign.asset_type,
        displayName: display_name,
        referralCode,
        referralLinkCode: referralLink?.code,
        referralLinkId: referralLink?.id,
        tierId: tier_id,
        idempotencyKey: idempotency_key,
        client,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
    });
  })
);

router.post(
  '/embed',
  contributionRateLimiter,
  contributionValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, send_asset, embed_token } = req.body;
    if (!embed_token) {
      return res.status(401).json({ error: 'Embed token required' });
    }
    const tokenPayload = embedTokenService.verifyEmbedToken(embed_token);
    if (!tokenPayload || tokenPayload.campaign_id !== campaign_id) {
      return res.status(403).json({ error: 'Invalid or expired embed token' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status FROM campaigns WHERE id = $1',
      [campaign_id]
    );
    const campaign = campaignRows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    const userId = tokenPayload.user_id;
    const { rows: userRows } = await db.query(
      'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
      [userId]
    );
    const user = userRows[0];
    if (!user || !user.wallet_public_key) {
      return res.status(400).json({ error: 'Contributor wallet not found' });
    }

    const result = await contributionService.submitCustodialContribution({
      campaign,
      campaignId: campaign_id,
      userId,
      walletPublicKey: user.wallet_public_key,
      walletSecretEncrypted: user.wallet_secret_encrypted,
      amount,
      sendAsset: send_asset || campaign.asset_type,
    });

    return res.status(202).json({
      success: true,
      tx_hash: result.txHash,
      contract_mode: Boolean(campaign.escrow_contract_id),
      conversion_quote: result.conversionQuote || null,
    });
  })
);

module.exports = router;
