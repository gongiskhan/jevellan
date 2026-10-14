import { expect, type Page } from '@playwright/test';

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
export async function wholePage(page: Page, viewport: { width: number; height: number }, capture: () => Promise<Buffer>) {
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
export async function captureFullPage(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A viewport is required for a settled full-page capture.');
  try { return await wholePage(page, viewport, () => page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' })); }
  finally { await page.setViewportSize(viewport); }
}
