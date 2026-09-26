import { test as base, expect, type Page } from '@playwright/test';
import { judgeScreenshot, visionAvailable, visionModel, writeVisionEvidence } from './vision.js';

// Every browser test gets vision checks for free: each screenshot it takes is judged after the test
// with the brief's rubric. Deterministic assertions still decide the behaviour; blocking visual problems
// also fail the test. Without the dedicated Claude test token the checks are recorded as not run.
type Shot = { image: Buffer; path: string };
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, info) => {
    const shots: Shot[] = [];
    const original = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      const image = await original(options);
      shots.push({ image, path: options?.path ?? `inline-${shots.length + 1}.png` });
      return image;
    };
    await use(page);
    if (info.status !== info.expectedStatus || !shots.length) return;
    const layout = String(info.project.metadata.layout ?? info.project.name);
    const expected = `the Jevellan web app screen for the check "${info.title}" at ${layout}, rendered completely and legibly`;
    const failures: string[] = [];
    for (const shot of shots) {
      if (!visionAvailable()) {
        writeVisionEvidence({
          schema: 'vision-check-v1',
          label: 'not run',
          reason: process.env.JEVELLAN_VISION === 'off' ? 'Disabled for this run.' : 'JEVELLAN_TEST_CLAUDE_TOKEN is not set.',
          test: info.title,
          layout,
          screenshot: shot.path,
          expected,
        });
        continue;
      }
      const result = await judgeScreenshot(shot.image, expected);
      writeVisionEvidence({
        schema: 'vision-check-v1',
        label: 'live',
        model: visionModel,
        test: info.title,
        layout,
        screenshot: shot.path,
        expected,
        result,
      });
      if (result.blocking.length) failures.push(`${shot.path}: ${result.blocking.join('; ')}`);
    }
    expect(failures, 'Vision checks found blocking problems').toEqual([]);
  },
});
export { expect };
