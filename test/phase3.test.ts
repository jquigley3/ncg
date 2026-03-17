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

test('Create session', async () => {
  const res = await request('POST', '/api/sessions', { name: 'test' });
  assert.strictEqual(res.status, 201);
  const body = res.body as { id?: string; name?: string };
  assert.ok(body.id);
  assert.strictEqual(body.name, 'test');
});

test('List sessions', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `list-test-${Date.now()}`,
  });
  const session = createRes.body as { id: string };
  const res = await request('GET', '/api/sessions');
  assert.strictEqual(res.status, 200);
  const sessions = res.body as Array<{ id: string }>;
  assert.ok(sessions.some((s) => s.id === session.id));
});

test('Get session', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `get-test-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  const res = await request('GET', `/api/sessions/${id}`);
  assert.strictEqual(res.status, 200);
  const body = res.body as { id: string; name: string };
  assert.strictEqual(body.id, id);
});

test('Update session', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `update-test-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  await request('PATCH', `/api/sessions/${id}`, {
    container_ip: '172.20.0.3',
    default_policy: 'allow',
  });
  const res = await request('GET', `/api/sessions/${id}`);
  assert.strictEqual(res.status, 200);
  const body = res.body as { container_ip?: string; default_policy?: string };
  assert.strictEqual(body.container_ip, '172.20.0.3');
  assert.strictEqual(body.default_policy, 'allow');
});

test('Stop session - stopped_at is set', async () => {
  const createRes = await request('POST', '/api/sessions', {
    name: `stop-test-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  await request('PATCH', `/api/sessions/${id}`, { status: 'stopped' });
  const res = await request('GET', `/api/sessions/${id}`);
  assert.strictEqual(res.status, 200);
  const body = res.body as { status: string; stopped_at: string | null };
  assert.strictEqual(body.status, 'stopped');
  assert.ok(body.stopped_at);
});

test('Session IP lookup', async () => {
  const { getSessionByIp } = await import('../src/sessions.js');
  const createRes = await request('POST', '/api/sessions', {
    name: `ip-test-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  await request('PATCH', `/api/sessions/${id}`, {
    container_ip: '172.20.0.5',
  });
  const session = getSessionByIp('172.20.0.5');
  assert.ok(session);
  assert.strictEqual(session!.id, id);
});

test('Stopped session not found by IP', async () => {
  const { getSessionByIp } = await import('../src/sessions.js');
  const createRes = await request('POST', '/api/sessions', {
    name: `stopped-ip-${Date.now()}`,
  });
  const { id } = createRes.body as { id: string };
  await request('PATCH', `/api/sessions/${id}`, {
    container_ip: '172.20.0.99',
  });
  await request('PATCH', `/api/sessions/${id}`, { status: 'stopped' });
  const session = getSessionByIp('172.20.0.99');
  assert.strictEqual(session, undefined);
});
