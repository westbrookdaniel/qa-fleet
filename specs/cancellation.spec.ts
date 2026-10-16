import { test } from '../fixtures.ts';

test('bounded cancellation has an owned live browser', async ({ page }) => {
  await page.setContent('<h1>Waiting for cancellation</h1>');
  await page.getByText('Never appears').waitFor({ timeout: 120_000 });
});
