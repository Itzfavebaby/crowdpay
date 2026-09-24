const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmail } = require('./emailService');
const { safeFetch } = require('../utils/safeFetch');

const WEBHOOK_EVENTS = {
  CAMPAIGN_FUNDED: 'campaign.funded',
  CAMPAIGN_FAILED: 'campaign.failed',
  CONTRIBUTION_RECEIVED: 'contribution.received',
  CONTRIBUTION_INDEXED: 'contribution.indexed', // campaign-level event
  CONTRIBUTION_REFUNDED: 'contribution.refunded',
  MILESTONE_APPROVED: 'milestone.approved',
  MILESTONE_REJECTED: 'milestone.rejected',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
  WITHDRAWAL_UPDATED: 'withdrawal.updated',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  SPONSOR_MATCH_CREATED: 'sponsor_match.created',
  SPONSOR_MATCH_COMPLETED: 'sponsor_match.completed',
};

const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000];

function hmacSignature(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function isValidBackoffStrategy(strategy) {
  return Boolean(
    strategy &&
    typeof strategy === 'object' &&
    Number.isFinite(strategy.base_ms) &&
    strategy.base_ms > 0 &&
    Number.isFinite(strategy.max_ms) &&
    strategy.max_ms > 0 &&
    Number.isFinite(strategy.multiplier) &&
    strategy.multiplier > 0
  );
}

function customBackoffMs(attemptNumber, strategy) {
  const delay = strategy.base_ms * strategy.multiplier ** Math.max(0, attemptNumber - 1);
  return Math.min(strategy.max_ms, Math.round(delay));
}

function backoffMs(attemptNumber, strategy) {
  if (isValidBackoffStrategy(strategy)) return customBackoffMs(attemptNumber, strategy);
  const boundedAttempt = Math.min(Math.max(attemptNumber, 1), WEBHOOK_RETRY_DELAYS_MS.length);
  return WEBHOOK_RETRY_DELAYS_MS[boundedAttempt - 1];
}

function backoffMsForCampaign(attemptNumber, strategy) {
  if (isValidBackoffStrategy(strategy)) return customBackoffMs(attemptNumber, strategy);
  // Campaign webhooks: exponential backoff (5s, 30s, 5min)
  const delays = [5000, 30000, 300000];
  return delays[Math.min(attemptNumber - 1, delays.length - 1)];
}

/** Queue outbound webhook deliveries for every active endpoint owned by `ownerUserId`. */
async function emitWebhookEventForUser(ownerUserId, eventType, payload) {
  if (!ownerUserId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM webhooks
     WHERE user_id = $1 AND revoked_at IS NULL AND $2 = ANY(events)`,
    [ownerUserId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processDelivery(deliveryId).catch((err) =>
        logger.error('[webhooks] delivery failed', { deliveryId, err: err.message })
      );
    });
  }
}

async function processDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event_type,
            w.url, w.secret, w.revoked_at, w.backoff_strategy
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.revoked_at) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook revoked', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const sig = hmacSignature(row.secret, bodyUtf8);

  await db.query(
    `UPDATE webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    // Re-validates and pins the connection target on every hop (including
    // redirects), so neither DNS rebinding between validation and connection
    // nor a redirect to a private/internal target can bypass the guard.
    res = await safeFetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Event': row.event_type,
        'X-CrowdPay-Delivery-Id': deliveryId,
      },
      body: bodyUtf8,
      timeoutMs: 9000,
    });
    responseText = await res.text();
  } catch (err) {
    if (err.isSsrfBlocked) {
      await db.query(
        `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [deliveryId, err.message]
      );
      return;
    }
    await scheduleRetry(deliveryId, nextAttempt, err.message || String(err), null, null, row.backoff_strategy);
    return;
  }

  const snippet = responseText.slice(0, 512);
  if (res.ok) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', response_status = $2, response_body_snippet = $3,
           delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status, snippet]
    );
    return;
  }

  await scheduleRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status,
    snippet,
    row.backoff_strategy
  );
}

async function notifyCreatorOfFailedDelivery(deliveryId, errMsg) {
  try {
    const { rows } = await db.query(
      `SELECT u.email, u.name, w.url, d.event_type
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       JOIN users u ON u.id = w.user_id
       WHERE d.id = $1`,
      [deliveryId]
    );

    if (!rows.length || !rows[0].email) return;

    const row = rows[0];
    const subject = 'Webhook delivery failed after retries';
    const text = `Hi ${row.name || 'there'},\n\nWe could not deliver your webhook for ${row.event_type} to ${row.url} after all retries. Last error: ${errMsg || 'unknown'}.`;
    await sendEmail({
      to: row.email,
      subject,
      text,
    });
  } catch (emailErr) {
    logger.error('[webhooks] failed to notify creator', { deliveryId, err: emailErr.message });
  }
}

async function scheduleRetry(deliveryId, attemptJustUsed, errMsg, httpStatus, snippet, backoffStrategy) {
  if (attemptJustUsed >= MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, response_body_snippet = $4, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus, snippet]
    );
    await notifyCreatorOfFailedDelivery(deliveryId, errMsg);
    return;
  }

  const delay = backoffMs(attemptJustUsed, backoffStrategy);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, response_body_snippet = $5, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus, snippet]
  );

  setTimeout(() => {
    processDelivery(deliveryId).catch((err) =>
      logger.error('[webhooks] retry failed', { deliveryId, err: err.message })
    );
  }, delay);
}

async function processDueRetries() {
  const { rows } = await db.query(
    `SELECT id FROM webhook_deliveries
     WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     LIMIT 25`
  );
  for (const r of rows) {
    processDelivery(r.id).catch((err) =>
      logger.error('[webhooks] poller delivery failed', { deliveryId: r.id, err: err.message })
    );
  }
}

/** Queue outbound webhook deliveries for campaign webhooks */
async function emitWebhookEventForCampaign(campaignId, eventType, payload) {
  if (!campaignId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM campaign_webhooks
     WHERE campaign_id = $1 AND active = TRUE AND $2 = ANY(events)`,
    [campaignId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_webhook_deliveries (webhook_id, event, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processCampaignWebhookDelivery(deliveryId).catch((err) =>
        logger.error('[campaign-webhooks] delivery failed', { deliveryId, err: err.message })
      );
    });
  }
}

async function processCampaignWebhookDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event,
            w.url, w.secret, w.active, w.backoff_strategy
     FROM campaign_webhook_deliveries d
     JOIN campaign_webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (!row.active) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = 'webhook disabled', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const sig = hmacSignature(row.secret, bodyUtf8);

  await db.query(
    `UPDATE campaign_webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  try {
    // Re-validates and pins the connection target on every hop (including
    // redirects), so neither DNS rebinding between validation and connection
    // nor a redirect to a private/internal target can bypass the guard.
    res = await safeFetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Event': row.event,
        'X-CrowdPay-Delivery-Id': deliveryId,
      },
      body: bodyUtf8,
      timeoutMs: 9000,
    });
  } catch (err) {
    if (err.isSsrfBlocked) {
      await db.query(
        `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [deliveryId, err.message]
      );
      return;
    }
    await scheduleCampaignWebhookRetry(
      deliveryId,
      nextAttempt,
      err.message || String(err),
      null,
      row.backoff_strategy
    );
    return;
  }

  if (res.ok) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'delivered', response_status = $2, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status]
    );
    return;
  }

  await scheduleCampaignWebhookRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status,
    row.backoff_strategy
  );
}

