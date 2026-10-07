import type { Locator, Page, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DeviceRosterSchema, ProjectWorkViewSchema, RuntimeListSchema, ThreadViewSchema, type ThreadView } from '../../packages/core/dist/client.js';
import { threadDeviceOffline } from '../../packages/projects/dist/copy.js';
import { expect, test } from './fixtures.js';
import { expectClearOfComposer, expectNoStaleJump, openSidebar } from './navigation.js';

// PJ3, PJ4b, PJ5 and PJ7 (brief 13) on the --projects fixture servers (scripts/test-server.mjs, design 5.5): a GitHub-shaped project
// with a fake GitHub, a fake Jev, scripted coordinator and thread turns and a simulated member device (`Browser member`) over
// local HTTP; Git, worktrees, the bridge, the ledgers, placement, the hub relay and pull requests are real. The journeys build on
// one fresh server's state in order (the greeting thread's pull request is merged in the fourth, the token is removed and
// restored in the seventh, and the tenth moves the `Projects offline` coordinator for good; PJ7 starts its own thread and hands it
// back), so the file runs serially and stops at the first failure.
test.describe.configure({ mode: 'serial', timeout: 600_000 });

const layout = (info: TestInfo) => String(info.project.metadata.layout ?? info.project.name);
const phone = (info: TestInfo) => layout(info).startsWith('phone');
// Turns, publication and pull request polling run on the fixture's timers, behind three other loaded layouts.
const LONG = { timeout: 60_000 };
const PROJECT = '/api/projects/projects_fixture';
// Longer than a thread row, so every capture also checks that a clipped title cannot widen the page or the side column.
const LONG_TITLE = 'Read through the project and list what each file is for, one line per file';

/** Signs in through the API; every journey collects page errors and asserts none at its end. */
async function begin(page: Page) {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  expect((await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } })).ok()).toBe(true);
  await page.goto('/');
  return errors;
}
/** The fixture server's control routes listen 200 ports above the page's server; every body is a versioned fixture document. */
async function control(path: string, body?: Record<string, unknown>) {
  const url = new URL(path, test.info().project.use.baseURL); url.port = String(Number(url.port) + 200);
  const response = await fetch(url, { method: 'POST', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const answer: unknown = await response.json();
  expect(response.status, JSON.stringify(answer)).toBe(200);
  return answer;
}
const pulse = () => control('/projects/pulse');
const pullChange = (change: Record<string, unknown>) => control('/projects/github/1', { schema: 'fixture-pull-change-v1', ...change });
/**
 * A JSON read. The daemon closes idle kept-alive connections after five seconds; a read that leaves on one just as it
 * closes fails with ECONNRESET before reaching the server, so it is sent once more on a fresh connection.
 */
async function read(page: Page, path: string): Promise<unknown> {
  try { return await (await page.request.get(path)).json(); } catch (error) {
    if (!String(error).includes('ECONNRESET')) throw error;
    return (await page.request.get(path)).json();
  }
}
async function work(page: Page) { return ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)); }
async function threadView(page: Page, threadId: string) { return ThreadViewSchema.parse(await read(page, `${PROJECT}/threads/${threadId}`)); }
async function runtimeName(page: Page, runtime: string) {
  return RuntimeListSchema.parse(await read(page, '/api/runtimes')).runtimes.find((entry) => entry.id === runtime)!.displayName;
}
/** The thread's id once the coordinator or the owner started it. */
async function threadId(page: Page, title: string) {
  await expect.poll(async () => (await work(page)).threads.some((thread) => thread.title === title), LONG).toBe(true);
  return (await work(page)).threads.find((thread) => thread.title === title)!.id;
}
/** The one-line placement summary of a started thread, as the chat's tool row and the start toast read it. */
async function placementSummary(page: Page, view: ThreadView) {
  const fallback = view.placement.source === 'fallback' && view.placement.error ? ` · placed without Jev: ${view.placement.error.message}` : '';
  return `${await runtimeName(page, view.thread.runtime)} ${view.thread.modelLabel} · ${view.thread.effort} · Worktree · ${view.deviceName}${fallback}`;
}

/**
 * A ` · ` line wraps between its parts: every part that is narrower than the line on its own sits on one line (a branch name
 * never breaks while it fits); only a part wider than the whole line may break.
 * At the page's width and at every line width of a 320 to 430 px phone, a separator stays on the line of the word before it
 * (never starting a line or standing alone), the last two parts share a line whenever they fit one together (`6 ms` never sits
 * alone), and a clamped line (the placement line) still shows its last part, the device.
 */
async function expectWholeParts(line: Locator) {
  expect(await line.locator('.pw-part').evaluateAll((parts) => parts.length > 1 && parts.every((part) => {
    const probe = part.cloneNode(true) as HTMLElement; probe.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap; max-width: none';
    part.parentElement!.append(probe); const wanted = probe.getBoundingClientRect().width; probe.remove();
    const lines = Math.round(part.getBoundingClientRect().height / parseFloat(getComputedStyle(part).lineHeight));
    return wanted > part.parentElement!.clientWidth || lines === 1;
  }))).toBe(true);
  expect(await line.evaluate((element) => {
    const problems: string[] = [];
    for (const width of [element.clientWidth, ...Array.from({ length: 12 }, (_, step) => 296 + step * 10)]) {
      const probe = element.cloneNode(true) as HTMLElement;
      probe.style.cssText = `position: absolute; visibility: hidden; left: 0; top: 0; width: ${width}px`;
      element.parentElement!.append(probe);
      // Every visible character with its row, told apart by the top of its box.
      const characters: { node: Text; top: number; bottom: number; text: string }[] = [];
      const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (let index = 0; index < node.length; index++) {
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
          const box = range.getClientRects()[0];
          if (box && box.width > 0 && node.data[index]!.trim()) characters.push({ node, top: Math.round(box.top), bottom: box.bottom, text: node.data[index]! });
        }
      }
      const rows = new Map<number, string>();
      for (const character of characters) {
        const row = [...rows.keys()].find((top) => Math.abs(top - character.top) <= 2) ?? character.top;
        rows.set(row, (rows.get(row) ?? '') + character.text);
      }
      for (const row of rows.values()) if (row.startsWith('·')) problems.push(`${width}px: a row starts with a separator: ${row}`);
      const parts = [...probe.querySelectorAll<HTMLElement>('.pw-part')];
      const [before, last] = parts.slice(-2) as [HTMLElement, HTMLElement];
      const pair = document.createElement('span'); pair.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap';
      pair.append(before.cloneNode(true), ' ', last.cloneNode(true)); probe.append(pair);
      const together = pair.getBoundingClientRect().width <= probe.clientWidth; pair.remove();
      const inPart = (part: HTMLElement) => characters.filter((character) => part.contains(character.node));
      if (together && Math.abs(inPart(before).at(-1)!.top - inPart(last)[0]!.top) > 2) problems.push(`${width}px: the last part sits alone: ${last.textContent}`);
      if (getComputedStyle(element).webkitLineClamp !== 'none' && inPart(last).at(-1)!.bottom > probe.getBoundingClientRect().bottom + 0.5) {
        problems.push(`${width}px: the clamp hides the last part: ${last.textContent}`);
      }
      probe.remove();
    }
    return problems;
  })).toEqual([]);
}

/**
 * Muted text stays readable (WCAG AA, 4.5:1): every visible text and placeholder drawn in the shared muted ink, against the
 * backgrounds under it. Disabled controls are exempt, as in WCAG.
 */
