import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

process.env.DB_PATH = ':memory:';
process.env.CREDENTIAL_PROXY_PORT = '0';

let servers: { admin: http.Server; credential: http.Server };
let baseUrl: string;
let proxyPort: number;
let sessionId: string;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
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
        resolve({ status: res.statusCode!, body: parsed });
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

  const createRes = await request('POST', '/api/sessions', { name: 'phase4-test' });
  sessionId = (createRes.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${sessionId}`, {
    container_ip: '127.0.0.1',
    default_policy: 'deny',
  });
});

after(async () => {
  servers?.admin.close(); servers?.credential.close();
  const { closeDb } = await import('../src/db.js');
  closeDb();
});

test('Grant permission', async () => {
  await request('POST', '/api/routes', {
    name: `perm-route-${Date.now()}`,
    type: 'forward',
    domain_pattern: 'localhost',
    inject_header: 'X-Injected',
    inject_value: 'secret123',
  });
  const routesRes = await request('GET', '/api/routes');
  const routes = routesRes.body as Array<{ name: string; id: string }>;
  const route = routes.find((r) => r.name.startsWith('perm-route-'));
  assert.ok(route);
  const res = await request('POST', `/api/sessions/${sessionId}/permissions`, {
    route_name: route!.name,
  });
  assert.strictEqual(res.status, 201);
});

test('Global permission', async () => {
  const routeName = `global-route-${Date.now()}`;
  const createRes = await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: '/globaltest',
    upstream_url: 'http://127.0.0.1:9999',
    inject_header: 'X-Global',
    inject_value: 'global-secret',
  });
  assert.strictEqual(createRes.status, 201, `Route create failed: ${JSON.stringify(createRes.body)}`);
  const res = await request('POST', '/api/sessions/%2A/permissions', {
    route_name: routeName,
  });
  assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('List permissions', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}/permissions`);
  assert.strictEqual(res.status, 200);
  const perms = res.body as Array<{ route_name: string }>;
  assert.ok(perms.length >= 1);
});

test('Forward proxy without permission - 403', async () => {
  const uniqueHost = `noperm-${Date.now()}.local`;
  const routeName = `fwd-noperm-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: uniqueHost.replace(/\./g, '\\.'),
    inject_header: 'X-Test',
    inject_value: 'x',
  });

  const res = await forwardProxyRequest(
    proxyPort,
    `http://${uniqueHost}:12345/any`
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual((res.body as { error?: string }).error, 'no_permission');
});

test('Forward proxy global permission', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `fwd-global-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: '127\\.0\\.0\\.1',
    inject_header: 'X-Global-Fwd',
    inject_value: 'global-fwd',
  });
  await request('POST', '/api/sessions/*/permissions', {
    route_name: routeName,
  });

  const res = await forwardProxyRequest(
    proxyPort,
    `http://127.0.0.1:${upPort}/test`
  );
  assert.strictEqual(res.status, 200);
  upstream.close();
});

test('Reverse proxy without permission - 403', async () => {
  const pathPrefix = '/rev-noperm-test';
  const routeName = `rev-noperm-${Date.now()}`;
  const createRes = await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: pathPrefix,
    upstream_url: 'http://127.0.0.1:9999',
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  assert.strictEqual(createRes.status, 201, `Route create failed: ${JSON.stringify(createRes.body)}`);

  const res = await request('GET', `${pathPrefix}/any`);
  assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('Allow policy passes unmatched', async () => {
  await request('PATCH', `/api/sessions/${sessionId}`, {
    default_policy: 'allow',
  });
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const res = await forwardProxyRequest(
    proxyPort,
    `http://127.0.0.1:${upPort}/allow-unmatched`
  );
  assert.strictEqual(res.status, 200, 'Allow policy should forward unmatched requests');
  upstream.close();
});

test('Deny policy blocks unmatched', async () => {
  await request('PATCH', `/api/sessions/${sessionId}`, {
    default_policy: 'deny',
  });
  const res = await forwardProxyRequest(
    proxyPort,
    'http://nonexistent-domain-xyz-12345.com/'
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual((res.body as { error?: string }).error, 'policy_denied');
});

test('Traffic monitoring - session links', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `rev-traffic-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: '/traffic',
    upstream_url: `http://127.0.0.1:${upPort}`,
    inject_header: 'X-Test',
    inject_value: 'x',
  });
  await request('POST', '/api/sessions/*/permissions', {
    route_name: routeName,
  });

  await request('POST', '/traffic/test', { session_id: 'test-claude-123' });

  const { getSessionLinks } = await import('../src/traffic.js');
  const links = getSessionLinks(sessionId);
  assert.ok(links.some((l) => l.claude_session_id === 'test-claude-123'));
  upstream.close();
});

test('Migrate permissions', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `migrate-target-${Date.now()}`,
  });
  const targetId = (createRes.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${targetId}`, {
    container_ip: '127.0.0.1',
  });

  const routeName = `migrate-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'example\\.com',
    inject_header: 'X-Test',
    inject_value: 'migrated',
  });
  await request('POST', `/api/sessions/${sessionId}/permissions`, {
    route_name: routeName,
  });

  const res = await request('POST', `/api/sessions/${targetId}/migrate-from/${sessionId}`);
  assert.strictEqual(res.status, 200);
  assert.ok((res.body as { migrated?: number }).migrated >= 1);

  const permsRes = await request('GET', `/api/sessions/${targetId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string }>;
  assert.ok(perms.some((p) => p.route_name === routeName));
});
