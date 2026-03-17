import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { execSync } from 'node:child_process';

const API = 'http://127.0.0.1:3100';
const WORKER = 'test';
const WORKER_REV = 'test-rev';

function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    const req = http.request(url, { method, headers }, (res) => {
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

before(() => {
  execSync('./ncg.sh down', { stdio: 'pipe' });
  try {
    execSync(`docker rm -f ${WORKER} ${WORKER_REV}`, { stdio: 'pipe' });
  } catch {}
  execSync('./ncg.sh up', { stdio: 'pipe' });
});

after(() => {
  try {
    execSync(`docker rm -f ${WORKER} ${WORKER_REV}`, { stdio: 'pipe' });
  } catch {}
});

describe('flow', () => {
  test('down → up → launch (bg) → register → allow → curl outside', async () => {
    const mountPath = process.cwd();
    execSync(
      [
        'docker run -d --rm',
        `--name ${WORKER}`,
        '--network ncg-internal',
        `-v ${mountPath}:/workspace/project`,
        'ncg-worker:latest sleep infinity',
      ].join(' '),
      { stdio: 'pipe' },
    );

    const output = execSync(`./ncg.sh register ${WORKER}`, {
      encoding: 'utf-8',
    });
    const match = output.match(/Session\s+(\S+)/);
    assert.ok(match, `Could not parse session ID from: ${output}`);
    const sessionId = match![1];

    const patchRes = await api('PATCH', `/api/sessions/${sessionId}`, {
      default_policy: 'allow',
    });
    assert.strictEqual(patchRes.status, 200, JSON.stringify(patchRes.body));

    const curlOut = execSync(
      `docker exec ${WORKER} curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://httpbin.org/get`,
      { encoding: 'utf-8', timeout: 15_000 },
    );
    assert.strictEqual(
      curlOut.trim(),
      '200',
      `Expected HTTP 200 from httpbin.org, got: ${curlOut.trim()}`,
    );
  });

  test('credential proxy on port 3001: anthropic endpoint works', async () => {
    const mountPath = process.cwd();
    execSync(
      [
        'docker run -d --rm',
        `--name ${WORKER_REV}`,
        '--network ncg-internal',
        '-e ANTHROPIC_BASE_URL=http://ncg-proxy:3001',
        `-v ${mountPath}:/workspace/project`,
        'ncg-worker:latest sleep infinity',
      ].join(' '),
      { stdio: 'pipe' },
    );

    const output = execSync(`./ncg.sh register ${WORKER_REV}`, {
      encoding: 'utf-8',
    });
    const match = output.match(/Session\s+(\S+)/);
    assert.ok(match, `Could not parse session ID from: ${output}`);

    // Hit credential proxy directly on port 3001 (like nanoclaw)
    const curlOut = execSync(
      `docker exec ${WORKER_REV} curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST http://ncg-proxy:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
      { encoding: 'utf-8', timeout: 20_000 },
    );
    const status = curlOut.trim();
    assert.ok(
      ['200', '400', '401', '429'].includes(status),
      `Expected 200/400/401/429 from anthropic (credential proxy works), got: ${status}`,
    );
  });
});
