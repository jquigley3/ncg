import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

process.env.DB_PATH = ':memory:';
process.env.CREDENTIAL_PROXY_PORT = '0';

let servers: { admin: http.Server; credential: http.Server };
let baseUrl: string;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqHeaders: Record<string, string> = {};
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

before(async () => {
  const { startServer } = await import('../src/server.js');
  servers = await startServer(0, '127.0.0.1');
  const addr = servers.admin.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  servers?.admin.close(); servers?.credential.close();
  const { closeDb } = await import('../src/db.js');
  closeDb();
});

test('Index page returns 200', async () => {
  const res = await request('GET', '/');
  assert.strictEqual(res.status, 200);
  assert.ok(
    (res.headers['content-type'] || '').includes('text/html'),
    `Expected text/html, got ${res.headers['content-type']}`
  );
  const body = res.body as string;
  assert.ok(body.includes('(nano)clawgate'), 'Page should contain (nano)clawgate');
});

test('SPA assets return 200 when ui-dist exists', async () => {
  // When built, ui-dist has index.html and assets. Test index.html is served for /
  const res = await request('GET', '/');
  assert.strictEqual(res.status, 200);
  const body = res.body as string;
  assert.ok(body.includes('root') || body.includes('(nano)clawgate'), 'SPA shell or title');
});

test('API routes returns JSON', async () => {
  await request('POST', '/api/routes', {
    name: `phase5-route-${Date.now()}`,
    type: 'forward',
    domain_pattern: 'example\\.com',
  });
  const res = await request('GET', '/api/routes');
  assert.strictEqual(res.status, 200);
  const body = res.body as unknown[];
  assert.ok(Array.isArray(body));
});

test('API sessions returns JSON', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `phase5-session-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  await request('PATCH', `/api/sessions/${id}`, {
    container_id: 'abc123def456',
    container_name: 'ncg-test',
  });
  const res = await request('GET', '/api/sessions');
  assert.strictEqual(res.status, 200);
  const body = res.body as unknown[];
  assert.ok(Array.isArray(body));
});

test('API permissions returns JSON', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `phase5-perm-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  const res = await request('GET', `/api/sessions/${id}/permissions`);
  assert.strictEqual(res.status, 200);
  const body = res.body as unknown[];
  assert.ok(Array.isArray(body));
});

test('API global permissions returns JSON', async () => {
  const routeName = `phase5-global-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: '/test',
    upstream_url: 'https://api.example.com',
  });
  await request('POST', '/api/sessions/%2A/permissions', {
    route_name: routeName,
  });
  const res = await request('GET', '/api/sessions/%2A/permissions');
  assert.strictEqual(res.status, 200);
  const body = res.body as unknown[];
  assert.ok(Array.isArray(body));
});

test('SSE events endpoint accepts connection', async () => {
  const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
    const url = new URL('/api/events', baseUrl);
    const req = http.request(url, { method: 'GET' }, (res) => {
      resolve({ statusCode: res.statusCode! });
      res.destroy();
    });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(res.statusCode, 200);
});
