import { expect, type Locator, type Page } from '@playwright/test';

// The sidebar holds the conversation list, its row actions and the device switcher. Up to 760 px wide (style.css)
// it is a drawer behind Open navigation; wider layouts show it beside the page. Helpers open it as a person would.
const drawerWidth = 760;
export async function openSidebar(page: Page): Promise<Locator> {
  const sidebar = page.getByRole('complementary', { name: 'Conversations', exact: true });
  if (page.viewportSize()!.width <= drawerWidth) {
    const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await expect(sidebar).toBeInViewport();
  return sidebar;
}

/** Opens the device switcher in the sidebar; the caller picks the device. */
export async function openDeviceSwitcher(page: Page): Promise<Locator> {
  await openSidebar(page);
  const switcher = page.locator('.device-switcher');
  await switcher.locator('summary').click();
  return switcher;
}

/**
 * The selected conversation's settings (next step, model, effort and settling its work) open from the
 * gear in its sidebar row actions, in a side panel.
 */
export async function openConversationSettings(page: Page): Promise<Locator> {
  const sidebar = await openSidebar(page);
  const entry = sidebar.locator('.conversation-list-entry').filter({ has: page.locator('.conversation-row.selected') });
  const actions = entry.getByRole('button', { name: /^Actions for / });
  if ((await actions.getAttribute('aria-expanded')) !== 'true') await actions.click();
  await entry.getByRole('group', { name: /^Actions for / }).getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = conversationSettings(page);
  await expect(panel).toBeVisible();
  return panel;
}

export function conversationSettings(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Conversation settings', exact: true });
}

export async function closeConversationSettings(page: Page): Promise<void> {
  const panel = conversationSettings(page);
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
}

/** The confirmation that closes, settles or discards a conversation's work. */
export function settlement(page: Page): Locator {
  return page.getByRole('dialog', { name: /^(Close|Discard) this work$/ });
}

/**
 * Jump to latest never stays over the end of a conversation page. Scrolled up in a window shorter than the page, the live bar
 * shows it; a taller window that brings the end into view without a scroll (as a full-page capture's does) must clear it, or the
 * sticky composer, still grown by the bar, would cover `last`, the content just above it (such as the status line). A reader who
 * follows the end stays pinned when the window shrinks: only the reader scrolling up unpins.
 */
export async function expectNoStaleJump(page: Page, last: Locator): Promise<void> {
  const viewport = page.viewportSize()!; const composer = page.locator('.composer');
  const jump = composer.getByRole('button', { name: /^Jump to latest/ });
  const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    // A short window, so the page is long enough to leave the reader behind at its top. A page that followed its end scrolls
    // back there once it sees the smaller window, so the top is retried until the reader is left behind.
    await page.setViewportSize({ width: viewport.width, height: Math.min(viewport.height, 400) }); await settled();
    await expect(async () => { await page.evaluate(() => window.scrollTo(0, 0)); await expect(jump).toBeVisible({ timeout: 1_000 }); }).toPass({ timeout: 15_000 });
    const bar = (await composer.locator('.cursor-live-bar').boundingBox())!;
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: viewport.width, height: Math.floor(full - bar.height) }); await settled();
    await expect(jump).toBeHidden();
    const [line, footer] = [(await last.boundingBox())!, (await composer.boundingBox())!];
    expect(line.y + line.height, 'the composer covers the end of the page').toBeLessThanOrEqual(footer.y + 0.5);
    await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(jump).toBeHidden();
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 200 }); await settled();
    await expect(jump).toBeHidden();
  } finally {
    await page.setViewportSize(viewport);
  }
}

/**
 * An element brought into view on a page with a sticky composer lands above the composer and its live bar, never under them.
 * Scrolled to the top of a short window (so Jump to latest shows), the first of `controls` that sits below the composer is
 * focused, as a keyboard reader does, and then scrolled to its nearest edge, as a find match or a link does; in a 600 px window,
 * with a long draft that grows the composer to a third of the window (taller than the old fixed 190 px scroll padding), it is
 * scrolled to its nearest edge again. Each time it must end above the composer. The page is left following its end, with
 * nothing focused and an empty composer.
 */
export async function expectClearOfComposer(page: Page, controls: Locator): Promise<void> {
  const viewport = page.viewportSize()!; const composer = page.locator('.composer');
  const jump = composer.getByRole('button', { name: /^Jump to latest/ }); const field = composer.getByRole('textbox');
  const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const check = async (bring: 'focus' | 'nearest', what: string) => {
    const index = await controls.evaluateAll((elements) => {
      const top = document.querySelector('.composer')!.getBoundingClientRect().top;
      return elements.findIndex((element) => element.getBoundingClientRect().bottom > top);
    });
    expect(index, `${what}: a control starts below the composer`).toBeGreaterThanOrEqual(0);
    const control = controls.nth(index);
    await control.evaluate((element, how) => { if (how === 'focus') (element as HTMLElement).focus(); else element.scrollIntoView({ block: 'nearest' }); }, bring);
    await settled();
    const [box, footer] = [(await control.boundingBox())!, (await composer.boundingBox())!];
    expect(box.y + box.height, `${what}: the control ends above the composer`).toBeLessThanOrEqual(footer.y + 0.5);
    await control.evaluate((element) => (element as HTMLElement).blur());
  };
  try {
    await page.setViewportSize({ width: viewport.width, height: Math.min(viewport.height, 400) }); await settled();
    for (const bring of ['focus', 'nearest'] as const) {
      await expect(async () => { await page.evaluate(() => window.scrollTo(0, 0)); await expect(jump).toBeVisible({ timeout: 1_000 }); }).toPass({ timeout: 15_000 });
      await check(bring, `${bring} while Jump to latest shows`);
    }
    const taller = Math.min(viewport.height, 600);
    await page.setViewportSize({ width: viewport.width, height: taller }); await settled();
    await field.fill(Array.from({ length: 16 }, (_, line) => `Draft line ${line + 1}`).join('\n')); await settled();
    expect((await composer.boundingBox())!.height, 'the draft grows the composer').toBeGreaterThan(taller / 3);
    await page.evaluate(() => window.scrollTo(0, 0)); await settled();
    await check('nearest', 'with a grown composer');
  } finally {
    await page.setViewportSize(viewport);
    await field.fill(''); await field.blur();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
  await expect(jump).toBeHidden();
}
