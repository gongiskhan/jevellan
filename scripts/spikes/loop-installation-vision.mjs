import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SecretRedactor } from '../../packages/core/dist/index.js';
import { judgeScreenshot, visionModel, writeVisionEvidence } from '../../tests/e2e/vision.ts';

// Run after collect-installation-evidence: node --import tsx scripts/spikes/loop-installation-vision.mjs
const evidence = z.strictObject({ schema: z.literal('j9-guided-v2'), runs: z.array(z.object({
  schema: z.enum(['installation-command-check-v8', 'installation-command-check-v9']),
  firstRun: z.object({ layout: z.enum(['desktop', 'phone']), theme: z.enum(['light', 'dark']) }),
  screenshots: z.array(z.string().regex(/^screenshots\/phase5-guide-[a-z]+-(desktop|phone)-(light|dark)\.png$/)),
})).length(4) }).parse(JSON.parse(readFileSync('docs/acceptance/J9-guided.json', 'utf8')));
const token = process.env.JEVELLAN_TEST_CLAUDE_TOKEN?.trim();
if (!token) throw new Error('The dedicated vision token is missing.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--connected-only')) throw new Error('Only --connected-only is supported.');
const redactor = new SecretRedactor(); redactor.add(token);
const expected = {
  welcome: 'the passphrase welcome screen with readable text and reachable setup controls',
  jev: 'the Connect Jev setup step with readable text and reachable controls',
  connected: 'the connected Jev confirmation and reachable connection controls. This is a full-page capture: the sticky Save decisions settings bar remains at the original viewport bottom within the stitched image, rather than its normal document position. Do not treat that capture artifact as blocked content farther down the scrolling form. Effort guide descriptions should wrap in multiline fields.',
  account: 'the first-account setup step with readable account controls',
  project: 'the first-project setup step with readable project controls',
  conversation: 'the first-conversation setup step with readable controls',
  running: 'the running conversation with readable transcript and reachable controls',
  verified: 'the finished conversation and verification result without overlap or clipping',
  why: 'the Why panel with readable decision details and reachable controls',
  manual: 'the manual choices after skipped Jev setup with readable controls',
};
const queue = evidence.runs.flatMap(run => run.screenshots.map(screenshot => {
  const match = /^screenshots\/phase5-guide-([a-z]+)-(desktop|phone)-(light|dark)\.png$/.exec(screenshot);
  if (!expected[match[1]] || match[2] !== run.firstRun.layout || match[3] !== run.firstRun.theme) throw new Error('Installation capture does not match its run.');
  return { screenshot, layout: `${match[2]}-${match[3]}`, expected: `${expected[match[1]]} Bright magenta rectangles are intentional screenshot masks over saved secret data, not product overlays or rendering faults.` };
})).filter(shot => !args.length || shot.screenshot.includes('phase5-guide-connected-'));
let next = 0, failed = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < queue.length) {
    const shot = queue[next++];
    let check;
    try {
      const result = await judgeScreenshot(readFileSync(join('docs/acceptance', shot.screenshot)), shot.expected);
      check = { schema: 'vision-check-v1', label: 'live', model: visionModel, test: 'Closing packed installation', ...shot, result };
      if (!result.ok || result.blocking.length) failed++;
    } catch (error) {
      check = { schema: 'vision-check-v1', label: 'not run', test: 'Closing packed installation', ...shot,
        reason: redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 300) };
      failed++;
    }
    writeVisionEvidence(check);
    console.log(`${shot.screenshot}: ${check.result ? `ok=${check.result.ok} blocking=${check.result.blocking.length}` : 'not run'}`);
  }
}));
console.log(`Installation vision: ${queue.length} captures, ${failed} failed or not run.`);
if (failed) process.exitCode = 2;
