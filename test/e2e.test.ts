import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:3100';
const TS = Date.now();
const ECHO = `e2e-echo-${TS}`;
const WORKER_A = `e2e-a-${TS}`;
const WORKER_B = `e2e-b-${TS}`;
const ECHO_PORT = 8080;
const FWD_ECHO_PORT = 9999;

// ── Helpers ──────────────────────────────────────────────────────────

function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: any;
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

function dockerExec(container: string, cmd: string, timeout = 15_000): string {
  return execSync(`docker exec ${container} ${cmd}`, {
    encoding: 'utf-8',
    timeout,
  }).trim();
}

function curlJson(container: string, url: string, extra = ''): any {
  const raw = dockerExec(container, `curl -s --max-time 10 ${extra} '${url}'`);
  return JSON.parse(raw);
}

function curlStatus(container: string, url: string, extra = ''): number {
  const raw = dockerExec(
    container,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${extra} '${url}'`,
  );
  return parseInt(raw, 10);
}

async function registerWorker(container: string): Promise<string> {
  const output = execSync(`./ncg.sh register ${container}`, {
    encoding: 'utf-8',
  });
  const match = output.match(/Session\s+(\S+)/);
  assert.ok(match, `Failed to parse session ID from: ${output}`);
  return match![1];
}

async function findSession(containerName: string): Promise<string> {
  const resp = await api('GET', '/api/sessions');
  const sessions = resp.body as any[];
  const session = sessions.find((s: any) => s.container_name === containerName);
  assert.ok(session, `Session not found for container ${containerName}`);
  return session.id;
}

// ── Setup / Teardown ─────────────────────────────────────────────────

before(() => {
  execSync('./ncg.sh down', { stdio: 'pipe' });
  for (const c of [ECHO, WORKER_A, WORKER_B]) {
    try {
      execSync(`docker rm -f ${c}`, { stdio: 'pipe' });
    } catch {}
  }

  execSync('./ncg.sh build', { stdio: 'pipe', timeout: 120_000 });
  execSync('./ncg.sh build-worker', { stdio: 'pipe', timeout: 120_000 });
  execSync('./ncg.sh up', { stdio: 'pipe' });

  // Echo server on ncg-internal for reverse proxy tests
  const echoScript = [
    "require('http').createServer((q,s)=>{",
    "let b='';q.on('data',c=>b+=c);q.on('end',()=>{",
    "s.writeHead(200,{'content-type':'application/json'});",
    "s.end(JSON.stringify({path:q.url,method:q.method,headers:q.headers}))})}).",
    `listen(${ECHO_PORT},'0.0.0.0')`,
  ].join('');
  execSync(
    `docker run -d --rm --name ${ECHO} --network ncg-internal node:22-slim node -e "${echoScript}"`,
    { stdio: 'pipe' },
  );

  // Echo server inside proxy container for forward proxy tests
  const fwdEchoScript = [
    "require('http').createServer((q,s)=>{",
    "let b='';q.on('data',c=>b+=c);q.on('end',()=>{",
    "s.writeHead(200,{'content-type':'application/json'});",
    "s.end(JSON.stringify({path:q.url,method:q.method,headers:q.headers}))})}).",
    `listen(${FWD_ECHO_PORT})`,
  ].join('');
  execSync(`docker exec -d ncg-proxy node -e "${fwdEchoScript}"`, {
    stdio: 'pipe',
  });

  // Launch both workers (unregistered)
  for (const name of [WORKER_A, WORKER_B]) {
    execSync(
      [
        'docker run -d --rm',
        `--name ${name}`,
        '--network ncg-internal',
        '-e ANTHROPIC_BASE_URL=http://ncg-proxy:3001',
        '-e ANTHROPIC_API_KEY=placeholder',
        'ncg-worker:latest sleep infinity',
      ].join(' '),
      { stdio: 'pipe' },
    );
  }

  // Wait for echo servers to be ready
  execSync('sleep 2');
});

after(() => {
  for (const c of [ECHO, WORKER_A, WORKER_B]) {
    try {
      execSync(`docker rm -f ${c}`, { stdio: 'pipe' });
    } catch {}
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe('e2e', () => {
  // ── 1. Claude smoke test ───────────────────────────────────────────

  test('claude: credential proxy works without session registration', async () => {
    const status = curlStatus(
      WORKER_A,
      'http://ncg-proxy:3001/v1/messages',
      `-X POST -H 'Content-Type: application/json' -d '${JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })}'`,
    );
    assert.ok(
      [200, 400, 401, 429].includes(status),
      `Expected valid HTTP response from Anthropic, got: ${status}`,
    );

    const body = dockerExec(
      WORKER_A,
      `curl -s --max-time 15 -X POST http://ncg-proxy:3001/v1/messages -H 'Content-Type: application/json' -d '${JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })}'`,
    );
    const lower = body.toLowerCase();
    for (const err of [
      'eai_again',
      'connect_not_supported',
      'econnrefused',
      'not available in your country',
    ]) {
      assert.ok(
        !lower.includes(err),
        `Network error "${err}" in response: ${body.slice(0, 300)}`,
      );
    }
  });

  // ── 2. Reverse proxy lifecycle ─────────────────────────────────────

  test('reverse proxy: access control and secret injection', async (t) => {
    const ROUTE = `e2e-rev-${TS}`;
    const PREFIX = `/e2e-rev-${TS}`;
    let sessionA: string;

    // Create endpoint WITHOUT secret injection
    const create = await api('POST', '/api/routes', {
      name: ROUTE,
      type: 'reverse',
      path_prefix: PREFIX,
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
    });
    assert.strictEqual(
      create.status,
      201,
      `Failed to create route: ${JSON.stringify(create.body)}`,
    );

    await t.test('unregistered container is denied (403)', () => {
      const status = curlStatus(
        WORKER_A,
        `http://ncg-proxy:3100${PREFIX}/test`,
      );
      assert.strictEqual(status, 403);
    });

    await t.test(
      'registered container accesses endpoint (no secrets)',
      async () => {
        sessionA = await registerWorker(WORKER_A);
        await api('POST', `/api/sessions/${sessionA}/permissions`, {
          route_name: ROUTE,
        });

        const resp = curlJson(
          WORKER_A,
          `http://ncg-proxy:3100${PREFIX}/some/path`,
        );
        assert.strictEqual(resp.path, '/some/path');
        assert.strictEqual(
          resp.headers['x-api-key'],
          undefined,
          'No secret should be injected',
        );
      },
    );

    await t.test('route with secrets injects credentials', async () => {
      const SECRET_ROUTE = `e2e-rev-secret-${TS}`;
      const SECRET_PREFIX = `/e2e-rev-secret-${TS}`;
      await api('POST', '/api/routes', {
        name: SECRET_ROUTE,
        type: 'reverse',
        path_prefix: SECRET_PREFIX,
        upstream_url: `http://${ECHO}:${ECHO_PORT}`,
        inject_header: 'x-api-key',
        inject_value: 'sk-test-secret-123',
      });
      await api('POST', `/api/sessions/${sessionA}/permissions`, {
        route_name: SECRET_ROUTE,
      });

      const resp = curlJson(
        WORKER_A,
        `http://ncg-proxy:3100${SECRET_PREFIX}/v1/messages`,
      );
      assert.strictEqual(resp.path, '/v1/messages');
      assert.strictEqual(resp.headers['x-api-key'], 'sk-test-secret-123');
    });

    await t.test('revoking permission returns 403', async () => {
      const perms = await api(
        'GET',
        `/api/sessions/${sessionA}/permissions`,
      );
      const perm = (perms.body as any[]).find(
        (p: any) => p.route_name === ROUTE,
      );
      assert.ok(perm, 'Permission should exist');

      await api(
        'DELETE',
        `/api/sessions/${sessionA}/permissions/${perm.route_id}`,
      );

      const status = curlStatus(
        WORKER_A,
        `http://ncg-proxy:3100${PREFIX}/test`,
      );
      assert.strictEqual(status, 403);
    });

    await t.test('re-granting permission restores access', async () => {
      await api('POST', `/api/sessions/${sessionA}/permissions`, {
        route_name: ROUTE,
      });
      const resp = curlJson(
        WORKER_A,
        `http://ncg-proxy:3100${PREFIX}/test`,
      );
      assert.strictEqual(resp.path, '/test');
    });
  });

  // ── 3. Two containers, different secrets ───────────────────────────

  test('reverse proxy: two containers with different secrets', async () => {
    const ROUTE_A = `e2e-sec-a-${TS}`;
    const ROUTE_B = `e2e-sec-b-${TS}`;
    const PREFIX_A = `/e2e-sec-a-${TS}`;
    const PREFIX_B = `/e2e-sec-b-${TS}`;

    await api('POST', '/api/routes', {
      name: ROUTE_A,
      type: 'reverse',
      path_prefix: PREFIX_A,
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
      inject_header: 'x-api-key',
      inject_value: 'secret-for-A',
    });
    await api('POST', '/api/routes', {
      name: ROUTE_B,
      type: 'reverse',
      path_prefix: PREFIX_B,
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
      inject_header: 'x-api-key',
      inject_value: 'secret-for-B',
    });

    const sessionA = await findSession(WORKER_A);
    const sessionB = await registerWorker(WORKER_B);

    await api('POST', `/api/sessions/${sessionA}/permissions`, {
      route_name: ROUTE_A,
    });
    await api('POST', `/api/sessions/${sessionB}/permissions`, {
      route_name: ROUTE_B,
    });

    // Each container sees its own secret
    const respA = curlJson(
      WORKER_A,
      `http://ncg-proxy:3100${PREFIX_A}/test`,
    );
    assert.strictEqual(respA.headers['x-api-key'], 'secret-for-A');

    const respB = curlJson(
      WORKER_B,
      `http://ncg-proxy:3100${PREFIX_B}/test`,
    );
    assert.strictEqual(respB.headers['x-api-key'], 'secret-for-B');

    // Cross-access is denied
    assert.strictEqual(
      curlStatus(WORKER_A, `http://ncg-proxy:3100${PREFIX_B}/test`),
      403,
      'Worker A should not access route B',
    );
    assert.strictEqual(
      curlStatus(WORKER_B, `http://ncg-proxy:3100${PREFIX_A}/test`),
      403,
      'Worker B should not access route A',
    );
  });

  // ── 4. Forward proxy lifecycle ─────────────────────────────────────

  test('forward proxy: access control and secret injection', async (t) => {
    const FWD_ROUTE = `e2e-fwd-${TS}`;
    let sessionA: string;

    await t.test('container without permission is denied (403)', async () => {
      // Create forward route matching localhost (no secrets)
      const create = await api('POST', '/api/routes', {
        name: FWD_ROUTE,
        type: 'forward',
        domain_pattern: 'localhost',
      });
      assert.strictEqual(
        create.status,
        201,
        `Failed to create forward route: ${JSON.stringify(create.body)}`,
      );

      // Worker B is registered but has no permission for this forward route
      const status = curlStatus(
        WORKER_B,
        `http://localhost:${FWD_ECHO_PORT}/test`,
        '--noproxy ""',
      );
      assert.strictEqual(status, 403);
    });

    await t.test(
      'container with permission passes through (no secrets)',
      async () => {
        sessionA = await findSession(WORKER_A);
        await api('POST', `/api/sessions/${sessionA}/permissions`, {
          route_name: FWD_ROUTE,
        });

        const resp = curlJson(
          WORKER_A,
          `http://localhost:${FWD_ECHO_PORT}/forward-test`,
          '--noproxy ""',
        );
        assert.strictEqual(resp.path, '/forward-test');
        assert.strictEqual(
          resp.headers['x-secret'],
          undefined,
          'No secret should be injected',
        );
      },
    );

    await t.test('forward route with secrets injects credentials', async () => {
      // Replace with a secret-injecting route
      await api('DELETE', `/api/routes/${FWD_ROUTE}`);
      const FWD_SEC_ROUTE = `e2e-fwd-sec-${TS}`;
      await api('POST', '/api/routes', {
        name: FWD_SEC_ROUTE,
        type: 'forward',
        domain_pattern: 'localhost',
        inject_header: 'x-forward-secret',
        inject_value: 'fwd-injected-123',
      });
      await api('POST', `/api/sessions/${sessionA}/permissions`, {
        route_name: FWD_SEC_ROUTE,
      });

      const resp = curlJson(
        WORKER_A,
        `http://localhost:${FWD_ECHO_PORT}/forward-secret-test`,
        '--noproxy ""',
      );
      assert.strictEqual(resp.path, '/forward-secret-test');
      assert.strictEqual(
        resp.headers['x-forward-secret'],
        'fwd-injected-123',
      );
    });

    await t.test(
      'unmatched domain with deny policy returns 403',
      async () => {
        await api('PATCH', `/api/sessions/${sessionA}`, {
          default_policy: 'deny',
        });
        const status = curlStatus(
          WORKER_A,
          'http://blocked.example.com:12345/test',
          '--noproxy ""',
        );
        assert.strictEqual(status, 403);
      },
    );

    await t.test(
      'unmatched domain with allow policy passes through',
      async () => {
        await api('PATCH', `/api/sessions/${sessionA}`, {
          default_policy: 'allow',
        });
        const status = curlStatus(
          WORKER_A,
          'http://httpbin.org/get',
          '--noproxy ""',
        );
        assert.strictEqual(status, 200);
      },
    );
  });
});
