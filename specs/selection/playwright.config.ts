import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  projects: [{ name: 'chromium' }, { name: 'distractor' }],
});
