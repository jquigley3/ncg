import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test',
  testMatch: '**/ui*.spec.ts',
  timeout: 15_000,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
  },
});
