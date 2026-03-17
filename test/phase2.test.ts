import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

process.env.DB_PATH = ':memory:';
process.env.CREDENTIAL_PROXY_PORT = '0';

let servers: { admin: http.Server; credential: http.Server };
let baseUrl: string;
let proxyPort: number;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqHeaders: Record<string, string> = { ...(headers || {}) };
    if (body) reqHeaders['content-type'] = 'application/json';
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function forwardProxyRequest(
  proxyPort: number,
  targetUrl: string,
  method = 'GET',
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: targetUrl,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const { startServer } = await import('../src/server.js');
  servers = await startServer(0, '127.0.0.1');
  const addr = servers.admin.address() as { port: number };
  proxyPort = addr.port;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  servers?.admin.close(); servers?.credential.close();
  const { closeDb } = await import('../src/db.js');
  closeDb();
});

test('Create forward route', async () => {
  const res = await request('POST', '/api/routes', {
    name: `github-${Date.now()}`,
    type: 'forward',
    domain_pattern: 'api\\.github\\.com',
    inject_header: 'Authorization',
    inject_value: 'Bearer ghp_xxx',
  });
  assert.strictEqual(res.status, 201);
  assert.ok((res.body as { id?: string }).id);
  assert.ok((res.body as { name?: string }).name);
});

test('Create reverse route', async () => {
  const res = await request('POST', '/api/routes', {
    name: `anthropic-${Date.now()}`,
    type: 'reverse',
    path_prefix: '/anthropic',
    upstream_url: 'https://api.anthropic.com',
    inject_header: 'x-api-key',
    inject_value: 'sk-ant-xxx',
  });
  assert.strictEqual(res.status, 201);
  assert.ok((res.body as { id?: string }).id);
});

test('List routes', async () => {
  const name1 = `fwd-${Date.now()}`;
  const name2 = `rev-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: name1,
    type: 'forward',
    domain_pattern: 'example\\.com',
    inject_header: 'X-Test',
    inject_value: 'a',
  });
  await request('POST', '/api/routes', {
    name: name2,
    type: 'reverse',
    path_prefix: '/foo',
    upstream_url: 'https://foo.com',
    inject_header: 'X-Test',
    inject_value: 'b',
  });
  const res = await request('GET', '/api/routes');
  assert.strictEqual(res.status, 200);
  const routes = res.body as Array<{ name: string }>;
  assert.ok(routes.some((r) => r.name === name1));
  assert.ok(routes.some((r) => r.name === name2));
});

test('List filtered by type', async () => {
  const name = `fwd-only-${Date.now()}`;
  await request('POST', '/api/routes', {
    name,
    type: 'forward',
    domain_pattern: 'filtered\\.com',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  const res = await request('GET', '/api/routes?type=forward');
  assert.strictEqual(res.status, 200);
  const routes = res.body as Array<{ name: string; type: string }>;
  assert.ok(routes.every((r) => r.type === 'forward'));
  assert.ok(routes.some((r) => r.name === name));
});

test('Duplicate name rejected', async () => {
  const name = `dup-${Date.now()}`;
  await request('POST', '/api/routes', {
    name,
    type: 'forward',
    domain_pattern: 'dup\\.com',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  const res = await request('POST', '/api/routes', {
    name,
    type: 'forward',
    domain_pattern: 'other\\.com',
    inject_header: 'X-Test',
    inject_value: 'y',
  });
  assert.strictEqual(res.status, 409);
});

test('Invalid forward route - bad regex', async () => {
  const res = await request('POST', '/api/routes', {
    name: `bad-regex-${Date.now()}`,
    type: 'forward',
    domain_pattern: '[[invalid',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  assert.strictEqual(res.status, 400);
});

test('Invalid reverse route - no path_prefix', async () => {
  const res = await request('POST', '/api/routes', {
    name: `bad-rev-${Date.now()}`,
    type: 'reverse',
    upstream_url: 'https://api.example.com',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  assert.strictEqual(res.status, 400);
});

test('Invalid reverse route - prefix missing /', async () => {
  const res = await request('POST', '/api/routes', {
    name: `bad-prefix-${Date.now()}`,
    type: 'reverse',
    path_prefix: 'anthropic',
    upstream_url: 'https://api.anthropic.com',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  assert.strictEqual(res.status, 400);
});

test('Delete route', async () => {
  const name = `to-delete-${Date.now()}`;
  await request('POST', '/api/routes', {
    name,
    type: 'forward',
    domain_pattern: 'delete\\.com',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  const res = await request('DELETE', `/api/routes/${name}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((res.body as { ok?: boolean }).ok, true);
});

test('Delete nonexistent', async () => {
  const res = await request('DELETE', '/api/routes/nonexistent-route-xyz');
  assert.strictEqual(res.status, 404);
});

test('Forward proxy with route - request reaches upstream', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, received: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upAddr = upstream.address() as { port: number };
  const upstreamPort = upAddr.port;

  const routeName = `fwd-localhost-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'localhost',
    inject_header: 'X-Test',
    inject_value: 'forwarded',
  });
  await request('POST', '/api/sessions', { name: 'phase2-fwd' });
  const sessionsRes = await request('GET', '/api/sessions');
  const sessions = sessionsRes.body as Array<{ id: string }>;
  const session = sessions.find((s) => s.id);
  if (session) {
    await request('PATCH', `/api/sessions/${session.id}`, {
      container_ip: '127.0.0.1',
    });
    await request('POST', `/api/sessions/${session.id}/permissions`, {
      route_name: routeName,
    });
  }

  const res = await forwardProxyRequest(
    proxyPort,
    `http://localhost:${upstreamPort}/test`
  );
  assert.strictEqual(res.status, 200);
  const body = res.body as { received?: boolean; path?: string };
  assert.strictEqual(body.received, true);
  assert.strictEqual(body.path, '/test');

  upstream.close();
});

test('Reverse proxy with route - prefix stripped', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const upAddr = upstream.address() as { port: number };
  const upstreamPort = upAddr.port;

  const routeName = `rev-test-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: '/testupstream',
    upstream_url: `http://127.0.0.1:${upstreamPort}`,
    inject_header: 'X-Test',
    inject_value: 'reversed',
  });
  await request('POST', '/api/sessions/*/permissions', { route_name: routeName });

  const res = await request('GET', '/testupstream/hello');
  assert.strictEqual(res.status, 200);
  const body = res.body as { path?: string };
  assert.strictEqual(body.path, '/hello');

  upstream.close();
});
