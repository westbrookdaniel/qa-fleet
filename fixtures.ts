import { appendFile } from 'node:fs/promises';
import { test as base, chromium, expect } from '@playwright/test';
export function resolvedTraceMode(trace: string | { mode?: string } | undefined) {
  return typeof trace === 'string' ? trace : (trace?.mode ?? 'off');
}

export function assertRequiredTraceMode(mode: string, required: string | undefined) {
  if (required === 'off' && mode !== 'off')
    throw new Error('Protected replay refuses a resolved trace override');
}

// Keeping launch options explicit also makes resolved headed-mode forwarding testable.
export function launchOwnedBrowser(
  headless = true,
  marker?: string,
  launchServer: typeof chromium.launchServer = (options) => chromium.launchServer(options),
) {
  const args = marker ? [`--qa-fleet-custody=${marker}`] : [];
  return launchServer({ headless, args });
}

// Ordinary Playwright fixture. launchServer exposes supported process custody.
export const test = base.extend({
  browser: [
    async ({ trace, headless }, use) => {
      const marker = process.env.QA_FLEET_BROWSER_MARKER;
      const receiptsFile = process.env.QA_FLEET_BROWSER_RECEIPTS;
      if (marker && !receiptsFile) throw new Error('Browser custody receipt path is missing.');
      const traceMode = resolvedTraceMode(trace);
      if (marker && receiptsFile)
        await appendFile(
          receiptsFile,
          `${JSON.stringify({ marker, trace: traceMode, headless, phase: 'before-browser-launch' })}\n`,
          { mode: 0o600 },
        );
      assertRequiredTraceMode(traceMode, process.env.QA_FLEET_REQUIRED_TRACE_MODE);
      const server = await launchOwnedBrowser(headless, marker);
      try {
        if (marker && receiptsFile) {
          const child = server.process();
          await appendFile(
            receiptsFile,
            `${JSON.stringify({ pid: child.pid, marker, trace: traceMode, headless })}\n`,
            { mode: 0o600 },
          );
        }
        const browser = await chromium.connect(server.wsEndpoint());
        try {
          await use(browser);
        } finally {
          await browser.close();
        }
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
