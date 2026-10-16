import { test } from '../../fixtures.ts';

test.use({ trace: 'on' });

test('protected execution rejects a file-level trace override before browser launch', async ({
  page,
}) => {
  await page.setContent('<h1>This protected override must be refused</h1>');
});
