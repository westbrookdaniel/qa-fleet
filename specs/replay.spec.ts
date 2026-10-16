import { createServer } from 'node:http';
import { test as browserTest, expect } from '../fixtures.ts';

const test = browserTest.extend<{ fixtureURL: string }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  fixtureURL: async ({}, use) => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        "<main><h1>Saved suite replay</h1><button onclick=\"document.querySelector('output').textContent='Confirmed'\">Confirm</button><output>Ready</output></main>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Local fixture address unavailable');
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
});

test('saved navigation and interaction', async ({ page, fixtureURL }, testInfo) => {
  await page.goto(fixtureURL);
  await expect(page.getByRole('heading')).toHaveText('Saved suite replay');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('output')).toHaveText('Confirmed');
  await page.screenshot({ path: testInfo.outputPath('confirmed.png') });
});

test('fresh context starts with the original state', async ({ page, fixtureURL }) => {
  await page.goto(fixtureURL);
  await expect(page.locator('output')).toHaveText('Ready');
});

test('seeded wrong judgment is an expected failure', async ({ page, fixtureURL }) => {
  test.fail();
  await page.goto(fixtureURL);
  await expect(page.locator('output')).toHaveText('Incorrect seeded expectation', { timeout: 100 });
});
