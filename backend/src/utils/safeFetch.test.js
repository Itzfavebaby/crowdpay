const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const proxyquire = require('proxyquire').noCallThru();
const { safeFetch, SsrfBlockedError } = require('./safeFetch');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Real pinned requests against a local server (localhost is allowed for HTTP
// outside production, so these exercise the actual connection/pinning code
// path rather than mocking it away).
// ---------------------------------------------------------------------------

test('safeFetch performs a real pinned request and returns the response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    },
    async (baseUrl) => {
      const res = await safeFetch(`${baseUrl}/ok`, { method: 'GET' });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(await res.text(), 'hello');
    }
  );
});

test('safeFetch sends the request body and custom headers', async () => {
  await withServer(
    (req, res) => {
      let received = '';
      req.on('data', (chunk) => { received += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'X-Echo-Signature': req.headers['x-crowdpay-signature'] || '' });
        res.end(received);
      });
    },
    async (baseUrl) => {
      const res = await safeFetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: { 'X-CrowdPay-Signature': 'sha256=abc' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(res.headers['x-echo-signature'], 'sha256=abc');
      assert.equal(await res.text(), JSON.stringify({ hello: 'world' }));
    }
  );
});

test('safeFetch follows a redirect to a public/allowed target', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('final destination');
    },
    async (baseUrl) => {
      const res = await safeFetch(`${baseUrl}/start`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'final destination');
    }
  );
});

test('safeFetch rejects a redirect to a private/internal target instead of following it', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(() => safeFetch(`${baseUrl}/start`), (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.match(err.message, /private\/internal/);
        return true;
      });
    }
  );
});

test('safeFetch rejects a redirect to a plain-http target the same way a direct request to it would be', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(() => safeFetch(`${baseUrl}/start`), (err) => {
        assert.ok(err instanceof SsrfBlockedError);
        assert.match(err.message, /HTTP is only allowed for localhost/);
        return true;
      });
    }
  );
});

test('safeFetch gives up after too many redirects', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: req.url });
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        () => safeFetch(`${baseUrl}/loop`, { maxRedirects: 2 }),
        (err) => {
          assert.ok(err instanceof SsrfBlockedError);
          assert.match(err.message, /too many redirects/);
          return true;
        }
      );
    }
  );
});

test('safeFetch rejects the initial URL outright when it is unsafe, without connecting', async () => {
  await assert.rejects(() => safeFetch('http://169.254.169.254/'), (err) => {
    assert.ok(err instanceof SsrfBlockedError);
    return true;
  });
});

// ---------------------------------------------------------------------------
// DNS-level scenarios: mixed answers and resolution pinning, via a mocked
// resolver (real DNS can't be made to return attacker-controlled answers).
// ---------------------------------------------------------------------------

function buildSafeFetchWithMockedDns(dnsLookupImpl) {
  const ssrfGuard = proxyquire('./ssrfGuard', {
    dns: { promises: { lookup: dnsLookupImpl } },
    '../config/logger': { warn: () => {}, error: () => {}, info: () => {} },
  });
  return proxyquire('./safeFetch', { './ssrfGuard': ssrfGuard });
}

test('safeFetch rejects a hostname with mixed public/private DNS answers', async () => {
  const dnsLookupImpl = async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  const { safeFetch: mockedSafeFetch, SsrfBlockedError: MockedError } = buildSafeFetchWithMockedDns(dnsLookupImpl);

  await assert.rejects(() => mockedSafeFetch('https://attacker-controlled.example/'), (err) => {
    assert.ok(err instanceof MockedError);
    assert.match(err.message, /private\/internal/);
    return true;
  });
});

test('safeFetch resolves DNS exactly once per hop and pins the connection to that answer (no re-resolution at connect time)', async () => {
  let lookupCalls = 0;
  const dnsLookupImpl = async () => {
    lookupCalls += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const { safeFetch: mockedSafeFetch } = buildSafeFetchWithMockedDns(dnsLookupImpl);

  // A non-IP hostname exercises the DNS-resolution branch (raw-IP and
  // localhost-literal hostnames both skip it entirely). The actual TCP
  // connect is expected to fail here — nothing real is listening on the
  // pinned port — the point is proving `dns.lookup` is consulted exactly
  // once by the validate+pin step and never again for the connection
  // itself (Node's custom `lookup` on the request options satisfies the
  // connect without a second resolution).
  await assert.rejects(() => mockedSafeFetch('https://example-under-test.invalid:1/'));
  assert.equal(lookupCalls, 1, 'DNS should be resolved exactly once, not re-resolved at connect time');
});

test('safeFetch rejects when DNS resolution fails entirely', async () => {
  const dnsLookupImpl = async () => {
    throw new Error('ENOTFOUND');
  };
  const { safeFetch: mockedSafeFetch, SsrfBlockedError: MockedError } = buildSafeFetchWithMockedDns(dnsLookupImpl);

  await assert.rejects(() => mockedSafeFetch('https://does-not-resolve.example/'), (err) => {
    assert.ok(err instanceof MockedError);
    return true;
  });
});