async function expectReadableMutedText(page: Page) {
  expect(await page.evaluate(() => {
    const rgba = (value: string) => {
      const numbers = value.match(/[\d.]+/g)!.map(Number);
      return value.startsWith('color(') ? [numbers[0]! * 255, numbers[1]! * 255, numbers[2]! * 255, numbers[3] ?? 1] : [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3] ?? 1];
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((index) => top[index]! * top[3]! + under[index]! * (1 - top[3]!));
    const luminance = (color: number[]) => color.slice(0, 3).map((value) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const background = (element: Element) => {
      const chain: Element[] = []; for (let at: Element | null = element; at; at = at.parentElement) chain.unshift(at);
      return chain.reduce((under, at) => over(rgba(getComputedStyle(at).backgroundColor), under), [255, 255, 255]);
    };
    const probe = document.createElement('span'); probe.style.color = 'var(--ink-3)'; document.body.append(probe);
    const muted = getComputedStyle(probe).color; probe.remove();
    const exempt = (element: Element) => !!element.closest(':disabled, [aria-disabled="true"], .pw-disabled');
    const problems: string[] = []; let checked = 0;
    const check = (element: Element, color: string, what: string) => {
      const value = ratio(over(rgba(color), background(element)), background(element)); checked++;
      if (value < 4.5) problems.push(`${what} (${element.className || element.tagName}): ${value.toFixed(2)}`);
    };
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      if (style.color !== muted || style.visibility !== 'visible' || !box.width || !box.height || exempt(element)) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent!.trim()).join('');
      if (text) check(element, style.color, text.slice(0, 40));
    }
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]')) {
      const color = getComputedStyle(field, '::placeholder').color; const box = field.getBoundingClientRect();
      if (!field.value && color === muted && box.width && !exempt(field)) check(field, color, `placeholder ${field.placeholder}`);
    }
    return checked ? problems : ['no muted text found'];
  })).toEqual([]);
}

/**
 * While the coordinator works, the chat field stays one line and its placeholder ends 28 px or more before Stop; one that does
 * not fit ends in an ellipsis, or fades out while the field has focus (where Chromium draws no ellipsis), never mid-letter.
 */
async function expectPlaceholderClearOfStop(page: Page) {
  await expect.poll(() => page.locator('.pw-composer').evaluate((form) => {
    const field = form.querySelector('textarea')!; const style = getComputedStyle(field); const box = field.getBoundingClientRect();
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const start = box.left + parseFloat(style.paddingLeft); const contentEnd = box.right - parseFloat(style.paddingRight);
    const fits = start + context.measureText(field.placeholder).width <= contentEnd;
    const lines = (box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
    const shortened = document.activeElement === field ? style.maskImage.startsWith('linear-gradient') : getComputedStyle(field, '::placeholder').textOverflow === 'ellipsis';
    return { oneLine: lines < 1.5, clear: form.querySelector('.pw-stop-icon')!.getBoundingClientRect().left - contentEnd >= 28, endsCleanly: fits || shortened };
  })).toEqual({ oneLine: true, clear: true, endsCleanly: true });
}

/** A thread transcript's prompts, tool rows and report cards share their left and right edges. */
async function expectAlignedCards(transcript: Locator) {
  const edges = await transcript.locator('.cursor-turn-user, .cursor-tool, .pw-report').evaluateAll((cards) =>
    cards.map((card) => { const box = card.getBoundingClientRect(); return `${Math.round(box.left)}-${Math.round(box.right)}`; }));
  expect(edges.length).toBeGreaterThan(2);
  expect(new Set(edges)).toEqual(new Set([edges[0]]));
}

/**
 * Evidence for one step: transient confirmations are read by the journey first, then dismissed so they never cover the
 * screen; the layout must not scroll sideways. Pages are captured whole, dialogs and panels as the viewport shows them.
 * The file stem starts with the journey that took it (`PJ3`, `PJ4b`), the first word of the test title.
 */
async function shot(page: Page, name: string, fullPage = true) {
  const toasts = page.locator('.toast:not(.hub-wait)');
  for (const toast of await toasts.all()) await toast.getByRole('button', { name: 'Dismiss message', exact: true }).click().catch(() => undefined);
  // The pointer rests where the last click landed; a full-page capture grows the viewport, and the row or field that then
  // slides under it would show its hover state (a second "selected" sidebar row). The corner hovers nothing.
  await page.mouse.move(0, 0);
  await expect(toasts).toHaveCount(0);
  // Neither the page, the side column (a scroll container beside the chat) nor an open panel's heading may scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && [...document.querySelectorAll('.pw-side, .panel-heading')].every((box) => box.scrollWidth <= box.clientWidth))).toBe(true);
  const journey = test.info().title.split(' ', 1)[0];
  await page.screenshot({ path: `docs/acceptance/screenshots/${journey}-${name}-${layout(test.info())}.png`, fullPage });
}

/**
 * Waits until the coordinator has taken every event of the chat and stays idle: no chat entry waits for it, and two reads a
 * second apart find it idle after the same number of turns (more than `after`, when given). The pull request events reach the
 * coordinator as a turn; a full-page capture taken while that turn ends saw its reply arrive and its working line go.
 */
async function coordinatorSettled(page: Page, after = -1) {
  let last = -1;
  await expect.poll(async () => {
    const { coordinator } = await work(page);
    const waiting = await page.locator('.pw-timeline .pw-pending').count();
    const turns = coordinator.state === 'idle' && !waiting ? coordinator.session?.turns ?? 0 : -1;
    const same = turns > after && turns === last; last = turns; return same;
  }, { ...LONG, intervals: [1_000] }).toBe(true);
  await expect(page.locator('.pw-chip')).toHaveText('Idle', LONG);
}

/**
 * Clicks a control that stays put while the page scrolls (the sticky heading, tab bar and side column, the inspector panel)
 * where a finger would. Playwright's click first scrolls the control's place in the document into view, which for a
 * stuck element jumps the page back to its top and would leave `Jump to latest` in the evidence.
 */
async function tap(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!; const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // As Playwright's own click does, wait until nothing (a closing drawer, a toast) covers the control at that point.
  await expect.poll(() => control.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), point)).toBe(true);
  await page.mouse.click(point.x, point.y);
}

