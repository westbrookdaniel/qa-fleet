import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  projects: [{ name: 'chromium' }],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
});
