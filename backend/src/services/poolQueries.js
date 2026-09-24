const db = require('../config/database');
const { submitCustodialContribution } = require('./contributionService');

function poolError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * List all pools for a campaign (public).
 */
async function listByCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT cp.*, 
       COALESCE(member_counts.member_count, 0) AS member_count
     FROM contribution_pools cp
     LEFT JOIN (
       SELECT pool_id, COUNT(*) AS member_count 
       FROM pool_members WHERE status = 'confirmed'
       GROUP BY pool_id
     ) member_counts ON member_counts.pool_id = cp.id
     WHERE cp.campaign_id = $1
     ORDER BY cp.created_at DESC`,
    [campaignId]
  );
  return rows;
}

/**
 * List pools the user is involved in (as leader or member).
 */
async function listByUser(userId) {
  const { rows } = await db.query(
    `SELECT cp.*, c.title AS campaign_title,
       COALESCE(member_counts.member_count, 0) AS member_count
     FROM contribution_pools cp
     JOIN campaigns c ON c.id = cp.campaign_id
     LEFT JOIN (
       SELECT pool_id, COUNT(*) AS member_count 
       FROM pool_members WHERE status = 'confirmed'
       GROUP BY pool_id
     ) member_counts ON member_counts.pool_id = cp.id
     WHERE cp.leader_id = $1
        OR cp.id IN (SELECT pool_id FROM pool_members WHERE user_id = $1)
     ORDER BY cp.updated_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Get a single pool with its members.
 */
async function getById(poolId) {
  const { rows } = await db.query(
    `SELECT cp.*, 
       COALESCE(member_counts.member_count, 0) AS member_count
     FROM contribution_pools cp
     LEFT JOIN (
       SELECT pool_id, COUNT(*) AS member_count 
       FROM pool_members WHERE status = 'confirmed'
       GROUP BY pool_id
     ) member_counts ON member_counts.pool_id = cp.id
     WHERE cp.id = $1`,
    [poolId]
  );
  if (rows.length === 0) return null;

  const { rows: members } = await db.query(
    `SELECT pm.*, u.name, u.wallet_public_key
     FROM pool_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.pool_id = $1
     ORDER BY pm.created_at ASC`,
    [poolId]
  );

  return { ...rows[0], members };
}

/**
 * Create a new pool (leader is the creator).
 */
