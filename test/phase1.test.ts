import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

process.env.DB_PATH = ':memory:';
process.env.CREDENTIAL_PROXY_PORT = '0';

let servers: { admin: http.Server; credential: http.Server };
let baseUrl: string;
let db: typeof import('../src/db.js');

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

before(async () => {
  db = await import('../src/db.js');
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

test('GET /health returns 200', async () => {
  const res = await request('GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('DB has correct tables', () => {
  const tables = db
    .getDb()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  assert.ok(names.includes('routes'));
  assert.ok(names.includes('sessions'));
  assert.ok(names.includes('permissions'));
  assert.ok(names.includes('session_links'));
});

test('unknown API route returns 404', async () => {
  const res = await request('GET', '/api/nonexistent');
  assert.strictEqual(res.status, 404);
});

test('unmatched relative path returns 404 with no matching route', async () => {
  const res = await request('GET', '/some/random/path');
  assert.strictEqual(res.status, 404);
});