/** The sidebar's Projects section (12.1); on phones the navigation drawer opens first. */
async function projectsSection(page: Page) {
  return (await openSidebar(page)).getByRole('navigation', { name: 'Projects', exact: true });
}
const projectRow = (section: Locator, name: string) => section.getByRole('button', { name: new RegExp(`^${name}`) });
async function closeDrawer(page: Page, info: TestInfo) {
  if (phone(info)) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
}
/** Opens a project page from the sidebar, as a person would. */
async function openProject(page: Page, name: string) {
  const row = projectRow(await projectsSection(page), name);
  await row.scrollIntoViewIfNeeded(); await row.click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message the coordinator', exact: true });
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Project sections', exact: true }).getByRole('tab', { name: new RegExp(`^${name}`) });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
async function openSettings(page: Page) {
  await tap(page, page.locator('summary[aria-label="Project menu"]'));
  await tap(page, page.getByRole('button', { name: 'Project settings', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Project settings', exact: true });
  // The dialog reads the settings when it opens and saves with the revision it read.
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  return dialog;
}

test('PJ3 project page opens from the sidebar and the coordinator chat streams', async ({ page }, info) => {
  const errors = await begin(page);
  const section = await projectsSection(page);
  await expect(section.getByRole('button', { name: 'Projects section', exact: true })).toHaveAttribute('aria-expanded', 'true');
  for (const name of ['Projects external', 'Projects fixture', 'Projects offline']) await expect(projectRow(section, name)).toHaveCount(1);
  const row = projectRow(section, 'Projects fixture'); await row.scrollIntoViewIfNeeded(); await row.click();
  await expect(page).toHaveURL(/\/projects\/projects_fixture$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Projects fixture', exact: true })).toBeVisible();
  // Opening a project closes the phone drawer; its row is marked as the current page.
  await expect(projectRow(await projectsSection(page), 'Projects fixture')).toHaveAttribute('aria-current', 'page');
  await closeDrawer(page, info);
  // No coordinator session yet: the chip shows the planned one; the settings effort `medium` runs as `high` here (D91).
  await expect(page.locator('.pw-chip')).toHaveText('Idle');
  await expect(page.locator('.pw-session')).toHaveText('Claude Code Fable · high');
  for (const name of ['New thread', 'Notebook']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('summary[aria-label="Project menu"]')).toBeVisible();
  await expect(page.getByText('Describe what you want done. The coordinator splits it into threads, runs them on your devices and accounts, and brings back what needs you.', { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveAttribute('placeholder', 'Tell the coordinator what you need');
  const tabs = page.getByRole('tablist', { name: 'Project sections', exact: true });
  if (phone(info)) {
    await expect(tabs.getByRole('tab')).toHaveText(['Chat', 'Waiting', 'Threads', 'Pull requests']);
    await expect(tab(page, 'Chat')).toHaveAttribute('aria-selected', 'true');
    await tap(page, tab(page, 'Threads'));
    await expect(region(page, 'Running')).toContainText('No threads running.');
    await expect(region(page, 'Concluded').getByRole('link', { name: /^Write the welcome copy/ }).locator('.pw-outcome')).toHaveText('Merged #7');
    await tap(page, tab(page, 'Pull requests')); await expect(region(page, 'Pull requests')).toContainText('No open pull requests.');
    await tap(page, tab(page, 'Waiting')); await expect(region(page, 'Waiting for you')).toContainText('Nothing waiting.');
    await tap(page, tab(page, 'Chat')); await expect(composer(page)).toBeVisible();
  } else {
    // Two columns: the chat and the sections in the brief's order, each with its count and its empty line.
    await expect(tabs).toBeHidden();
    await expect(page.locator('.pw-side .pw-section-heading')).toHaveText(['Waiting for you 0', 'Running 0', 'Pull requests 0', 'Concluded 1']);
    await expect(region(page, 'Waiting for you')).toContainText('Nothing waiting.');
    await expect(region(page, 'Running')).toContainText('No threads running.');
    await expect(region(page, 'Pull requests')).toContainText('No open pull requests.');
    await expect(region(page, 'Concluded').getByRole('link', { name: /^Write the welcome copy/ }).locator('.pw-outcome')).toHaveText('Merged #7');
  }
  await expectReadableMutedText(page);
  await shot(page, 'empty-chat');

  // The scripted coordinator holds its turn after its first words until the fixture releases it.
  await composer(page).fill('PJ3: add a greeting'); await composer(page).press('Enter');
  await expect(page.locator('.pw-owner').filter({ hasText: 'PJ3: add a greeting' })).toBeVisible();
  const working = page.getByRole('status').filter({ hasText: 'Coordinator is working…' });
  await expect(working).toBeVisible(LONG);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.locator('.pw-chip')).toHaveText('Working…');
  await expect(composer(page)).toHaveValue('');
  // The chip keeps its whole text and its padding on every layout: the copy's own ellipsis is the only one.
  expect(await page.locator('.pw-chip').evaluate((chip) => {
    const style = getComputedStyle(chip);
    return { clipped: chip.scrollWidth > chip.clientWidth, size: style.fontSize, padding: [style.paddingLeft, style.paddingRight] };
  })).toEqual({ clipped: false, size: '11px', padding: ['7px', '7px'] });
  // The placeholder keeps one line and ends at least 28 px before Stop, in an ellipsis where it does not fit (390 and 320 px phones).
  await expectPlaceholderClearOfStop(page);
  if (phone(info)) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 320, height: size.height });
    try { await expectPlaceholderClearOfStop(page); } finally { await page.setViewportSize(size); }
  }
  await shot(page, 'coordinator-working');
  await expect(working).toBeVisible();
  expect(await control('/projects/release', { schema: 'fixture-release-v1', marker: 'PJ3: add a greeting' })).toEqual({ released: 1 });

  // The thread start streams in as a muted tool row linking to the thread, then the reply as Markdown.
  const id = await threadId(page, 'Add a greeting');
  const tool = page.getByRole('link', { name: /^Started "Add a greeting" · / });
  await expect(tool).toBeVisible(LONG);
  await expect(tool).toHaveText(`Started "Add a greeting" · ${await placementSummary(page, await threadView(page, id))}`);
  await expect(tool).toHaveAttribute('href', `/projects/projects_fixture/threads/${id}`);
  const reply = page.locator('.pw-reply').filter({ hasText: 'Started "Add a greeting".' });
  await expect(reply).toHaveText('Started "Add a greeting".', LONG);
  const entries = await page.locator('.pw-timeline > *').allTextContents();
  expect(entries.findIndex((entry) => entry.startsWith('Started "Add a greeting" · '))).toBeLessThan(entries.indexOf('Started "Add a greeting".'));
  await shot(page, 'chat-reply');
  expect(errors).toEqual([]);
});

test('PJ3 a decision is answered from the Waiting tab', async ({ page }, info) => {
  const errors = await begin(page);
  await openProject(page, 'Projects fixture');
  await composer(page).fill('PJ3 decision'); await composer(page).press('Enter');
  const question = 'Which greeting should the page use?';
  const card = page.getByRole('region', { name: question, exact: true });
  if (phone(info)) {
    // The question arrives while the chat is shown: the Waiting tab gains its magenta badge.
    await expect(tab(page, 'Waiting').locator('.suggestion-count')).toHaveText('1', LONG);
    await expect(tab(page, 'Chat')).toHaveAttribute('aria-selected', 'true');
    const row = projectRow(await projectsSection(page), 'Projects fixture');
    await expect(row.locator('.suggestion-count')).toHaveText('1 waiting', LONG);
    await shot(page, 'projects-sidebar', false);
    await closeDrawer(page, info);
    // Named for what it shows: the chat still selected, with the badge on the Waiting tab (the vision judge reads the name).
    await shot(page, 'chat-with-waiting-badge');
    await tap(page, tab(page, 'Waiting'));
    await expect(card).toBeVisible();
  } else {
    await expect(region(page, 'Waiting for you').locator('.pw-section-heading')).toHaveText('Waiting for you 1', LONG);
    await expect(projectRow(page.getByRole('navigation', { name: 'Projects', exact: true }), 'Projects fixture').locator('.suggestion-count')).toHaveText('1 waiting', LONG);
  }
  await expect(card.locator('.pw-source')).toHaveText(/^From the coordinator · /);
  await expect(card.locator('.pw-question')).toHaveText(question);
  await expect(card.locator('.pw-option > span')).toHaveText(['Hello', 'Welcome']);
  await expect(card.locator('.pw-option > small')).toHaveText(['Short and friendly', 'More formal']);
  await expect(card.getByRole('textbox', { name: 'Answer in your own words', exact: true })).toHaveAttribute('placeholder', 'Answer in your own words');
  await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await shot(page, 'decision-card');
  if (phone(info)) {
    // Below 1180 px a page opened with a question waiting starts on the Waiting tab.
    await page.reload();
    await expect(tab(page, 'Waiting')).toHaveAttribute('aria-selected', 'true');
    await expect(card).toBeVisible();
  }

  await card.locator('.pw-option').filter({ hasText: /^Hello/ }).click();
  const waiting = region(page, 'Waiting for you');
  await expect(waiting.getByRole('status')).toHaveText('Sent to the coordinator.');
  await expect(card).toHaveCount(0);
  await expect(waiting.getByText('Nothing waiting.', { exact: true })).toBeVisible();
  const answered = waiting.locator('details.pw-answered');
  await expect(answered.locator('summary')).toHaveText('Answered 1');
  await expect(answered).not.toHaveAttribute('open');
  if (phone(info)) await expect(tab(page, 'Waiting').locator('.suggestion-count')).toHaveCount(0);
  await shot(page, 'decision-answered');
  await answered.locator('summary').click();
  await expect(answered.locator('.pw-answered-question')).toHaveText(question);
  await expect(answered.locator('.pw-answered-answer')).toHaveText('Hello');
  await expect.poll(async () => (await work(page)).decisions.answered[0]?.answer?.optionLabel).toBe('Hello');
  expect(errors).toEqual([]);
});

test('PJ3 a running thread shows its transcript, report card and accepts an interrupting message', async ({ page }, info) => {
  const errors = await begin(page);
  await openProject(page, 'Projects fixture');
  await tap(page, page.getByRole('button', { name: 'New thread', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(LONG_TITLE);
  // The scripted thread keeps working on a task marked `PJ3 long` until it is released or interrupted.
  await dialog.getByRole('textbox', { name: 'Task', exact: true }).fill('PJ3 long: read the project files, then wait for my message.');
  await dialog.locator('summary').filter({ hasText: 'Placement' }).click();
  for (const name of ['Isolation', 'Model', 'Effort', 'Device']) {
    const select = dialog.getByRole('combobox', { name, exact: true });
    await expect(select).toHaveValue(''); await expect(select.locator('option').first()).toHaveText('Automatic');
  }
  const isolation = dialog.getByRole('combobox', { name: 'Isolation', exact: true });
  // Main isolation exists since phase 6: on this main-policy project Main is offered, with no note under the field.
  await expect(isolation.locator('option')).toHaveText(['Automatic', 'Worktree', 'Main']);
  await expect(isolation.locator('option[value="main"]')).toHaveJSProperty('disabled', false);
  await expect(isolation).not.toHaveAttribute('aria-describedby');
  await expect(dialog.getByText('Main isolation is not available yet.', { exact: true })).toHaveCount(0);
  // Every device of the mesh is offered in roster order (D281); one no thread can run on stays listed, disabled, with placement's reason.
  const roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster'));
  const device = dialog.getByRole('combobox', { name: 'Device', exact: true });
  await expect(device.locator('option')).toHaveText(['Automatic', ...roster.devices.filter((row) => !row.revoked)
    .map((row) => row.device.name === 'Offline fixture' ? 'Offline fixture: offline' : row.device.name)]);
  await expect(device.locator('option', { hasText: 'Offline fixture: offline' })).toHaveJSProperty('disabled', true);
  await expect(device.locator('option', { hasText: 'Browser member' })).toHaveJSProperty('disabled', false);
  await shot(page, 'new-thread-modal', false);
  await dialog.getByRole('button', { name: 'Start thread', exact: true }).click();

  // A started thread opens its page; the toast tells where it was placed.
  await expect(page).toHaveURL(/\/projects\/projects_fixture\/threads\/thread_[^/]+$/, LONG);
  const id = new URL(page.url()).pathname.split('/')[4]!;
  const toast = page.locator('.toast.success > span'); await expect(toast).toBeVisible(); const placed = await toast.textContent();
  await expect(page.getByRole('heading', { level: 1, name: LONG_TITLE, exact: true })).toBeVisible();
  await expect.poll(async () => (await threadView(page, id)).thread.branch ?? '', LONG).toMatch(/^jv\//);
  const view = await threadView(page, id); const runtime = await runtimeName(page, view.thread.runtime);
  expect(placed).toBe(await placementSummary(page, view));
  await expect(page.locator('.pw-state-chip')).toHaveText('Running', LONG);
  await expect(page.locator('.pw-placement-line')).toHaveText(`${runtime} · ${view.thread.modelLabel} · ${view.thread.effort} effort · ${view.thread.accountLabel} · Worktree on ${view.thread.branch} · ${view.deviceName}`);
  await expectWholeParts(page.locator('.pw-placement-line'));
  const transcript = page.locator('[aria-label="Thread transcript"]');
  await expect(transcript.locator('.cursor-tool-header > span:first-child')).toHaveText(['Read', 'Grep', 'Bash', 'Read'], LONG);
  await expect(page.getByRole('status').filter({ hasText: 'Working on turn 1…' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0);
  await shot(page, 'thread-running');

  // Back on the project page the thread is a Running row with its meta; the sidebar counts it while its turn runs.
  await page.getByRole('link', { name: 'Back to the project', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects fixture', exact: true })).toBeVisible();
  if (phone(info)) await tap(page, tab(page, 'Threads'));
  const row = region(page, 'Running').getByRole('link', { name: new RegExp(`^${LONG_TITLE}`) });
  await expect(row.locator('.pw-row-meta')).toHaveText(`${runtime} · ${view.thread.modelLabel} · ${view.thread.effort} · Worktree · ${view.deviceName}`);
  await expect(projectRow(await projectsSection(page), 'Projects fixture').locator('.pw-sidebar-running')).toHaveText('1 running', LONG);
  await closeDrawer(page, info);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/projects/projects_fixture/threads/${id}$`));

  // An interrupting message ends the running turn; the next turn reads it and reports.
  const message = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await message.fill('Please also note the README title.');
  await page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true }).check();
  await message.press('Enter');
  const report = page.getByRole('region', { name: 'Report · turn 2', exact: true });
  await expect(report).toBeVisible(LONG);
  await expect(report.locator('.pw-badge')).toHaveText('Progress');
  await expect(report).toContainText('Read your message and adjusted the plan.');
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  // The turn's closing words are its report's summary: the transcript shows them once, in the card.
  await expect(transcript.getByText('Please also note the README title.', { exact: true })).toHaveCount(1, LONG);
  await expect(transcript.getByText('Read your message and adjusted the plan.', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true })).toHaveCount(0);
  await expect(message).toHaveValue('');
  await expectAlignedCards(transcript);
  await expectReadableMutedText(page);
  await expectNoStaleJump(page, transcript);
  await expectClearOfComposer(page, transcript.locator('summary, button, a[href]'));
  await shot(page, 'thread-report');

  // Why on a thread whose title is longer than the panel: the title in the eyebrow truncates, while the panel title and Close
  // stay whole and the heading never scrolls sideways.
  await tap(page, page.getByRole('button', { name: 'Why', exact: true }));
  const why = page.getByRole('dialog', { name: 'Why this placement', exact: true });
  await expect(why.locator('.panel-eyebrow')).toHaveText(LONG_TITLE);
  expect(await why.locator('.panel-heading').evaluate((heading) => {
    const box = (selector: string) => heading.querySelector(selector)!.getBoundingClientRect();
    const title = heading.querySelector('h2')!;
    return heading.scrollWidth <= heading.clientWidth && title.scrollWidth <= title.clientWidth
      && box('.panel-eyebrow').right <= box('h2').left && box('h2').right <= box('button').left;
  })).toBe(true);
  await tap(page, why.getByRole('button', { name: 'Close panel', exact: true }));
  await expect(why).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PJ3 a pull request merges through the modal and moves to Concluded', async ({ page }, info) => {
  const errors = await begin(page);
  // The greeting thread of the first journey opened pull request #1; new pull requests start with their checks queued.
  await expect.poll(async () => (await work(page)).pullRequests.find((entry) => entry.title === 'Add a greeting')?.pr?.number, LONG).toBe(1);
  const url = (await work(page)).pullRequests.find((entry) => entry.title === 'Add a greeting')!.pr!.url;
  await openProject(page, 'Projects fixture');
  // A chat entry's control brought into view lands above the coordinator's composer (see expectClearOfComposer).
  await expectClearOfComposer(page, page.locator('.pw-timeline').locator('a[href], button, summary'));
  if (phone(info)) await tap(page, tab(page, 'Pull requests'));
  const pulls = region(page, 'Pull requests');
  const pr = pulls.locator('article.pw-pr').filter({ hasText: '#1 Add a greeting' });
  await expect(pulls.locator('.pw-section-heading')).toHaveText('Pull requests 1');
  const title = pr.getByRole('link', { name: '#1 Add a greeting', exact: true });
  await expect(title).toHaveAttribute('href', url); await expect(title).toHaveAttribute('target', '_blank');
  await expect(pr.getByRole('link', { name: 'Open on GitHub', exact: true })).toHaveAttribute('href', url);
  const badges = pr.locator('.pw-badge');
  const merge = pr.getByRole('button', { name: 'Merge', exact: true });
  await expect(badges).toHaveText(['Checks running'], LONG);
  await expect(merge).toBeEnabled();

  // Failing checks and conflicts disable Merge with the reason as its tooltip.
  await pullChange({ checks: 'failing' }); await pulse();
  await expect(badges).toHaveText(['Checks failing'], LONG);
  await expect(merge).toBeDisabled(); await expect(merge).toHaveAttribute('title', 'Checks are failing. Ask the thread to fix them first.');
  await pullChange({ checks: 'passing', mergeable: 'dirty' }); await pulse();
  await expect(badges).toHaveText(['Checks passing', 'Conflicts'], LONG);
  await expect(merge).toBeDisabled(); await expect(merge).toHaveAttribute('title', 'This pull request has conflicts. Ask the thread to resolve them first.');
  await coordinatorSettled(page);
  await shot(page, 'pull-request-conflict');
  await pullChange({ mergeable: 'clean' }); await pulse();
  await expect(badges).toHaveText(['Checks passing'], LONG);
  await expect(merge).toBeEnabled(); await expect(merge).not.toHaveAttribute('title');
  await coordinatorSettled(page);
  await shot(page, 'pull-requests');

  const turnsBefore = (await work(page)).coordinator.session?.turns ?? 0;
  await tap(page, merge);
  const dialog = page.getByRole('dialog', { name: 'Squash and merge #1?', exact: true });
  await expect(dialog.locator('.pw-confirm-body')).toHaveText("Add a greeting will be squashed into main. The thread's worktree is removed afterwards.", LONG);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await shot(page, 'merge-modal', false);
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog).toHaveCount(0, LONG);
  await expect(pulls).toContainText('No open pull requests.', LONG);
  if (phone(info)) await tap(page, tab(page, 'Threads'));
  const concluded = region(page, 'Concluded');
  await expect(concluded.getByRole('link', { name: /^Add a greeting/ }).locator('.pw-outcome')).toHaveText('Merged #1', LONG);
  await expect(concluded.locator('.pw-section-heading')).toHaveText('Concluded 2');
  // The merge reaches the coordinator as an event; the capture waits until it has answered.
  await coordinatorSettled(page, turnsBefore);
  await shot(page, 'concluded');
  const merged = await threadView(page, await threadId(page, 'Add a greeting'));
  expect({ state: merged.thread.state, pr: merged.thread.pr?.state }).toEqual({ state: 'done', pr: 'merged' });
  expect(errors).toEqual([]);
});

test('PJ3 the notebook can be edited', async ({ page }) => {
  const errors = await begin(page);
  await openProject(page, 'Projects fixture');
  const toggle = page.getByRole('button', { name: 'Notebook', exact: true });
  await tap(page, toggle); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('dialog', { name: 'Notebook', exact: true });
  await expect(panel.locator('.panel-eyebrow')).toHaveText('Projects fixture');
  await expect(panel.getByText('Prefer short greetings.', { exact: true })).toBeVisible();
  await expect(panel.locator('.pw-notebook-meta')).toHaveText(/^Updated by the coordinator · /);
  await tap(page, panel.getByRole('button', { name: 'Edit', exact: true }));
  const text = panel.getByRole('textbox', { name: 'Notebook content', exact: true });
  await expect(text).toHaveValue('Prefer short greetings.\n'); await expect(text).toBeFocused();
  await text.fill('Prefer short greetings.\n\n- Keep the greeting in `greeting.txt`.\n');
  await tap(page, panel.getByRole('button', { name: 'Save', exact: true }));
  await expect(text).toHaveCount(0);
  await expect(panel.getByRole('listitem')).toHaveText('Keep the greeting in greeting.txt.');
  await expect(panel.locator('.pw-notebook-meta')).toHaveText(/^Updated by you · /);
  // The panel sits beside the chat, which stays where the reader left it.
  await expect(page.locator('.pw-jump')).toHaveCount(0);
  await shot(page, 'notebook-panel', false);

  // The coordinator writes the notebook while the owner edits it: the save is refused in the panel, never by a reload.
  await tap(page, panel.getByRole('button', { name: 'Edit', exact: true }));
  expect(await control('/projects/notebook', { schema: 'fixture-notebook-v1', content: 'Prefer short, friendly greetings.\n' })).toEqual({ revision: 3 });
  const draft = 'Prefer short greetings.\n\n- Keep the greeting in `greeting.txt`.\n- Keep it to one line.\n';
  await text.fill(draft);
  await tap(page, panel.getByRole('button', { name: 'Save', exact: true }));
  await expect(panel.locator('.error').getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  expect(await panel.locator('.error').evaluate((element) => element.firstChild?.textContent)).toBe('The coordinator changed the notebook. Reload to see its version.');
  await expect(text).toHaveValue(draft);
  await expect(page.locator('.toast.error')).toHaveCount(0);
  await expect(page.locator('.pw-jump')).toHaveCount(0);
  await shot(page, 'notebook-conflict', false);
  await tap(page, panel.getByRole('button', { name: 'Reload', exact: true }));
  await expect(panel.getByText('Prefer short, friendly greetings.', { exact: true })).toBeVisible();
  await expect(panel.locator('.pw-notebook-meta')).toHaveText(/^Updated by the coordinator · /);
  await tap(page, panel.getByRole('button', { name: 'Close panel', exact: true }));
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('PJ3 Leave git to me offers Main and preserves the manual git policy', async ({ page }, info) => {
  const errors = await begin(page);
  await openProject(page, 'Projects external');
  let dialog = await openSettings(page);
  const main = dialog.getByRole('radio', { name: 'Main', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Worktree and pull request', exact: true })).toBeChecked();
  await expect(main).toBeEnabled();
  await expect(main).not.toHaveAttribute('aria-describedby');
  await expect(dialog).toContainText('Commits and pushes stay with you.');
  const model = dialog.getByRole('combobox', { name: 'Coordinator model', exact: true });
  await expect(model).toHaveValue(''); await expect(model.locator('option').first()).toHaveText('Automatic: first available');
  await expect(dialog.getByRole('combobox', { name: 'Coordinator effort', exact: true })).toHaveValue('medium');
  await expect(dialog.getByRole('textbox', { name: 'Worktree setup command', exact: true })).toHaveAttribute('placeholder', 'npm ci');
  const limits = { 'Max running threads': '6', 'Max per device': '4', 'Turn limit per thread': '30' };
  for (const [name, value] of Object.entries(limits)) await expect(dialog.getByRole('spinbutton', { name, exact: true })).toHaveValue(value);
  await main.check();
  await page.screenshot({ path: `/tmp/jevellan-manual-settings-${info.project.name}.png`, fullPage: true });
  await dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Project settings saved.' })).toBeVisible();
  dialog = await openSettings(page);
  await expect(dialog.getByRole('radio', { name: 'Main', exact: true })).toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true })).toHaveValue('3');
  expect(ProjectWorkViewSchema.parse(await read(page, '/api/projects/projects_external/work')).project.branchPolicy).toBe('external');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);

  // A project that may use main offers it since phase 6 (D88): the radio is enabled, without a note, and can be chosen (not saved here).
  await openProject(page, 'Projects fixture');
  dialog = await openSettings(page);
  const offered = dialog.getByRole('radio', { name: 'Main', exact: true });
  await expect(offered).toBeEnabled(); await expect(offered).not.toHaveAttribute('aria-describedby');
  await expect(dialog.getByText('Main isolation is not available yet.', { exact: true })).toHaveCount(0);
  await offered.check(); await expect(offered).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Worktree and pull request', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PJ3 the GitHub token card saves, replaces and removes the token', async ({ page }) => {
  const errors = await begin(page);
  // The fixture token goes first so the card starts from Not set, and comes back whatever happens.
  expect(await control('/projects/github-token', { schema: 'fixture-github-token-v1', saved: false })).toEqual({ saved: false });
  try {
    await page.goto('/settings/git');
    const card = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'GitHub token', exact: true }) });
    const summary = card.locator('.pw-token-summary');
    await expect(summary).toHaveText('Not set');
    await expect(card.getByText('Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and write, Checks read and Commit statuses read on your repositories is enough.', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    const save = async (button: string, title: string, note?: string) => {
      await card.getByRole('button', { name: button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      if (note) await expect(dialog.getByText(note, { exact: true })).toBeVisible();
      const field = dialog.getByLabel('GitHub token', { exact: true });
      await expect(field).toBeFocused(); await expect(field).toHaveAttribute('type', 'password');
      const token = `fixture-${randomUUID()}`;
      await field.fill(token); await dialog.getByRole('button', { name: 'Save token', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: 'GitHub token saved.' })).toBeVisible();
      return token;
    };
    const first = await save('Add token', 'Add a GitHub token');
    const today = await page.evaluate(() => new Date().toLocaleDateString(undefined, { dateStyle: 'medium' }));
    await expect(summary).toHaveText(`Saved · updated ${today}`);
    for (const name of ['Replace', 'Remove']) await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(first);
    await shot(page, 'github-token');

    const second = await save('Replace', 'Replace the GitHub token', 'The saved token is replaced when you submit this form.');
    await expect(summary).toHaveText(`Saved · updated ${today}`);
    expect(await page.content()).not.toContain(second);

    await card.getByRole('button', { name: 'Remove', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Remove the GitHub token?', exact: true });
    await expect(remove.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await remove.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(remove).toHaveCount(0);
    await expect(summary).toHaveText('Not set');
    await expect(card.getByRole('button', { name: 'Add token', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  } finally {
    await control('/projects/github-token', { schema: 'fixture-github-token-v1', saved: true });
  }
  expect(errors).toEqual([]);
});

test('PJ4b the Why panel explains placement and overrides apply', async ({ page }, info) => {
  const errors = await begin(page);
  // The fixture placed two threads when it started (design 5.5): one through the fake Jev, one whose Jev call was refused (401).
  // Both reported progress after one turn and rest idle without a pull request.
  const placementProject = '/api/projects/projects_placement';
  const view = async (id: string) => ThreadViewSchema.parse(await read(page, `${placementProject}/threads/${id}`));
  const idle = async () => ProjectWorkViewSchema.parse(await read(page, `${placementProject}/work`)).threads.filter((thread) => thread.state === 'idle');
  await expect.poll(async () => (await idle()).map((thread) => thread.title).sort(), LONG).toEqual(['Check the README links', 'Tidy the README wording']);
  const placedId = (await idle()).find((thread) => thread.title === 'Tidy the README wording')!.id;
  const fallbackId = (await idle()).find((thread) => thread.title === 'Check the README links')!.id;
  const claude = await runtimeName(page, 'claude'); const codex = await runtimeName(page, 'codex');
  const openThread = async (title: string) => {
    if (phone(info)) await tap(page, tab(page, 'Threads'));
    await region(page, 'Running').getByRole('link', { name: new RegExp(`^${title}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  };
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const placementLine = (thread: ThreadView) =>
    `${claude} · ${thread.thread.modelLabel} · ${thread.thread.effort} effort · ${thread.thread.accountLabel} · Worktree on ${thread.thread.branch} · ${thread.deviceName}`;

  // Idle threads are listed under Running on the project page, but the sidebar never calls them running.
  await expect(projectRow(await projectsSection(page), 'Projects placement').locator('.pw-sidebar-running')).toHaveCount(0);

  // Why: the placement record field by field, Jev's probabilities as bars with the chosen option marked, and what was left out.
  await openProject(page, 'Projects placement');
  await openThread('Tidy the README wording');
  const placed = await view(placedId);
  expect(placed.placement).toMatchObject({ source: 'jev', fixed: [], modelId: 'claude-fable', effortRequested: 'high', effortEffective: 'high' });
  await expect(page.locator('.pw-placement-line')).toHaveText(placementLine(placed));
  await expect(page.locator('.pw-fallback-chip')).toHaveCount(0);
  const why = button('Why');
  await tap(page, why); await expect(why).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('dialog', { name: 'Why this placement', exact: true });
  await expect(panel.locator('.panel-eyebrow')).toHaveText('Tidy the README wording');
  const section = (name: string) => panel.locator('.why-section').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}`) }) });
  await expect(section('Placement').locator('h3')).toHaveText('Placement Jev');
  await expect(section('Placement').locator('.why-line')).toHaveText('Fixed: none');
  // Main is allowed on this project since phase 6, so Jev was asked the isolation too and kept the worktree.
  await expect(section('Isolation').locator('h3')).toHaveText('Isolation Jev');
  await expect(section('Isolation').locator('.why-option > span:first-child')).toHaveText(['Worktree', 'Main']);
  await expect(section('Isolation').locator('.why-option > span:last-child')).toHaveText(['0.80', '0.20']);
  await expect(section('Isolation').locator('.why-option.win > span:first-child')).toHaveText('Worktree');
  await expect(section('Model').locator('h3')).toHaveText('Model Jev');
  await expect(section('Model').locator('.why-option > span:first-child')).toHaveText([`${claude} Fable`, `${claude} Opus`, `${codex} GPT`]);
  await expect(section('Model').locator('.why-option > span:last-child')).toHaveText(['0.70', '0.15', '0.15']);
  await expect(section('Model').locator('.why-option.win > span:first-child')).toHaveText(`${claude} Fable`);
  const sonnet = placed.placement.excludedModels.find((entry) => entry.modelId === 'claude-sonnet')!;
  await expect(section('Model').locator('.why-rank li.excluded')).toHaveText([`${claude} Sonnet: ${sonnet.reason}`]);
  await expect(section('Effort').locator('.why-option > span:first-child')).toHaveText(['high', 'low', 'medium', 'xhigh', 'max']);
  await expect(section('Effort').locator('.why-option.win > span:last-child')).toHaveText('0.60');
  await expect(section('Device').locator('h3')).toHaveText('Device only option');
  await expect(section('Device').locator('.why-rank li.chosen')).toHaveText(`${placed.deviceName} · chosen`);
  await expect(section('Device').locator('.why-rank li.excluded')).toHaveText([
    'Browser member: not set up for this project', 'Offline fixture: offline']);
  await expect(section('Account').locator('.why-line')).toHaveText(placed.thread.accountLabel);
  await expect(panel.locator('.why-jev p').first()).toHaveText(/^Placement · jev-browser-simulated · 60 tokens · \d+ ms$/);
  await expectWholeParts(panel.locator('.why-jev p').first());
  // The panel narrows the page beside it on desktops: the placement line still breaks between its parts, not inside the branch.
  await expectWholeParts(page.locator('.pw-placement-line'));
  await shot(page, 'why-panel', false);
  await tap(page, panel.getByRole('button', { name: 'Close panel', exact: true }));
  await expect(why).toHaveAttribute('aria-pressed', 'false');

  // A thread placed without Jev says why in its header (9.8), and its Why panel shows the recorded error.
  await page.getByRole('link', { name: 'Back to the project', exact: true }).click();
  await openThread('Check the README links');
  const fallback = await view(fallbackId);
  expect(fallback.placement).toMatchObject({ source: 'fallback', error: { kind: 'auth', message: 'authentication failed' } });
  expect(fallback.placement.probabilities).toBeUndefined();
  await expect(page.locator('.pw-fallback-chip')).toHaveText('Placed without Jev: authentication failed');
  await shot(page, 'fallback-chip');
  await tap(page, why);
  await expect(section('Placement').locator('h3')).toHaveText('Placement without Jev');
  await expect(section('Placement').locator('.notice')).toHaveText('Placed without Jev: authentication failed');
  await expect(section('Model').locator('h3')).toHaveText('Model fallback rule');
  await expect(section('Effort').locator('.why-line')).toHaveText('medium → high (nearest effort this model supports)');
  await expect(panel.locator('.why-jev p').first()).toHaveText('No Jev answer was used for this placement.');
  await tap(page, panel.getByRole('button', { name: 'Close panel', exact: true }));

  // From the next turn: the model only among the same runtime's entries, and the effort. The next turn runs with them.
  await page.getByRole('link', { name: 'Back to the project', exact: true }).click();
  await openThread('Tidy the README wording');
  await tap(page, button('Override'));
  let dialog = page.getByRole('dialog', { name: 'Override', exact: true });
  await expect(dialog.getByRole('radio', { name: 'From the next turn', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Restart with these choices', exact: true })).toBeEnabled();
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true }); const effort = dialog.getByRole('combobox', { name: 'Effort', exact: true });
  await expect(model.locator('option')).toHaveText([`${claude} Fable`, `${claude} Opus`]);
  await expect(model).toHaveValue('claude-fable'); await expect(effort).toHaveValue('high');
  const apply = dialog.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeDisabled();
  await model.selectOption({ label: `${claude} Opus` }); await effort.selectOption('low');
  await expect(effort.locator('option')).toHaveText(['low', 'high']);
  await dialog.getByRole('textbox', { name: 'Note (optional)', exact: true }).fill('Opus is enough for wording.');
  await expect(apply).toBeEnabled();
  await shot(page, 'override-modal', false);
  await apply.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'The next turn uses your choices.' })).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await message.fill('Please go on with the wording.'); await message.press('Enter');
  await expect(page.getByRole('region', { name: 'Report · turn 2', exact: true })).toBeVisible(LONG);
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  const overridden = await view(placedId);
  expect(overridden.placement).toMatchObject({ modelId: 'claude-opus', model: 'claude-opus-5-5', effortRequested: 'low', effortEffective: 'low', source: 'jev' });
  expect(overridden.thread).toMatchObject({ modelLabel: 'Opus', effort: 'low', turns: 2 });
  await expect(page.locator('.pw-placement-line')).toHaveText(placementLine(overridden));
  await expect(page.locator('.pw-placement-line')).toContainText(`${claude} · Opus · low effort · `);
  // Jev's probabilities stay; the panel marks what runs now as the owner's change.
  await tap(page, why);
  await expect(section('Model').locator('h3')).toHaveText('Model changed by you');
  await expect(section('Model').locator('.why-option.win > span:first-child')).toHaveText(`${claude} Opus`);
  await tap(page, panel.getByRole('button', { name: 'Close panel', exact: true }));

  // Restart with these choices: a new thread with the same title and task, the shown fields fixed; the old one links it.
  await tap(page, button('Override'));
  dialog = page.getByRole('dialog', { name: 'Override', exact: true });
  await dialog.getByRole('radio', { name: 'Restart with these choices', exact: true }).check();
  const isolation = dialog.getByRole('combobox', { name: 'Isolation', exact: true });
  await expect(isolation).toHaveValue('worktree'); await expect(isolation).not.toHaveAttribute('aria-describedby');
  await expect(isolation.locator('option[value="main"]')).toHaveJSProperty('disabled', false);
  await expect(dialog.getByRole('combobox', { name: 'Device', exact: true })).toHaveValue(placed.thread.ownerDeviceId);
  await expect(model.locator('option')).toHaveText(['Automatic', `${claude} Fable`, `${claude} Opus`, `${codex} GPT`]);
  await expect(model).toHaveValue('claude-opus'); await expect(effort).toHaveValue('low');
  await model.selectOption({ label: `${claude} Fable` }); await effort.selectOption('high');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/threads/${placedId}$`), LONG);
  await expect(page).toHaveURL(/\/projects\/projects_placement\/threads\/thread_[^/]+$/);
  const restartedId = new URL(page.url()).pathname.split('/')[4]!;
  await expect(page.getByRole('heading', { level: 1, name: 'Tidy the README wording', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The thread restarted with your choices.' })).toBeVisible();
  const restarted = await view(restartedId);
  expect(restarted.placement).toMatchObject({ source: 'fixed', modelId: 'claude-fable', effortRequested: 'high', isolation: 'worktree' });
  expect([...restarted.placement.fixed].sort()).toEqual(['device', 'effort', 'isolation', 'model']);
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/threads/${placedId}$`));
  const reason = page.locator('.pw-thread-reason');
  await expect(reason).toHaveText(`Restarted as ${restartedId}.`);
  await expect(reason.getByRole('link', { name: restartedId, exact: true })).toHaveAttribute('href', `/projects/projects_placement/threads/${restartedId}`);
  await expect(page.locator('.pw-state-chip')).toHaveText('Stopped');
  for (const name of ['Override', 'Stop', 'Discard']) await expect(button(name)).toHaveCount(0);
  await expect(button('Why')).toBeVisible();
  expect((await view(placedId)).thread.state).toBe('stopped');
  await shot(page, 'restarted');
  await reason.getByRole('link', { name: restartedId, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${restartedId}$`));
  expect(errors).toEqual([]);
});

test('PJ5 a thread on the member device opens through the hub', async ({ page }) => {
  const errors = await begin(page);
  const title = 'Read the README on the member';
  await openProject(page, 'Projects fixture');
  await tap(page, page.getByRole('button', { name: 'New thread', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  // The member's scripted thread reads the README on a task marked `PJ5` and reports.
  await dialog.getByRole('textbox', { name: 'Task', exact: true }).fill('PJ5: read the README on the member device and say what it holds.');
  await dialog.locator('summary').filter({ hasText: 'Placement' }).click();
  await dialog.getByRole('combobox', { name: 'Device', exact: true }).selectOption({ label: 'Browser member' });
  // The thread exists on the member only once it read the start from the hub; until then its page keeps loading (D274).
  await page.evaluate(() => {
    const seen = window as unknown as { pj5NotFound?: boolean }; seen.pj5NotFound = false;
    new MutationObserver(() => { if (document.body.textContent?.includes('This thread was not found.')) seen.pj5NotFound = true; })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await dialog.getByRole('button', { name: 'Start thread', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/projects_fixture\/threads\/thread_[^/]+$/, LONG);
  const id = new URL(page.url()).pathname.split('/')[4]!;
  const toast = page.locator('.toast.success > span'); await expect(toast).toBeVisible(); const placed = await toast.textContent();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible(LONG);

  // The hub's page shows the member's thread: its view and transcript come from the member through the proxy.
  const report = page.getByRole('region', { name: 'Report · turn 1', exact: true });
  await expect(report).toBeVisible(LONG);
  await expect(report).toContainText('Read the README on this device: a title and one line about the Projects journeys.');
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  const view = await threadView(page, id);
  expect(view.deviceName).toBe('Browser member');
  expect(view.placement).toMatchObject({ fixed: ['device'], deviceId: view.thread.ownerDeviceId });
  expect(placed).toBe(await placementSummary(page, view));
  expect(placed).toMatch(/ · Browser member$/);
  const runtime = await runtimeName(page, view.thread.runtime);
  await expect(page.locator('.pw-placement-line')).toHaveText(`${runtime} · ${view.thread.modelLabel} · ${view.thread.effort} effort · ${view.thread.accountLabel} · Worktree on ${view.thread.branch} · Browser member`);
  await expectWholeParts(page.locator('.pw-placement-line'));
  await expect(page.locator('[aria-label="Thread transcript"] .cursor-tool-header > span:first-child')).toHaveText(['Read']);
  await expectAlignedCards(page.locator('[aria-label="Thread transcript"]'));
  await expect(page.getByRole('textbox', { name: 'Message this thread', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { pj5NotFound?: boolean }).pj5NotFound)).toBe(false);
  await shot(page, 'remote-thread');

  // Opened while its device is offline (the hub's refusal, stubbed: the fixture member never misses ten minutes of heartbeats), the
  // page still names the thread from the project's index and shows the reason as a notice, then the thread once the device answers (D276).
  const threadRead = `**/api/projects/projects_fixture/threads/${id}`;
  await page.route(threadRead, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 409, json: { schema: 'error-v1', code: 'conflict', message: threadDeviceOffline('Browser member') } }) : route.continue());
  await page.reload();
  await expect(page.locator('.pw-page > .notice')).toHaveText(threadDeviceOffline('Browser member'));
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle');
  await expect(page.locator('.pw-page > .error')).toHaveCount(0);
  await page.unroute(threadRead);
  await expect(report).toBeVisible(LONG);
  await expect(page.locator('.pw-page > .notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PJ5 an offline coordinator shows the notice and Move coordinator here', async ({ page }) => {
  const errors = await begin(page);
  await openProject(page, 'Projects offline');
  // The fixture's offline device holds this project's coordinator (9.8): nothing can start until it moves.
  const notice = page.locator('.notice.pw-offline');
  await expect(notice.locator('p')).toHaveText('The coordinator lives on Offline fixture, which is offline.');
  const move = notice.getByRole('button', { name: 'Move coordinator here', exact: true });
  await expect(move).toBeEnabled();
  await expect(page.locator('.pw-chip')).toHaveText('Offline');
  await shot(page, 'offline-notice');

  await tap(page, move);
  await expect(notice).toHaveCount(0, LONG);
  const offline = ProjectWorkViewSchema.parse(await read(page, '/api/projects/projects_offline/work'));
  expect(offline.coordinator).toMatchObject({ state: 'idle', online: true, canMoveHere: false });
  const here = offline.coordinator.deviceName!;
  await expect(page.locator('.pw-chip')).toHaveText('Idle');
  await expect(page.locator('.pw-timeline').getByText(`The coordinator moved to ${here}.`, { exact: true })).toBeVisible(LONG);
  await expect(composer(page)).toBeEnabled();
  await shot(page, 'moved');
  expect(errors).toEqual([]);
});

test('PJ7 an attached thread disables its composer', async ({ page }) => {
  const errors = await begin(page);
  const title = 'Tidy the README wording';
  // A terminal takes over a thread on its own device, so this one runs here (the hub), where the fixture's control attaches it.
  const roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster'));
  const here = roster.devices.find((row) => row.device.id === roster.currentDeviceId)!.device.name;
  await openProject(page, 'Projects fixture');
  await tap(page, page.getByRole('button', { name: 'New thread', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New thread', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: 'Task', exact: true }).fill('PJ7: tidy the README wording, then wait for me to look at it in a terminal.');
  await dialog.locator('summary').filter({ hasText: 'Placement' }).click();
  await dialog.getByRole('combobox', { name: 'Device', exact: true }).selectOption({ label: here });
  await dialog.getByRole('button', { name: 'Start thread', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/projects_fixture\/threads\/thread_[^/]+$/, LONG);
  const id = new URL(page.url()).pathname.split('/')[4]!;
  await expect(page.getByRole('region', { name: 'Report · turn 1', exact: true })).toBeVisible(LONG);
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  expect((await threadView(page, id)).deviceName).toBe(here);

  // Under the composer of a thread that has not concluded: where and how to take it over, with the command to copy.
  const command = `jevellan thread attach ${id}`;
  const takeOver = page.locator('.pw-takeover');
  await expect(takeOver).toHaveText(`Take over in a terminal on ${here}: ${command}`);
  const message = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await expect(message).toBeEnabled();
  await expect(page.locator('.pw-composer-note')).toHaveCount(0);
  // How the composer looks while it takes messages (the send icon is disabled here too, as the field is empty).
  const look = () => page.locator('.pw-thread-composer').evaluate((form) => {
    const row = form.querySelector('.message-input-row')!; const field = form.querySelector('textarea')!; const send = form.querySelector('.send-icon')!;
    return { border: getComputedStyle(row).borderTopStyle, cursor: getComputedStyle(field).cursor, placeholder: getComputedStyle(field, '::placeholder').color, send: getComputedStyle(send).opacity };
  });
  const enabled = await look();

  // The terminal takes the thread (the command's own request, sent by the fixture's control): the page's next read shows it attached,
  // the composer takes no message and says why, and the takeover line stays with its copy button working.
  await control('/projects/attach', { schema: 'fixture-attach-v1', threadId: id });
  await expect(page.locator('.pw-state-chip')).toHaveText('Attached', LONG);
  await expect(page.locator('.pw-composer-note')).toHaveText(`Attached in a terminal on ${here}. Messages wait until you exit.`);
  await expect(message).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  // It also reads disabled, in both themes: a dashed row, the not-allowed cursor, a fainter placeholder and send icon (D317).
  const attached = await look();
  expect(attached).toMatchObject({ border: 'dashed', cursor: 'not-allowed' });
  for (const key of ['border', 'cursor', 'placeholder', 'send'] as const) expect(attached[key], key).not.toBe(enabled[key]);
  // Stop waits for the terminal session too: disabled, described by the server's sentence shown under the header.
  const refusal = `This thread is attached in a terminal: exit that terminal session first, or run jevellan thread detach ${id}.`;
  const stopButton = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stopButton).toBeDisabled();
  await expect(stopButton).toHaveAccessibleDescription(refusal);
  await expect(page.locator('.pw-thread-note')).toHaveText(refusal);
  await expect(takeOver).toHaveText(`Take over in a terminal on ${here}: ${command}`);
  const copyButton = takeOver.getByRole('button', { name: 'Copy command', exact: true });
  await expect(copyButton).toBeEnabled();
  await shot(page, 'attached');
  // This page fits the screen: nothing under the composer (the copy button's wider target included) may make it scroll.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);

  // Copying: the Clipboard API on this loopback page; the selection copy that a plain-HTTP Tailnet page falls back to; and, when the
  // browser refuses both, the command shown whole and selected on the page (D304, D305).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const toast = page.locator('.toast.success > span');
  const dismiss = () => page.locator('.toast.success').getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await tap(page, copyButton);
  await expect(toast).toHaveText('Command copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await dismiss();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.addEventListener('copy', () => {
      const field = document.activeElement as HTMLTextAreaElement | null;
      (window as unknown as { pj7Copied?: string }).pj7Copied = field ? field.value.slice(field.selectionStart, field.selectionEnd) : '';
    });
  });
  await tap(page, copyButton);
  await expect(toast).toHaveText('Command copied.');
  expect(await page.evaluate(() => (window as unknown as { pj7Copied?: string }).pj7Copied)).toBe(command);
  await expect(copyButton).toBeFocused();
  await dismiss();
  // Refused both ways: no toast (on phones it would cover the command); the command shows whole and selected, the reason under it.
  await page.evaluate(() => { document.execCommand = () => false; });
  await tap(page, copyButton);
  await expect(page.locator('.pw-takeover-blocked')).toHaveText('The browser blocked copying, so the command is selected for you to copy.');
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(command);
  expect(await takeOver.locator('code').evaluate((code) => code.scrollWidth <= code.clientWidth)).toBe(true);
  await shot(page, 'copy-blocked', false);
  // The reason folds away with the selection.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(page.locator('.pw-takeover-blocked')).toHaveCount(0);

  // The terminal exits and the thread is back: the composer takes messages again.
  await control('/projects/detach', { schema: 'fixture-attach-v1', threadId: id });
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  await expect(page.locator('.pw-composer-note')).toHaveCount(0);
  await expect(message).toBeEnabled();
  expect(await look()).toEqual(enabled);
  await expect(stopButton).toBeEnabled(); await expect(page.locator('.pw-thread-note')).toHaveCount(0);
  await expect(takeOver).toHaveText(`Take over in a terminal on ${here}: ${command}`);

  // The owner stops it: the project chat says so in the owner's voice, without the coordinator's wording as its detail (D316).
  await tap(page, stopButton);
  await page.getByRole('dialog', { name: 'Stop this thread?', exact: true }).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.pw-state-chip')).toHaveText('Stopped', LONG);
  await page.getByRole('link', { name: 'Back to the project', exact: true }).click();
  const stoppedCard = page.locator('.pw-event').filter({ has: page.locator('.pw-event-text').getByText(`You stopped "${title}"`, { exact: true }) });
  await expect(stoppedCard).toHaveCount(1, LONG);
  await expect(stoppedCard.locator('.pw-event-detail')).toHaveCount(0);
  await expect(page.locator('.pw-event').filter({ hasText: 'The owner stopped this thread.' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Coordinator overrides expose model and effort while preserving unrelated project settings', async ({ page }, info) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  const before = (await work(page)).settings;
  await page.getByRole('button', { name: 'Override coordinator', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Override coordinator', exact: true });
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('claude-opus');
  await dialog.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low');
  await expect(dialog).toContainText('The current turn can finish.');
  await page.screenshot({ path: `/tmp/jevellan-coordinator-override-${info.project.name}.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(async () => (await work(page)).settings.coordinator).toEqual({ modelId: 'claude-opus', effort: 'low' });
  const after = (await work(page)).settings;
  const unchanged = (settings: typeof before) => Object.fromEntries(Object.entries(settings).filter(([key]) => !['coordinator', 'revision'].includes(key)));
  expect(unchanged(after)).toEqual(unchanged(before));
  await page.getByRole('button', { name: 'Override coordinator', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Override coordinator', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('claude-opus');
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('');
  await dialog.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(before.coordinator.effort);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await work(page)).settings.coordinator).toEqual(before.coordinator); expect(errors).toEqual([]);
});

test('Consecutive tool calls share an open area and new live output appends to it', async ({ page }, info) => {
  const errors = await begin(page);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `request_groups_${info.project.name}`, title: 'Inspect app files for grouping', task: 'Read the README and describe the files.', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.state, LONG).not.toBe('preparing');
  const view = await threadView(page, started.threadId); const thread = view.thread;
  const tool = (id: string, name = 'Read') => ({ type: 'tool' as const, id, name, input: JSON.stringify({ file_path: `${id}.txt` }), output: `Output ${id}`, state: 'completed' as const });
  const turns = [{ id: 'one', role: 'assistant' as const, blocks: [tool('one')] }, { id: 'two', role: 'assistant' as const, blocks: [tool('two')] },
    { id: 'boundary', role: 'assistant' as const, blocks: [{ type: 'thinking' as const, text: 'A thinking block starts a new group.' }, tool('three'), tool('four', 'Bash'), tool('five')] }];
  view.reports = []; view.transcript = { schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: 'claude_00000000000000000000000000000000', ownerDeviceId: thread.ownerDeviceId,
    deviceName: view.deviceName, title: thread.title, cwd: null, project: 'Projects fixture', state: 'idle', lastActivityAt: new Date().toISOString(), connected: false, canSteer: false, canSend: false },
    turns, messages: [], activity: [], truncated: false, observedAt: new Date().toISOString() };
  await page.route(`**${PROJECT}/threads/${thread.id}`, route => route.fulfill({ json: view }));
  await page.goto(`/projects/projects_fixture/threads/${thread.id}`);
  const areas = page.locator('.cursor-tool'); await expect(areas).toHaveCount(4);
  await expect(areas.first().locator('.cursor-tool-call')).toHaveCount(2); await expect(areas.first()).toContainText('Output one'); await expect(areas.first()).toContainText('Output two');
  await expect(page.locator('details.cursor-tool')).toHaveCount(0);
  turns[0]!.blocks.push(tool('appended')); await expect(areas.first().locator('.cursor-tool-call')).toHaveCount(3);
  await expect(areas.first()).toContainText('Output appended'); await expect(areas).toHaveCount(4);
  await page.screenshot({ path: `/tmp/jevellan-tool-groups-${info.project.name}.png`, fullPage: true }); expect(errors).toEqual([]);
});
