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
      // Evidence shows the settled screen: finished animations and no blinking caret.
      const settled = { animations: 'disabled' as const, caret: 'hide' as const, ...options };
      let image: Buffer;
      const viewport = page.viewportSize();
      if (settled.fullPage && viewport) {
        // A full-page capture stretches the page but keeps the viewport, so sticky headers, composers
        // and save bars would be drawn over content they never cover. Grow the viewport instead.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
        try {
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          image = await original({ ...settled, fullPage: false });
        } finally {
          await page.setViewportSize(viewport);
        }
      } else image = await original(settled);
      shots.push({ image, path: options?.path ?? `inline-${shots.length + 1}.png` });
      return image;
    };
    await use(page);
    if (info.status !== info.expectedStatus || !shots.length) return;
    const layout = String(info.project.metadata.layout ?? info.project.name);
    // A check can take several screenshots, so each is described by its own name as one step of the check.
    const expected = (shot: Shot) => {
      const name = shot.path.replace(/^.*\//, '').replace(/\.png$/, '').replace(`-${layout}`, '').replace(/^(?:phase\d+|P?J\d+[a-z]?)-/, '').replaceAll('-', ' ');
      return `the Jevellan web app "${name}" screen at ${layout}, rendered completely and legibly (one of several screens captured during "${info.title}"; the other steps are judged in their own screenshots)`;
    };
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
          expected: expected(shot),
        });
        continue;
      }
      const result = await judgeScreenshot(shot.image, expected(shot));
      writeVisionEvidence({
        schema: 'vision-check-v1',
        label: 'live',
        model: visionModel,
        test: info.title,
        layout,
        screenshot: shot.path,
        expected: expected(shot),
        result,
      });
      if (result.blocking.length) failures.push(`${shot.path}: ${result.blocking.join('; ')}`);
    }
    expect(failures, 'Vision checks found blocking problems').toEqual([]);
  },
});
export { expect };