async function create({ campaign_id, leader_id, title, description, target_amount, expires_at }) {
  const { rows } = await db.query(
    `INSERT INTO contribution_pools (campaign_id, leader_id, title, description, target_amount, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [campaign_id, leader_id, title, description, target_amount, expires_at]
  );
  return rows[0];
}

/**
 * Join a pool with a share amount. Runs inside a transaction with the pool
 * row locked (`FOR UPDATE`) so concurrent joins for the same pool serialize:
 * the remaining-capacity check can't be jointly overshot, and a duplicate
 * membership insert is caught by the `pool_members(pool_id, user_id)` unique
 * constraint via `ON CONFLICT DO NOTHING` rather than a racy check-then-insert.
 * Members are inserted directly as 'confirmed' — joining a pool is committing
 * to a share; the existing `leave` endpoint is the opt-out path.
 */
async function join({ pool_id, user_id, share_amount, display_name }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: poolRows } = await client.query(
      `SELECT * FROM contribution_pools WHERE id = $1 AND status = 'open' FOR UPDATE`,
      [pool_id]
    );
    if (poolRows.length === 0) {
      throw poolError('Pool is not open or does not exist', 404);
    }
    const pool = poolRows[0];

    const { rows: totalRows } = await client.query(
      `SELECT COALESCE(SUM(share_amount), 0) AS total FROM pool_members WHERE pool_id = $1 AND status IN ('pending', 'confirmed')`,
      [pool_id]
    );
    const remaining = parseFloat(pool.target_amount) - parseFloat(totalRows[0].total);
    if (parseFloat(share_amount) > remaining) {
      throw poolError(`Share amount exceeds remaining pool target. Remaining: ${remaining}`, 400);
    }

    const { rows } = await client.query(
      `INSERT INTO pool_members (pool_id, user_id, share_amount, display_name, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (pool_id, user_id) DO NOTHING
       RETURNING *`,
      [pool_id, user_id, share_amount, display_name]
    );
    if (rows.length === 0) {
      throw poolError('Already a member of this pool', 409);
    }

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Leave a pool (remove membership).
 */
async function leave(poolId, userId) {
  // Cannot leave if you are the leader — must cancel pool instead
  const pool = await db.query(
    `SELECT leader_id FROM contribution_pools WHERE id = $1`,
    [poolId]
  );
  if (pool.rows.length === 0) throw new Error('Pool not found');
  if (pool.rows[0].leader_id === userId) {
    throw new Error('Pool leader cannot leave. Cancel the pool instead.');
  }

  const { rowCount } = await db.query(
    `DELETE FROM pool_members WHERE pool_id = $1 AND user_id = $2`,
    [poolId, userId]
  );
  if (rowCount === 0) throw new Error('Not a member of this pool');
}

/**
 * Update pool settings (leader only).
 */
async function update(poolId, userId, fields) {
  const pool = await db.query(
    `SELECT leader_id, status FROM contribution_pools WHERE id = $1`,
    [poolId]
  );
  if (pool.rows.length === 0) return null;
  if (pool.rows[0].leader_id !== userId) return null;
  if (pool.rows[0].status !== 'open') throw new Error('Can only edit open pools');

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (['title', 'description', 'target_amount', 'status', 'expires_at'].includes(key)) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    return getById(poolId);
  }

  values.push(poolId);
  const { rows } = await db.query(
    `UPDATE contribution_pools SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0];
}

/**
 * Submit the pooled contribution as a single Stellar payment from the leader.
 *
 * Two phases:
 *  1. Under a row lock, validate and atomically claim the pool by moving it
 *     to 'submitting' — this is the guard against a double-submit race, and
 *     it happens before any (slow, external) Stellar call.
 *  2. Outside the transaction, resolve the leader's wallet and submit via the
 *     same `submitCustodialContribution` used by the main contribution route.
 *     On success the pool becomes 'submitted' and every confirmed member is
 *     stamped `contributed_at`. On any failure the pool is rolled back to its
 *     pre-claim status so it can be retried — it is never left 'submitting'
 *     or marked 'submitted' for a payment that didn't actually go through.
 *
 * Scope note (#804): only a custodial leader wallet is supported for now — a
 * Freighter leader gets a clear 422 rather than a half-built signing flow.
 */
async function submitPool(poolId, userId) {
  const client = await db.connect();
  let priorStatus;
  let members;
  let totalAmount;
  let campaignId;
  try {
    await client.query('BEGIN');

    const { rows: poolRows } = await client.query(
      `SELECT * FROM contribution_pools WHERE id = $1 FOR UPDATE`,
      [poolId]
    );
    if (poolRows.length === 0) throw poolError('Pool not found', 404);
    const pool = poolRows[0];
    if (pool.leader_id !== userId) throw poolError('Only the pool leader can submit', 403);
    if (!['open', 'closed'].includes(pool.status)) {
      throw poolError('Pool is not open', 409);
    }

    const { rows: memberRows } = await client.query(
      `SELECT * FROM pool_members WHERE pool_id = $1 AND status = 'confirmed'`,
      [poolId]
    );
    if (memberRows.length === 0) throw poolError('No confirmed members in the pool', 400);

    const total = memberRows.reduce((sum, m) => sum + parseFloat(m.share_amount), 0);
    if (total <= 0) throw poolError('Total pool amount must be positive', 400);

    await client.query(
      `UPDATE contribution_pools SET status = 'submitting', updated_at = NOW() WHERE id = $1`,
      [poolId]
    );
    await client.query('COMMIT');

    priorStatus = pool.status;
    members = memberRows;
    totalAmount = total;
    campaignId = pool.campaign_id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  try {
    const { rows: leaderRows } = await db.query(
      'SELECT wallet_public_key, wallet_secret_encrypted, wallet_type FROM users WHERE id = $1',
      [userId]
    );
    const leader = leaderRows[0];
    if (!leader || leader.wallet_type !== 'custodial') {
      throw poolError('Pool submission currently requires a custodial wallet for the leader', 422);
    }

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, asset_type, wallet_public_key, escrow_contract_id, status FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const campaign = campaignRows[0];
    if (!campaign || campaign.status !== 'active') {
      throw poolError('Campaign is not active', 400);
    }

    const result = await submitCustodialContribution({
      campaign,
      campaignId: campaign.id,
      userId,
      walletPublicKey: leader.wallet_public_key,
      walletSecretEncrypted: leader.wallet_secret_encrypted,
      amount: totalAmount,
      sendAsset: campaign.asset_type,
      displayName: 'Pool contribution',
    });

    const finalizeClient = await db.connect();
    try {
      await finalizeClient.query('BEGIN');
      await finalizeClient.query(
        `UPDATE contribution_pools SET status = 'submitted', raised_amount = $1, tx_hash = $2, updated_at = NOW() WHERE id = $3`,
        [totalAmount, result.txHash, poolId]
      );
      await finalizeClient.query(
        `UPDATE pool_members SET contributed_at = NOW() WHERE pool_id = $1 AND status = 'confirmed'`,
        [poolId]
      );
      await finalizeClient.query('COMMIT');
    } catch (err) {
      await finalizeClient.query('ROLLBACK');
      throw err;
    } finally {
      finalizeClient.release();
    }

    return {
      pool_id: poolId,
      total_amount: totalAmount,
      member_count: members.length,
      tx_hash: result.txHash,
    };
  } catch (err) {
    await db.query(
      `UPDATE contribution_pools SET status = $1, updated_at = NOW() WHERE id = $2 AND status = 'submitting'`,
      [priorStatus, poolId]
    );
    throw err;
  }
}

module.exports = {
  listByCampaign,
  listByUser,
  getById,
  create,
  join,
  leave,
  update,
  submitPool,
};
