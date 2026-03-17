import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import http from 'node:http';

const API = 'http://127.0.0.1:3100';

function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode!, body: text });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForProxy(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await api('GET', '/health');
      if (res.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Proxy not ready');
}

test.beforeAll(async () => {
  execSync('./ncg.sh down', { stdio: 'pipe' });
  execSync('./ncg.sh up', { stdio: 'pipe' });
  await waitForProxy();
  const create = await api('POST', '/api/sessions', { name: 'ui-test-session' });
  const body = create.body as { id: string };
  if (!body?.id) throw new Error(`Failed to create session: ${JSON.stringify(create)}`);
});

test('policy toggle: click deny→allow updates session', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toContainText('clawgate');

  const sessionsTable = page.locator('#sessions table');
  await expect(sessionsTable).toBeVisible({ timeout: 5000 });

  const policyCell = sessionsTable.locator('td').filter({ hasText: /deny|allow/ }).first();
  await expect(policyCell).toBeVisible();

  const toggleBtn = policyCell.getByRole('button', { name: /deny → allow/ });
  await expect(toggleBtn).toBeVisible();

  await toggleBtn.click();

  await page.waitForTimeout(1500);

  const sessionsRes = await api('GET', '/api/sessions');
  const sessions = sessionsRes.body as Array<{ name: string; default_policy: string }>;
  const session = sessions.find((s) => s.name === 'ui-test-session');
  expect(session).toBeDefined();
  expect(session!.default_policy).toBe('allow');
});
