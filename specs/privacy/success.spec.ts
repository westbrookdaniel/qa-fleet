import { expect, test } from './private-auth-fixture.ts';

test('private setup leaves only public navigation evidence', async ({
  page,
  authenticatedURL,
}, testInfo) => {
  await page.goto(authenticatedURL);
  await expect(page.getByRole('heading')).toHaveText('Authenticated');
  await page.screenshot({ path: testInfo.outputPath('public-state.png') });
});
