import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertRequiredTraceMode,
  test as browserTest,
  expect,
  resolvedTraceMode,
} from '../../fixtures.ts';

export const test = browserTest.extend<{
  privateSession: { url: string; statePath: string };
  authenticatedURL: string;
}>({
  privateSession: async ({ trace }, use) => {
    assertRequiredTraceMode(resolvedTraceMode(trace), 'off');
    const secret = process.env.QA_FLEET_CANARY_SECRET;
    if (!secret) throw new Error('Synthetic private auth input missing');
    let authenticated = false;
    const server = createServer(async (request, response) => {
      if (request.url === '/login' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        authenticated = Buffer.concat(chunks).toString() === secret;
        response.statusCode = authenticated ? 204 : 403;
        response.end();
        return;
      }
      const sessionValid =
        authenticated && request.headers.cookie?.split('; ').includes(`session=${secret}`);
      response.statusCode = sessionValid ? 200 : 403;
      response.setHeader('Content-Type', 'text/html');
      response.end(sessionValid ? '<h1>Authenticated</h1>' : '<h1>Access unavailable</h1>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Synthetic session address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(path.join(tmpdir(), 'qa-fleet-private-state-'));
    const statePath = path.join(directory, 'session.json');
    try {
      // Private transport stays outside reported Playwright credential API steps.
      const response = await fetch(`${origin}/login`, { method: 'POST', body: secret });
      if (response.status !== 204) throw new Error('Private authentication unavailable');
      const state = {
        cookies: [
          {
            name: 'session',
            value: secret,
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
            expires: -1,
          },
        ],
        origins: [],
      };
      await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      if (((await stat(statePath)).mode & 0o777) !== 0o600)
        throw new Error('Private session file permissions invalid');
      await use({ url: `${origin}/app`, statePath });
    } finally {
      try {
        await rm(directory, { recursive: true });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
  storageState: async ({ privateSession }, use) => {
    await use(privateSession.statePath);
  },
  authenticatedURL: async ({ privateSession }, use) => {
    await use(privateSession.url);
  },
});

export { expect };
