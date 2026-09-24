const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const proxyquire = require('proxyquire').noCallThru();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-impersonation-unit-test-jwt-secret-32';

let queryCalls;

const targetUser = {
  id: 'user-2',
  email: 'user@example.com',
  name: 'Debug User',
  role: 'creator',
  is_admin: false,
  is_banned: false,
};

beforeEach(() => {
  queryCalls = [];
});

const mockQuery = async (text, params = []) => {
  queryCalls.push({ text, params });

  if (text.includes('SELECT id, email, name, role, is_admin, is_banned')) {
    return { rows: [targetUser] };
  }

  if (text.includes('INSERT INTO admin_actions')) {
    return { rows: [] };
  }

  return { rows: [] };
};

function buildApp({
  user = { userId: 'admin-1', is_admin: true, role: 'admin' },
  impersonation = null,
} = {}) {
  const adminRouter = proxyquire('./admin', {
    '../config/database': { query: mockQuery },
    '../config/logger': { error: () => {}, info: () => {} },
    '../config/stellar': {
      server: {
        ledgers: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({ records: [] }),
            }),
          }),
        }),
        feeStats: async () => ({}),
      },
    },
    '../services/reconciliation': {
      reconcileSingleCampaign: async () => ({}),
      getRecentReconciliationRuns: () => [],
    },
    '../services/webhookDispatcher': {
      processDelivery: async () => {},
      processCampaignWebhookDelivery: async () => {},
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    '../middleware/auth': {
      IMPERSONATION_TOKEN_COOKIE_NAME: 'cp_impersonation_token',
      requireAuth: (req, _res, next) => {
        req.user = user;
        if (impersonation) {
          req.impersonation = impersonation;
          req.auth = { kind: 'jwt', impersonated: true };
        }
        next();
      },
      requireAdmin: (req, res, next) => {
        if (!req.user?.is_admin) {
          return res.status(403).json({ error: 'Requires admin privileges' });
        }
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

function buildRealAuthMiddleware(dbQueryImpl) {
  return proxyquire('../middleware/auth', {
    '../config/database': { query: dbQueryImpl },
    '@sentry/node': { setUser: () => {} },
    '../services/apiKeyService': { authenticateCpkApiKey: async () => null },
  });
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

/** Runs requireAuth and resolves whether it calls next() or short-circuits via res.json(). */
function runRequireAuth(requireAuth, req) {
  const res = mockRes();
  return new Promise((resolve) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      originalJson(body);
      resolve(res);
    };
    requireAuth(req, res, () => resolve(res));
  });
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/admin/impersonate/:userId returns a 15-minute impersonation token', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/impersonate/${targetUser.id}`, {
      method: 'POST',
    });

    assert.equal(res.status, 201);

    const body = await res.json();
    const decoded = jwt.verify(body.token, process.env.JWT_SECRET);
    assert.equal(decoded.userId, targetUser.id);
    assert.equal(decoded.impersonated_by, 'admin-1');
    assert.equal(decoded.impersonation, true);
    assert.equal(decoded.sub, targetUser.id.toString());
    assert.equal(decoded.iss, 'https://crowdpay.io');
    assert.equal(decoded.aud, 'crowdpay-api');
    assert.ok(decoded.exp - decoded.iat <= 900);

    assert.equal(body.expires_in, 900);
    assert.equal(body.user.id, targetUser.id);
    assert.match(res.headers.get('set-cookie'), /cp_impersonation_token=/);

    const auditCall = queryCalls.find((call) => call.params[1] === 'impersonate_start');
    assert.ok(auditCall);
    assert.equal(auditCall.params[0], 'admin-1');
    assert.equal(auditCall.params[3], targetUser.id);
  });
});

test('POST /api/admin/impersonate/exit clears cookie and logs the end event', async () => {
  const impersonation = { adminUserId: 'admin-1', targetUserId: targetUser.id };
  const user = {
    userId: targetUser.id,
    role: 'creator',
    impersonated_by: 'admin-1',
  };

  await withServer(buildApp({ user, impersonation }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/impersonate/exit`, {
      method: 'POST',
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /cp_impersonation_token=/);

    const auditCall = queryCalls.find((call) => call.params[1] === 'impersonate_end');
    assert.ok(auditCall);
    assert.equal(auditCall.params[0], 'admin-1');
    assert.equal(auditCall.params[3], targetUser.id);
  });
});

test('an impersonation token issued by admin.js authenticates against the real middleware, is scoped, and is audited', async () => {
  // Mint the token through the real route handler (not a hand-rolled jwt.sign call),
  // so this test would have caught the missing sub/iss/aud regression.
  const mintedToken = await withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/impersonate/${targetUser.id}`, { method: 'POST' });
    const body = await res.json();
    return body.token;
  });

  const authQueryCalls = [];
  const authDbQuery = async (text, params = []) => {
    authQueryCalls.push({ text, params });
    if (text.includes('SELECT role, is_admin, is_banned FROM users')) {
      return { rows: [{ role: targetUser.role, is_admin: false, is_banned: false }] };
    }
    return { rows: [] };
  };
  const { requireAuth } = buildRealAuthMiddleware(authDbQuery);

  // A normal read is allowed and correctly identifies the impersonated session.
  const readReq = {
    cookies: { cp_impersonation_token: mintedToken },
    headers: {},
    method: 'GET',
    originalUrl: '/api/campaigns',
  };
  const readRes = await runRequireAuth(requireAuth, readReq);

  assert.equal(readRes.statusCode, 0, 'requireAuth must call next(), not respond, for an allowed GET');
  assert.equal(readReq.user.userId, targetUser.id);
  assert.equal(readReq.user.is_admin, false, 'admin rights are stripped while impersonating');
  assert.deepEqual(readReq.impersonation, { adminUserId: 'admin-1', targetUserId: targetUser.id });

  const auditCall2 = authQueryCalls.find((c) => c.params[1] === 'impersonated_request');
  assert.ok(auditCall2, 'every impersonated request is audit-logged');
  assert.equal(auditCall2.params[0], 'admin-1');
  assert.equal(auditCall2.params[3], targetUser.id);

  // A restricted action (write to a sensitive, wallet-signing-adjacent path) is blocked.
  authQueryCalls.length = 0;
  const writeReq = {
    cookies: { cp_impersonation_token: mintedToken },
    headers: {},
    method: 'POST',
    originalUrl: '/api/governance/proposals',
  };
  const writeRes = await runRequireAuth(requireAuth, writeReq);

  assert.equal(writeRes.statusCode, 403);
  assert.deepEqual(writeRes.body, { error: 'Impersonation mode cannot perform this action' });

  // Retained 15-minute lifetime.
  const decoded = jwt.decode(mintedToken);
  assert.equal(decoded.exp - decoded.iat, 900);
});
