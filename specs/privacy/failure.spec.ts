import { expect, test } from './private-auth-fixture.ts';

test('public assertion failure preserves no private input', async ({
  page,
  authenticatedURL,
}, testInfo) => {
  await page.goto(authenticatedURL);
  await page.screenshot({ path: testInfo.outputPath('public-state.png') });
  await expect(page.getByRole('heading')).toHaveText('Deliberate wrong public status', {
    timeout: 100,
  });
});
