import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:3100';
const TS = Date.now();
const WORKER = `int-worker-${TS}`;
const ECHO = `int-echo-${TS}`;
const ECHO_PORT = 8080;
const FWD_ECHO_PORT = 9999;

let sessionId: string;

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
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function workerCurl(url: string, extraArgs = ''): string {
  return execSync(
    `docker exec ${WORKER} curl -s --max-time 5 ${extraArgs} '${url}'`,
    { encoding: 'utf-8', timeout: 10_000 },
  ).trim();
}

function workerCurlStatus(url: string, extraArgs = ''): number {
  const out = execSync(
    `docker exec ${WORKER} curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${extraArgs} '${url}'`,
    { encoding: 'utf-8', timeout: 10_000 },
  );
  return parseInt(out.trim(), 10);
}

before(async () => {
  execSync('./ncg.sh up', { stdio: 'pipe' });

  // Echo server on ncg-internal — avoids host firewall issues entirely
  const echoScript = [
    "require('http').createServer((q,s)=>{",
    "s.writeHead(200,{'content-type':'application/json'});",
    "s.end(JSON.stringify({path:q.url,method:q.method,headers:q.headers}));",
    `}).listen(${ECHO_PORT},'0.0.0.0')`,
  ].join('');
  execSync([
    `docker run -d --rm --name ${ECHO}`,
    '--network ncg-internal',
    `node:22-slim node -e "${echoScript}"`,
  ].join(' '), { stdio: 'pipe' });

  // Separate echo server inside proxy for forward proxy tests
  // (forward proxy uses HTTP only for localhost targets)
  const fwdEchoScript = [
    "require('http').createServer((q,s)=>{",
    "let b='';q.on('data',c=>b+=c);",
    "q.on('end',()=>{s.writeHead(200,{'content-type':'application/json'});",
    "s.end(JSON.stringify({path:q.url,method:q.method,headers:q.headers}))});",
    `}).listen(${FWD_ECHO_PORT})`,
  ].join('');
  execSync(`docker exec -d ncg-proxy node -e "${fwdEchoScript}"`, { stdio: 'pipe' });

  // Start worker (background, no claude)
  execSync([
    'docker run -d --rm',
    `--name ${WORKER}`,
    '--network ncg-internal',
    '-e ANTHROPIC_BASE_URL=http://ncg-proxy:3100/anthropic',
    '-e ANTHROPIC_API_KEY=placeholder',
    'ncg-worker:latest sleep infinity',
  ].join(' '), { stdio: 'pipe' });

  // Register worker as a session
  const output = execSync(`./ncg.sh register ${WORKER}`, { encoding: 'utf-8' });
  const match = output.match(/Session\s+(\S+)/);
  assert.ok(match, `Could not parse session ID from: ${output}`);
  sessionId = match![1];

  await api('PATCH', `/api/sessions/${sessionId}`, { default_policy: 'deny' });
});

after(() => {
  try { execSync(`docker rm -f ${WORKER} ${ECHO}`, { stdio: 'pipe' }); } catch {}
});

describe('integration', () => {
  test('reverse proxy: Anthropic route injects API key and strips prefix', async () => {
    const route = `int-anthropic-${TS}`;
    const create = await api('POST', '/api/routes', {
      name: route,
      type: 'reverse',
      path_prefix: '/anthropic',
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
      inject_header: 'x-api-key',
      inject_value: 'sk-ant-test-secret',
    });
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));

    const grant = await api('POST', `/api/sessions/${sessionId}/permissions`, { route_name: route });
    assert.strictEqual(grant.status, 201, JSON.stringify(grant.body));

    const raw = workerCurl('http://ncg-proxy:3100/anthropic/v1/messages');
    const body = JSON.parse(raw);
    assert.strictEqual(body.path, '/v1/messages', `Unexpected response: ${raw}`);
    assert.strictEqual(body.headers['x-api-key'], 'sk-ant-test-secret');
  });

  test('reverse proxy: second service injects different credential', async () => {
    const route = `int-custom-${TS}`;
    const prefix = `/custom-${TS}`;
    const create = await api('POST', '/api/routes', {
      name: route,
      type: 'reverse',
      path_prefix: prefix,
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
      inject_header: 'Authorization',
      inject_value: 'Bearer ghp_test-token',
    });
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));

    await api('POST', `/api/sessions/${sessionId}/permissions`, { route_name: route });

    const raw = workerCurl(`http://ncg-proxy:3100${prefix}/repos/test`);
    const body = JSON.parse(raw);
    assert.strictEqual(body.path, '/repos/test');
    assert.strictEqual(body.headers['authorization'], 'Bearer ghp_test-token');
  });

  test('forward proxy: injects credentials for matched domain', async () => {
    const route = `int-fwd-${TS}`;
    const create = await api('POST', '/api/routes', {
      name: route,
      type: 'forward',
      domain_pattern: 'localhost',
      inject_header: 'X-Fwd-Secret',
      inject_value: 'fwd-injected-value',
    });
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));

    await api('POST', `/api/sessions/${sessionId}/permissions`, { route_name: route });

    // --noproxy "" forces curl to proxy even localhost targets
    const raw = workerCurl(
      `http://localhost:${FWD_ECHO_PORT}/forward-test`,
      '--noproxy ""',
    );
    const body = JSON.parse(raw);
    assert.strictEqual(body.path, '/forward-test');
    assert.strictEqual(body.headers['x-fwd-secret'], 'fwd-injected-value');
  });

  test('reverse proxy: request without permission returns 403', async () => {
    const route = `int-noperm-${TS}`;
    const prefix = `/noperm-${TS}`;
    await api('POST', '/api/routes', {
      name: route,
      type: 'reverse',
      path_prefix: prefix,
      upstream_url: `http://${ECHO}:${ECHO_PORT}`,
      inject_header: 'X-Test',
      inject_value: 'should-not-appear',
    });

    const status = workerCurlStatus(`http://ncg-proxy:3100${prefix}/test`);
    assert.strictEqual(status, 403);
  });

  test('forward proxy: unmatched domain with deny policy returns 403', async () => {
    const status = workerCurlStatus(
      'http://blocked.example.com:12345/test',
      '--noproxy ""',
    );
    assert.strictEqual(status, 403);
  });
});
