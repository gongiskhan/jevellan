import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from './fixtures.js';
import { z } from 'zod';

const run = promisify(execFile);
const Receipt = z.object({
  schema: z.literal('installation-command-check-v8'), passed: z.literal(true),
  work: z.literal('real-conversation-simulated-providers'),
  firstRun: z.strictObject({ layout: z.enum(['desktop', 'phone']), theme: z.enum(['light', 'dark']), browserSetup: z.literal(true), guidedSetup: z.literal(true), skippedJev: z.boolean(), configuredDoctor: z.literal(true), verifiedPublication: z.literal(true), retainedConversation: z.literal(true), providers: z.literal('simulated') }),
});

// The simulated service occupies the same default port in each journey.
// This project has one worker, separate from the ordinary browser fixtures.
for (const theme of ['light', 'dark'] as const) for (const layout of ['desktop', 'phone'] as const) {
  test(`packed first run, active update, rollback and removal · ${layout} ${theme}`, async ({ browserName }, info) => {
    expect(browserName).toBe('chromium');
    // This includes live dependency delivery, two device installs, packing, update, rollback and removal.
    test.setTimeout(1_200_000);
    const { stdout } = await run(process.execPath, ['scripts/spikes/installation-commands.mjs', '--conversation', ...(layout === 'phone' ? ['--phone'] : []), ...(theme === 'dark' ? ['--dark'] : [])], { cwd: process.cwd(), timeout: 1_170_000, maxBuffer: 4 * 1024 * 1024 });
    const path = /^Verified installation commands: (.+\/result\.json)$/m.exec(stdout)?.[1];
    expect(path).toBeDefined();
    const receipt = Receipt.parse(JSON.parse(await readFile(path!, 'utf8')));
    expect(receipt.firstRun.layout).toBe(layout); expect(receipt.firstRun.theme).toBe(theme); expect(receipt.firstRun.skippedJev).toBe(layout === 'phone');
    if (layout === 'phone') await info.attach('manual-without-jev', { path: join(path!, '..', `first-run-manual-${layout}-${theme}.png`), contentType: 'image/png' });
    await info.attach('installed-journey', { path: path!, contentType: 'application/json' });
    await info.attach('installed-notices', { path: join(path!, '..', 'installation-notices.json'), contentType: 'application/json' });
    for (const name of ['welcome', 'jev', 'connected', 'account', 'project', 'conversation', 'running', 'verified', 'why']) await info.attach(name, { path: join(path!, '..', `first-run-${name}-${layout}-${theme}.png`), contentType: 'image/png' });
  });
}
