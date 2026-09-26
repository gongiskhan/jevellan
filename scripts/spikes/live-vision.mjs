import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { judgeScreenshot, VisionEvidenceSchema } from '../../tests/e2e/vision.ts';

// Vision checks for live-journey screenshots: node --import tsx scripts/spikes/live-vision.mjs <evidence directory>...
// Each directory holds the evidence.json written by live-journeys.mjs; results go to vision.json beside it.
assert(process.env.JEVELLAN_TEST_CLAUDE_TOKEN, 'The dedicated Claude token is required for vision checks');
const token = process.env.JEVELLAN_TEST_CLAUDE_TOKEN;
for (const directory of process.argv.slice(2).map((entry) => resolve(entry))) {
  const evidence = z.object({ journey: z.string(), screenshots: z.array(z.object({ file: z.string(), expected: z.string() })) }).passthrough().parse(JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')));
  const results = [];
  for (const shot of evidence.screenshots) {
    const layout = shot.file.endsWith('-phone.png') ? '390x844 light' : '1440x900 light';
    try {
      const result = await judgeScreenshot(readFileSync(join(directory, shot.file)), shot.expected);
      results.push(VisionEvidenceSchema.parse({ schema: 'vision-check-v1', label: 'live', model: process.env.JEVELLAN_TEST_VISION_MODEL ?? 'claude-opus-5-5', test: `${evidence.journey} live`, layout, screenshot: shot.file, expected: shot.expected, result }));
    } catch (error) {
      results.push(VisionEvidenceSchema.parse({ schema: 'vision-check-v1', label: 'not run', reason: String(error instanceof Error ? error.message : error).split(token).join('[redacted]').slice(0, 300), test: `${evidence.journey} live`, layout, screenshot: shot.file, expected: shot.expected }));
    }
    const last = results.at(-1); console.log(`${shot.file}: ${last.result ? `ok=${last.result.ok} blocking=${last.result.blocking.length}` : `not run (${last.reason})`}`);
  }
  const text = JSON.stringify({ schema: 'live-vision-v1', journey: evidence.journey, checks: results }, null, 2);
  assert(!text.includes(token)); writeFileSync(join(directory, 'vision.json'), text + '\n', { mode: 0o600 });
}
