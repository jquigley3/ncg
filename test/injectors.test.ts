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
): Promise<{ status: number; body: unknown }> {
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
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function forwardProxyRequest(
  port: number,
  targetUrl: string,
  method = 'GET',
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: targetUrl, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode!, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function stopAllLocalSessions(): Promise<void> {
  const sessions = await request('GET', '/api/sessions');
  for (const s of (sessions.body as Array<{ id: string; container_ip: string | null; status: string }>)) {
    if (s.container_ip === '127.0.0.1' && s.status === 'active') {
      await request('PATCH', `/api/sessions/${s.id}`, { status: 'stopped' });
    }
  }
}

before(async () => {
  const { startServer } = await import('../src/server.js');
  servers = await startServer(0, '127.0.0.1');
  const addr = servers.admin.address() as { port: number };
  proxyPort = addr.port;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  servers?.admin.close();
  servers?.credential.close();
  const { closeDb } = await import('../src/db.js');
  closeDb();
});

// ── Injector CRUD ────────────────────────────────────────────────────

test('DB has injectors table', async () => {
  const db = (await import('../src/db.js')).getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.ok(tables.some((t) => t.name === 'injectors'));
});

test('Create injector via API', async () => {
  const routeName = `inj-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'example\\.com',
  });

  const res = await request('POST', '/api/injectors', {
    name: `test-inj-${Date.now()}`,
    route_name: routeName,
    inject_header: 'Authorization',
    inject_value: 'Bearer token123',
  });
  assert.strictEqual(res.status, 201);
  const body = res.body as { id?: string; name?: string };
  assert.ok(body.id);
  assert.ok(body.name);
});

test('List injectors', async () => {
  const routeName = `inj-list-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'list\\.com',
  });
  const injName = `list-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const res = await request('GET', '/api/injectors');
  assert.strictEqual(res.status, 200);
  const injectors = res.body as Array<{ name: string; route_name: string }>;
  const found = injectors.find((i) => i.name === injName);
  assert.ok(found, 'Injector should appear in list');
  assert.strictEqual(found!.route_name, routeName);
});

test('Duplicate injector name rejected', async () => {
  const routeName = `inj-dup-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'dup\\.com',
  });
  const injName = `dup-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'v1',
  });
  const res = await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'v2',
  });
  assert.strictEqual(res.status, 409);
});

test('Create injector with missing fields returns 400', async () => {
  const res = await request('POST', '/api/injectors', {
    name: 'bad-inj',
  });
  assert.strictEqual(res.status, 400);
});

test('Create injector with nonexistent route returns 404', async () => {
  const res = await request('POST', '/api/injectors', {
    name: `orphan-inj-${Date.now()}`,
    route_name: 'nonexistent-route-xyz',
    inject_header: 'X-Key',
    inject_value: 'val',
  });
  assert.strictEqual(res.status, 404);
});

test('Delete injector', async () => {
  const routeName = `inj-del-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'del\\.com',
  });
  const injName = `del-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const res = await request('DELETE', `/api/injectors/${injName}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((res.body as { ok?: boolean }).ok, true);

  const listRes = await request('GET', '/api/injectors');
  const injectors = listRes.body as Array<{ name: string }>;
  assert.ok(!injectors.some((i) => i.name === injName));
});

test('Delete nonexistent injector returns 404', async () => {
  const res = await request('DELETE', '/api/injectors/nonexistent-xyz');
  assert.strictEqual(res.status, 404);
});

// ── Assignment / Unassignment ────────────────────────────────────────

test('Assign injector to session', async () => {
  const routeName = `inj-assign-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'assign\\.com',
  });
  const injName = `assign-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Assigned',
    inject_value: 'yes',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `assign-session-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;

  const res = await request('POST', `/api/injectors/${injName}/assignments`, {
    session_id: sessionId,
  });
  assert.strictEqual(res.status, 201);

  // Verify permission was created with injector
  const permsRes = await request('GET', `/api/sessions/${sessionId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string; injector_name: string | null }>;
  const perm = perms.find((p) => p.route_name === routeName);
  assert.ok(perm, 'Permission should exist');
  assert.strictEqual(perm!.injector_name, injName);
});

test('Assign injector to global (*)', async () => {
  const routeName = `inj-global-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'global\\.com',
  });
  const injName = `global-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Global',
    inject_value: 'all',
  });

  const res = await request('POST', `/api/injectors/${injName}/assignments`, {
    session_id: '*',
  });
  assert.strictEqual(res.status, 201);

  const permsRes = await request('GET', '/api/sessions/*/permissions');
  const perms = permsRes.body as Array<{ route_name: string; injector_name: string | null }>;
  assert.ok(perms.some((p) => p.route_name === routeName && p.injector_name === injName));
});

