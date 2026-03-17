import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

const WORKER = 'regression-test';

before(() => {
  execSync('./ncg.sh down', { stdio: 'pipe' });
  try { execSync(`docker rm -f ${WORKER}`, { stdio: 'pipe' }); } catch {}
  execSync('./ncg.sh build', { stdio: 'pipe', timeout: 120_000 });
  execSync('./ncg.sh build-worker', { stdio: 'pipe', timeout: 120_000 });
  execSync('./ncg.sh up', { stdio: 'pipe' });
});

after(() => {
  try { execSync(`docker rm -f ${WORKER}`, { stdio: 'pipe' }); } catch {}
});

describe('regression: claude via credential proxy', () => {
  test('credential proxy reaches anthropic (no CONNECT error, no country block)', async () => {
    execSync(
      [
        'docker run -d --rm',
        `--name ${WORKER}`,
        '--network ncg-internal',
        '-e ANTHROPIC_BASE_URL=http://ncg-proxy:3001',
        '-e ANTHROPIC_API_KEY=placeholder',
        'ncg-worker:latest sleep infinity',
      ].join(' '),
      { stdio: 'pipe' },
    );

    execSync(`./ncg.sh register ${WORKER}`, { stdio: 'pipe' });

    // 1. Credential proxy should forward to api.anthropic.com and return an HTTP response
    const statusOut = execSync(
      `docker exec ${WORKER} curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST http://ncg-proxy:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
      { encoding: 'utf-8', timeout: 20_000 },
    );
    const httpStatus = statusOut.trim();
    assert.ok(
      ['200', '400', '401', '429'].includes(httpStatus),
      `Credential proxy failed. Expected 200/400/401/429, got: ${httpStatus}`,
    );

    // 2. Response body must not contain country-block or CONNECT errors
    const bodyOut = execSync(
      `docker exec ${WORKER} curl -s --max-time 15 -X POST http://ncg-proxy:3001/v1/messages -H 'Content-Type: application/json' -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
      { encoding: 'utf-8', timeout: 20_000 },
    );
    const lower = bodyOut.toLowerCase();
    assert.ok(!lower.includes('not available in your country'), `Country block detected: ${bodyOut}`);
    assert.ok(!lower.includes('connect_not_supported'), `CONNECT error from proxy: ${bodyOut}`);
    assert.ok(!lower.includes('eai_again'), `DNS failure (EAI_AGAIN): ${bodyOut}`);
    assert.ok(!lower.includes('proxy connection ended'), `CONNECT tunnel failure: ${bodyOut}`);

    // 3. claude -p should reach the API (auth error expected with placeholder key, but no network error)
    let claudeOut: string;
    let claudeExit = 0;
    try {
      claudeOut = execSync(
        `docker exec -e ANTHROPIC_BASE_URL=http://ncg-proxy:3001 -e ANTHROPIC_API_KEY=placeholder ${WORKER} claude -p "say hi" --output-format json 2>&1`,
        { encoding: 'utf-8', timeout: 30_000 },
      );
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      claudeExit = e.status ?? 1;
      claudeOut = (e.stdout ?? '') + (e.stderr ?? '');
    }

    const claudeLower = claudeOut.toLowerCase();
    // These indicate the proxy is broken — Claude couldn't reach the API at all
    const networkErrors = [
      'eai_again',
      'proxy connection ended',
      'connect_not_supported',
      'econnrefused',
      'etimedout',
      'not available in your country',
    ];
    for (const err of networkErrors) {
      assert.ok(
        !claudeLower.includes(err),
        `claude -p hit network error "${err}". Exit code: ${claudeExit}. Output:\n${claudeOut.slice(0, 500)}`,
      );
    }

    // Auth errors (401, invalid key) are expected and prove the proxy works
    console.log(`claude -p exit code: ${claudeExit}`);
    console.log(`claude -p output (first 300 chars): ${claudeOut.slice(0, 300)}`);
  });
});
