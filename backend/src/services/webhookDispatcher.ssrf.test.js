const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const proxyquire = require('proxyquire').noCallThru();

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function buildDispatcher({ deliveryRow, campaignDeliveryRow }) {
  const updates = [];
  const query = async (text, params) => {
    if (/SELECT d\.id, d\.attempt_count, d\.status, d\.payload, d\.event_type/.test(text)) {
      return { rows: deliveryRow ? [deliveryRow] : [] };
    }
    if (/SELECT d\.id, d\.attempt_count, d\.status, d\.payload, d\.event\b/.test(text)) {
      return { rows: campaignDeliveryRow ? [campaignDeliveryRow] : [] };
    }
    if (/UPDATE\s+(webhook_deliveries|campaign_webhook_deliveries)\s+SET/.test(text)) {
      updates.push({ text, params });
      return { rows: [] };
    }
    return { rows: [] };
  };

  const dispatcher = proxyquire('./webhookDispatcher', {
    '../config/database': { query },
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './emailService': { sendEmail: async () => {} },
  });

  return { dispatcher, updates };
}

function baseDeliveryRow(url, overrides = {}) {
  return {
    id: 'delivery-1',
    attempt_count: 0,
    status: 'pending',
    payload: { hello: 'world' },
    event_type: 'contribution.received',
    url,
    secret: 'whsec_test',
    revoked_at: null,
    backoff_strategy: null,
    ...overrides,
  };
}

function baseCampaignDeliveryRow(url, overrides = {}) {
  return {
    id: 'campaign-delivery-1',
    attempt_count: 0,
    status: 'pending',
    payload: { hello: 'world' },
    event: 'contribution.indexed',
    url,
    secret: 'whsec_test',
    active: true,
    backoff_strategy: null,
    ...overrides,
  };
}

test('processDelivery delivers to a real endpoint end-to-end through the real SSRF guard and pinned fetch', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      const { dispatcher, updates } = buildDispatcher({ deliveryRow: baseDeliveryRow(`${baseUrl}/hook`) });
      await dispatcher.processDelivery('delivery-1');

      const delivered = updates.find((u) => /status = 'delivered'/.test(u.text));
      assert.ok(delivered, 'delivery should be marked delivered');
      assert.equal(delivered.params[1], 200);
    }
  );
});

test('processDelivery follows a redirect to a public target and still delivers', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('final');
    },
    async (baseUrl) => {
      const { dispatcher, updates } = buildDispatcher({ deliveryRow: baseDeliveryRow(`${baseUrl}/start`) });
      await dispatcher.processDelivery('delivery-1');

      assert.ok(updates.find((u) => /status = 'delivered'/.test(u.text)));
    }
  );
});

test('processDelivery fails closed (never connects) for a delivery URL that is unsafe outright', async () => {
  const { dispatcher, updates } = buildDispatcher({
    deliveryRow: baseDeliveryRow('https://169.254.169.254/latest/meta-data'),
  });

  await dispatcher.processDelivery('delivery-1');

  const failed = updates.find((u) => /status = 'failed'/.test(u.text));
  assert.ok(failed);
  assert.match(failed.params[1], /SSRF guard:.*private\/internal/);
});

test('processDelivery fails closed when the endpoint redirects to a private/internal target', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async (baseUrl) => {
      const { dispatcher, updates } = buildDispatcher({ deliveryRow: baseDeliveryRow(`${baseUrl}/start`) });
      await dispatcher.processDelivery('delivery-1');

      const failed = updates.find((u) => /status = 'failed'/.test(u.text));
      assert.ok(failed, 'delivery should be marked failed, not delivered, when a redirect targets a private address');
      assert.match(failed.params[1], /SSRF guard:.*private\/internal/);
    }
  );
});

// ---------------------------------------------------------------------------
// Campaign webhooks get identical handling (#805 requires both dispatchers
// to apply the same policy).
// ---------------------------------------------------------------------------

test('processCampaignWebhookDelivery delivers to a real endpoint end-to-end', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      const { dispatcher, updates } = buildDispatcher({
        campaignDeliveryRow: baseCampaignDeliveryRow(`${baseUrl}/hook`),
      });
      await dispatcher.processCampaignWebhookDelivery('campaign-delivery-1');

      assert.ok(updates.find((u) => /status = 'delivered'/.test(u.text)));
    }
  );
});

test('processCampaignWebhookDelivery fails closed when the endpoint redirects to a private/internal target', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async (baseUrl) => {
      const { dispatcher, updates } = buildDispatcher({
        campaignDeliveryRow: baseCampaignDeliveryRow(`${baseUrl}/start`),
      });
      await dispatcher.processCampaignWebhookDelivery('campaign-delivery-1');

      const failed = updates.find((u) => /status = 'failed'/.test(u.text));
      assert.ok(failed);
      assert.match(failed.params[1], /SSRF guard:.*private\/internal/);
    }
  );
});

test('processCampaignWebhookDelivery fails closed (never connects) for a delivery URL that is unsafe outright', async () => {
  const { dispatcher, updates } = buildDispatcher({
    campaignDeliveryRow: baseCampaignDeliveryRow('https://169.254.169.254/latest/meta-data'),
  });

  await dispatcher.processCampaignWebhookDelivery('campaign-delivery-1');

  const failed = updates.find((u) => /status = 'failed'/.test(u.text));
  assert.ok(failed);
  assert.match(failed.params[1], /SSRF guard:.*private\/internal/);
});
