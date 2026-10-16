import { expect, test } from '../fixtures.ts';

test('unmarked product assertion failure remains a failed test', async ({ page }) => {
  await page.setContent('<h1>Actual value</h1>');
  await expect(page.getByRole('heading')).toHaveText('Deliberate mismatched value', {
    timeout: 100,
  });
});
