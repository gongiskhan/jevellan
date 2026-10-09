import { test as base, expect, type Page } from '@playwright/test';
import { judgeScreenshot, visionAvailable, visionModel, writeVisionEvidence } from './vision.js';

// Every browser test gets vision checks for free: each screenshot it takes is judged after the test
// with the brief's rubric. Deterministic assertions still decide the behaviour; blocking visual problems
// also fail the test. Without the dedicated Claude test token the checks are recorded as not run.
type Shot = { image: Buffer; path: string };
/** Where the page is: its scroll offset, its height and the window's, and the top of its heading (header or page heading). */
type Layout = { top: number; height: number; window: number; heading: number | null };
const layoutOf = (page: Page) => page.evaluate((): Layout => {
  const heading = document.querySelector('.app-header, .conversation-heading');
  return { top: scrollY, height: document.documentElement.scrollHeight, window: innerHeight, heading: heading ? Math.round(heading.getBoundingClientRect().top) : null };
});
const atTop = (layout: Layout) => ({ top: layout.top, fits: layout.height <= layout.window, headingInView: layout.heading === null || layout.heading >= 0 });
const whole = (layout: Layout) => layout.top === 0 && layout.height <= layout.window && (layout.heading === null || layout.heading >= 0);
/**
 * A full-page capture: the window grows to the page's height, so the page is taken from its top with nothing left to scroll.
 * Content that changes meanwhile (a reply arriving, a working line going away) changes that height, and a page that moves during
 * the capture is drawn shifted, because Playwright reads the scroll offset and captures in two steps: once the header was cut off
 * at the top and an empty strip was left at the bottom. So the window follows the page until it fits, and a capture counts only
 * when the page was at its top, fitting the window with its heading in view, both before and after it, at the same height. The
 * window grows before anything else: scrolling up in the smaller window would leave a reader who follows the end behind.
 */
async function wholePage(page: Page, viewport: { width: number; height: number }, capture: () => Promise<Buffer>) {
  let layout = await layoutOf(page);
  for (let attempt = 1; ; attempt++) {
    await page.setViewportSize({ width: viewport.width, height: Math.max(layout.height, viewport.height) });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await layoutOf(page);
    layout = before;
    if (whole(before)) {
      const image = await capture();
      layout = await layoutOf(page);
      if (whole(layout) && layout.height === before.height && layout.window === before.window) return image;
    }
    if (attempt === 5) {
      expect(atTop(layout), 'A full-page capture starts at the top of a page that fits the window, with its heading in view')
        .toEqual({ top: 0, fits: true, headingInView: true });
      throw new Error(`The page kept changing its height during a full-page capture (${JSON.stringify(layout)}).`);
    }
  }
}
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, info) => {
    const shots: Shot[] = [];
    const original = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      // Evidence shows the settled screen: finished animations and no blinking caret.
      await expect(page.getByText('Rendering…', { exact: true }), 'Markdown content has finished loading before evidence is captured').toHaveCount(0);
      const settled = { animations: 'disabled' as const, caret: 'hide' as const, ...options };
      let image: Buffer;
      const viewport = page.viewportSize();
      if (settled.fullPage && viewport) {
        // A full-page capture stretches the page but keeps the viewport, so sticky headers, composers
        // and save bars would be drawn over content they never cover. Grow the viewport instead.
        try {
          image = await wholePage(page, viewport, () => original({ ...settled, fullPage: false }));
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