async function scheduleCampaignWebhookRetry(deliveryId, attemptJustUsed, errMsg, httpStatus, backoffStrategy) {
  if (attemptJustUsed >= MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, failed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus]
    );
    return;
  }

  const delay = backoffMsForCampaign(attemptJustUsed, backoffStrategy);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE campaign_webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus]
  );

  setTimeout(() => {
    processCampaignWebhookDelivery(deliveryId).catch((err) =>
      logger.error('[campaign-webhooks] retry failed', { deliveryId, err: err.message })
    );
  }, delay);
}

async function processDueCampaignWebhookRetries() {
  const { rows } = await db.query(
    `SELECT id FROM campaign_webhook_deliveries
     WHERE status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     LIMIT 25`
  );
  for (const r of rows) {
    processCampaignWebhookDelivery(r.id).catch((err) =>
      logger.error('[campaign-webhooks] poller delivery failed', { deliveryId: r.id, err: err.message })
    );
  }
}

function startWebhookRetryPoller() {
  setInterval(() => {
    processDueRetries().catch((e) => logger.error('[webhooks] poller error', { err: e.message }));
    processDueCampaignWebhookRetries().catch((e) => logger.error('[campaign-webhooks] poller error', { err: e.message }));
  }, 5000);
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_WEBHOOK_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  hmacSignature,
  backoffMs,
  backoffMsForCampaign,
  isValidBackoffStrategy,
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  processDelivery,
  processCampaignWebhookDelivery,
  startWebhookRetryPoller,
};
