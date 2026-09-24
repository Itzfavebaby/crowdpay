const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { errorHandler } = require('../middleware/errorHandler');

function buildApp({ userId = 'user-1', poolQueriesImpl = {} } = {}) {
  const calls = [];
  const poolQueriesStub = {
    listByCampaign: async () => [],
    listByUser: async (id) => {
      calls.push(['listByUser', id]);
      return [];
    },
    getById: async () => ({ id: 'pool-1' }),
    create: async (fields) => {
      calls.push(['create', fields]);
      return { id: 'pool-1', ...fields };
    },
    join: async (fields) => {
      calls.push(['join', fields]);
      return { id: 'member-1', ...fields };
    },
    leave: async (poolId, userId2) => {
      calls.push(['leave', poolId, userId2]);
    },
    update: async (poolId, userId2, body) => {
      calls.push(['update', poolId, userId2, body]);
      return { id: poolId };
    },
    submitPool: async (poolId, userId2) => {
      calls.push(['submitPool', poolId, userId2]);
      return { pool_id: poolId, total_amount: 100, member_count: 2, tx_hash: 'txhash' };
    },
    ...poolQueriesImpl,
  };

  const router = proxyquire('./contributionPools', {
    '../services/poolQueries': poolQueriesStub,
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId };
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contribution-pools', router);
  app.use(errorHandler);
  return { app, calls };
}

const VALID_POOL_ID = '11111111-1111-4111-8111-111111111111';
const VALID_CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';

test('GET /api/contribution-pools/mine uses req.user.userId, not req.user.id', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app).get('/api/contribution-pools/mine');
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['listByUser', 'user-42']]);
});

test('POST /api/contribution-pools sets leader_id from req.user.userId', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app)
    .post('/api/contribution-pools')
    .send({ campaign_id: VALID_CAMPAIGN_ID, title: 'Group gift', target_amount: 50 });

  assert.equal(res.status, 201);
  const [, fields] = calls[0];
  assert.equal(fields.leader_id, 'user-42');
});

test('POST /api/contribution-pools/:poolId/join sets user_id from req.user.userId', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app)
    .post(`/api/contribution-pools/${VALID_POOL_ID}/join`)
    .send({ share_amount: 10 });

  assert.equal(res.status, 201);
  const [, fields] = calls[0];
  assert.equal(fields.user_id, 'user-42');
});

test('POST /api/contribution-pools/:poolId/leave passes req.user.userId', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app).post(`/api/contribution-pools/${VALID_POOL_ID}/leave`);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['leave', VALID_POOL_ID, 'user-42']]);
});

test('PATCH /api/contribution-pools/:poolId passes req.user.userId', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app).patch(`/api/contribution-pools/${VALID_POOL_ID}`).send({ title: 'New title' });
  assert.equal(res.status, 200);
  assert.equal(calls[0][2], 'user-42');
});

test('POST /api/contribution-pools/:poolId/submit passes req.user.userId and surfaces a service error status code', async () => {
  const { app, calls } = buildApp({ userId: 'user-42' });
  const res = await request(app).post(`/api/contribution-pools/${VALID_POOL_ID}/submit`);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['submitPool', VALID_POOL_ID, 'user-42']]);
});

test('POST /api/contribution-pools/:poolId/submit propagates a poolQueries error status code (e.g. Freighter-leader 422)', async () => {
  const { app } = buildApp({
    poolQueriesImpl: {
      submitPool: async () => {
        const err = new Error('Pool submission currently requires a custodial wallet for the leader');
        err.statusCode = 422;
        throw err;
      },
    },
  });
  const res = await request(app).post(`/api/contribution-pools/${VALID_POOL_ID}/submit`);
  assert.equal(res.status, 422);
});