test('Reassigning injector updates existing permission', async () => {
  const routeName = `inj-reassign-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'reassign\\.com',
  });
  const inj1 = `reassign-inj1-${Date.now()}`;
  const inj2 = `reassign-inj2-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: inj1,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val1',
  });
  await request('POST', '/api/injectors', {
    name: inj2,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val2',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `reassign-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;

  await request('POST', `/api/injectors/${inj1}/assignments`, { session_id: sessionId });
  await request('POST', `/api/injectors/${inj2}/assignments`, { session_id: sessionId });

  const permsRes = await request('GET', `/api/sessions/${sessionId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string; injector_name: string | null }>;
  const routePerms = perms.filter((p) => p.route_name === routeName);
  assert.strictEqual(routePerms.length, 1, 'Should have exactly one permission per route');
  assert.strictEqual(routePerms[0].injector_name, inj2, 'Should have the latest injector');
});

test('Unassign injector removes permission', async () => {
  const routeName = `inj-unassign-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'unassign\\.com',
  });
  const injName = `unassign-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `unassign-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;

  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sessionId });
  const res = await request('DELETE', `/api/injectors/${injName}/assignments/${sessionId}`);
  assert.strictEqual(res.status, 200);

  const permsRes = await request('GET', `/api/sessions/${sessionId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string }>;
  assert.ok(!perms.some((p) => p.route_name === routeName), 'Permission should be removed');
});

test('List injector assignments', async () => {
  const routeName = `inj-listassign-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'listassign\\.com',
  });
  const injName = `listassign-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const s1 = await request('POST', '/api/sessions', { name: `la1-${Date.now()}` });
  const s2 = await request('POST', '/api/sessions', { name: `la2-${Date.now()}` });
  const sid1 = (s1.body as { id: string }).id;
  const sid2 = (s2.body as { id: string }).id;

  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sid1 });
  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sid2 });

  const res = await request('GET', `/api/injectors/${injName}/assignments`);
  assert.strictEqual(res.status, 200);
  const assignments = res.body as Array<{ session_id: string }>;
  assert.ok(assignments.some((a) => a.session_id === sid1));
  assert.ok(assignments.some((a) => a.session_id === sid2));
});

// ── Deleting injector cleans up permissions ──────────────────────────

test('Deleting injector removes its assignments', async () => {
  const routeName = `inj-delclean-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'delclean\\.com',
  });
  const injName = `delclean-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `delclean-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;
  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sessionId });

  await request('DELETE', `/api/injectors/${injName}`);

  const permsRes = await request('GET', `/api/sessions/${sessionId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string }>;
  assert.ok(!perms.some((p) => p.route_name === routeName), 'Permission should be gone after injector delete');
});

test('Deleting route cleans up injectors and permissions', async () => {
  const routeName = `inj-routedel-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: 'routedel\\.com',
  });
  const injName = `routedel-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `routedel-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;
  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sessionId });

  await request('DELETE', `/api/routes/${routeName}`);

  const injRes = await request('GET', '/api/injectors');
  const injectors = injRes.body as Array<{ name: string }>;
  assert.ok(!injectors.some((i) => i.name === injName), 'Injector should be removed when route is deleted');
});

// ── Bare permissions still work ──────────────────────────────────────

test('Bare permission (no injector) grants access without injection', async () => {
  await stopAllLocalSessions();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ injected: req.headers['x-secret'] ?? null }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `bare-perm-route-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: `/bare-${Date.now()}`,
    upstream_url: `http://127.0.0.1:${upPort}`,
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `bare-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${sessionId}`, { container_ip: '127.0.0.1' });

  await request('POST', `/api/sessions/${sessionId}/permissions`, { route_name: routeName });

  const routesRes = await request('GET', '/api/routes');
  const routes = routesRes.body as Array<{ name: string; path_prefix: string }>;
  const route = routes.find((r) => r.name === routeName);
  assert.ok(route);

  const res = await request('GET', route!.path_prefix + '/test');
  assert.strictEqual(res.status, 200);
  const body = res.body as { injected: string | null };
  assert.strictEqual(body.injected, null, 'No secret should be injected for bare permission');

  upstream.close();
});

// ── Proxy injection via injector ─────────────────────────────────────

test('Reverse proxy injects via injector', async () => {
  await stopAllLocalSessions();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, key: req.headers['x-api-key'] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `rev-inj-${Date.now()}`;
  const prefix = `/rev-inj-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: prefix,
    upstream_url: `http://127.0.0.1:${upPort}`,
  });

  const injName = `rev-inj-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'x-api-key',
    inject_value: 'sk-injected-123',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `rev-inj-s-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${sessionId}`, { container_ip: '127.0.0.1' });
  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sessionId });

  const res = await request('GET', `${prefix}/hello`);
  assert.strictEqual(res.status, 200);
  const body = res.body as { path?: string; key?: string };
  assert.strictEqual(body.path, '/hello');
  assert.strictEqual(body.key, 'sk-injected-123');

  upstream.close();
});

test('Forward proxy injects via injector', async () => {
  await stopAllLocalSessions();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ header: req.headers['x-fwd-secret'] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `fwd-inj-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'forward',
    domain_pattern: '127\\.0\\.0\\.1',
  });

  const injName = `fwd-inj-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Fwd-Secret',
    inject_value: 'fwd-injected-456',
  });

  const sessionRes = await request('POST', '/api/sessions', { name: `fwd-inj-s-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${sessionId}`, {
    container_ip: '127.0.0.1',
    default_policy: 'deny',
  });
  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: sessionId });

  const res = await forwardProxyRequest(proxyPort, `http://127.0.0.1:${upPort}/test`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((res.body as { header?: string }).header, 'fwd-injected-456');

  upstream.close();
});

