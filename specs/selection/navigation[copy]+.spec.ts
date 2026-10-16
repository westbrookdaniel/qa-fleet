import { expect, test } from '../../fixtures.ts';

test('only the explicit path and project execute', async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe('chromium');
  await page.setContent('<h1>Exact selection</h1>');
  await expect(page.getByRole('heading')).toHaveText('Exact selection');
});
