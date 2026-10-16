import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/selection/**', '**/privacy/**'],
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 15_000,
  projects: [{ name: 'chromium' }],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
});