// ── Two containers, same route, different secrets ────────────────────

test('Two sessions on same route get different secrets', async () => {
  await stopAllLocalSessions();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ key: req.headers['x-api-key'] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  const routeName = `shared-route-${Date.now()}`;
  const prefix = `/shared-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: prefix,
    upstream_url: `http://127.0.0.1:${upPort}`,
  });

  const injRead = `read-inj-${Date.now()}`;
  const injWrite = `write-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injRead,
    route_name: routeName,
    inject_header: 'x-api-key',
    inject_value: 'sk-readonly-token',
  });
  await request('POST', '/api/injectors', {
    name: injWrite,
    route_name: routeName,
    inject_header: 'x-api-key',
    inject_value: 'sk-readwrite-token',
  });

  // Session A gets read injector
  const s1 = await request('POST', '/api/sessions', { name: `reader-${Date.now()}` });
  const sid1 = (s1.body as { id: string }).id;
  await request('PATCH', `/api/sessions/${sid1}`, { container_ip: '127.0.0.1' });
  await request('POST', `/api/injectors/${injRead}/assignments`, { session_id: sid1 });

  // Verify session A gets the read token
  const res1 = await request('GET', `${prefix}/test`);
  assert.strictEqual(res1.status, 200);
  assert.strictEqual((res1.body as { key?: string }).key, 'sk-readonly-token');

  // Switch session A to the write injector
  await request('POST', `/api/injectors/${injWrite}/assignments`, { session_id: sid1 });
  const res2 = await request('GET', `${prefix}/test`);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual((res2.body as { key?: string }).key, 'sk-readwrite-token');

  upstream.close();
});

// ── Bootstrap creates default injector ───────────────────────────────

test('Bootstrap creates anthropic-default injector', async () => {
  const injRes = await request('GET', '/api/injectors');
  const injectors = injRes.body as Array<{ name: string; route_name: string }>;
  const anthInj = injectors.find((i) => i.name === 'anthropic-default');
  assert.ok(anthInj, 'anthropic-default injector should exist');
  assert.strictEqual(anthInj!.route_name, 'anthropic');
});

test('New sessions get anthropic-default injector assigned', async () => {
  const sessionRes = await request('POST', '/api/sessions', { name: `bootstrap-${Date.now()}` });
  const sessionId = (sessionRes.body as { id: string }).id;

  const permsRes = await request('GET', `/api/sessions/${sessionId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string; injector_name: string | null }>;
  const anthPerm = perms.find((p) => p.route_name === 'anthropic');
  assert.ok(anthPerm, 'Should have anthropic permission');
  assert.strictEqual(anthPerm!.injector_name, 'anthropic-default', 'Should use anthropic-default injector');
});

// ── Permission migration preserves injectors ─────────────────────────

test('Migrate permissions preserves injector assignments', async () => {
  const routeName = `migrate-inj-route-${Date.now()}`;
  const prefix = `/migrate-inj-${Date.now()}`;
  await request('POST', '/api/routes', {
    name: routeName,
    type: 'reverse',
    path_prefix: prefix,
    upstream_url: 'http://127.0.0.1:9999',
  });
  const injName = `migrate-inj-${Date.now()}`;
  await request('POST', '/api/injectors', {
    name: injName,
    route_name: routeName,
    inject_header: 'X-Key',
    inject_value: 'val',
  });

  const s1 = await request('POST', '/api/sessions', { name: `migrate-from-${Date.now()}` });
  const s2 = await request('POST', '/api/sessions', { name: `migrate-to-${Date.now()}` });
  const fromId = (s1.body as { id: string }).id;
  const toId = (s2.body as { id: string }).id;

  await request('POST', `/api/injectors/${injName}/assignments`, { session_id: fromId });
  const res = await request('POST', `/api/sessions/${toId}/migrate-from/${fromId}`);
  assert.strictEqual(res.status, 200);

  const permsRes = await request('GET', `/api/sessions/${toId}/permissions`);
  const perms = permsRes.body as Array<{ route_name: string; injector_name: string | null }>;
  const perm = perms.find((p) => p.route_name === routeName);
  assert.ok(perm, 'Migrated permission should exist');
  assert.strictEqual(perm!.injector_name, injName, 'Migrated permission should preserve injector');
});
