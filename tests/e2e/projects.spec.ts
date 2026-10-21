import { basename } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ContextPanelSchema, ProjectsListSchema, ProjectThreadActionsViewSchema, CleanupStateSchema, DeviceRosterSchema, MergeDocumentsViewSchema, ProjectJobRunListViewSchema, ProjectDeployViewSchema, ProjectDailyListViewSchema, ProjectEventFrameSchema, ProjectWorkListViewSchema, ProjectWorkViewSchema, RuntimeListSchema, TaskListViewSchema, TaskReceiptSchema, TerminalSnapshotSchema, ThreadViewSchema, WorktreeDiskSchema, type ThreadView, type CursorTurn } from '../../packages/core/dist/client.js';
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
async function sessionDetails(page: Page) {
  const button = page.getByRole('button', { name: 'Session information', exact: true });
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}
const PROJECT = '/api/projects/projects_fixture';
// Longer than a thread row, so every capture also checks that a clipped title cannot widen the page or the side column.
const LONG_TITLE = 'Read through the project and list what each file is for, one line per file';

/** Signs in through the API; every journey collects page errors and asserts none at its end. */
async function begin(page: Page) {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  expect((await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } })).ok()).toBe(true);
  await page.goto('/');
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
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
  let point = { x: 0, y: 0 };
  // As Playwright's own click does, wait until nothing (a closing drawer, a toast) covers the control at that point.
  await expect.poll(async () => {
    let box = await control.boundingBox(); if (!box) return false;
    const viewport = page.viewportSize()!;
    // Keep visible sticky controls put; scroll a lower card or a horizontally hidden phone tab into reach.
    if (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
      await control.scrollIntoViewIfNeeded(); box = await control.boundingBox(); if (!box) return false;
    }
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    return control.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), point);
  }).toBe(true);
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


const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Project sections', exact: true }).getByRole('tab', { name: new RegExp(`^${name === 'Waiting' ? 'Overview' : name}`) });
async function sectionTab(page: Page, info: TestInfo, name: string) {
  if (name === 'Chat') { if (phone(info)) await tap(page, tab(page, 'Chat')); return; }
  if (phone(info)) await tap(page, tab(page, 'Overview'));
  await tap(page, page.getByRole('tablist', { name: 'Overview', exact: true }).getByRole('tab', { name: name === 'Waiting' ? 'Threads' : name, exact: true }));
}
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
async function openSettings(page: Page) {
  await tap(page, page.locator('summary[aria-label="Project menu"]'));
  await tap(page, page.getByRole('button', { name: 'Project settings', exact: true }));
  const dialog = page.locator('.pw-settings-page');
  await expect(page).toHaveURL(/\/projects\/[^/]+\/settings$/);
  // The settings page reads the current revision rather than the previous work snapshot.
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  return dialog;
}

test('Home opens the first sidebar project while New conversation stays available', async ({ page }, info) => {
  const errors = await begin(page);
  const section = await projectsSection(page);
  const first = section.locator('.pw-sidebar-row').first();
  await expect(first).toHaveAttribute('aria-current', 'page');
  const name = await first.locator('.pw-sidebar-name').getAttribute('title');
  await closeDrawer(page, info);
  await expect(page.getByRole('heading', { level: 1, name: name!, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: name!, exact: true })).toBeVisible();
  await openSidebar(page);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: name!, exact: true })).toBeVisible();
  await shot(page, 'first-project-home', false);
  await page.request.post('/api/auth/logout', { data: { schema: 'empty-request-v1' } });
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: name!, exact: true })).toBeVisible();
  // A successful empty project list still leaves a usable starting page.
  const emptyProjects = ProjectWorkListViewSchema.parse({ schema: 'project-work-list-view-v1', projects: [] });
  await page.route('**/api/project-work', route => route.fulfill({ json: emptyProjects }));
  await page.goto('/');
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  expect(errors).toEqual([]);
});


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
  for (const name of ['New task', 'Notebook']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('summary[aria-label="Project menu"]')).toBeVisible();
  await expect(page.getByText('Describe what you want done. The coordinator splits it into threads, runs them on your devices and accounts, and brings back what needs you.', { exact: true })).toBeVisible();
  await expect(composer(page)).toHaveAttribute('placeholder', 'Tell the coordinator what you need');
  const tabs = page.getByRole('tablist', { name: 'Project sections', exact: true });
  if (phone(info)) {
    await expect(tabs.getByRole('tab')).toHaveText(['Chat', 'Overview']);
    await expect(tab(page, 'Chat')).toHaveAttribute('aria-selected', 'true');
    await sectionTab(page, info, 'Threads');
    await expect(region(page, 'Working')).toContainText('Nothing running.');
    await expect(region(page, 'Resolved').locator('.pw-thread-card').filter({ has: page.getByRole('link', { name: /^Write the welcome copy/ }) }).locator('.pw-outcome')).toHaveText('Merged #7');
    await sectionTab(page, info, 'Pull requests'); await expect(region(page, 'Pull requests')).toContainText('No open pull requests.');
    await sectionTab(page, info, 'Waiting'); await expect(region(page, 'Waiting for you')).toContainText('Nothing needs you.');
    await tap(page, tab(page, 'Chat')); await expect(composer(page)).toBeVisible();
  } else {
    // Two columns: the chat and the sections in the brief's order, each with its count and its empty line.
    await expect(tabs).toBeHidden();
    await expect(page.locator('.pw-side .pw-section:not([hidden]) .pw-section-heading')).toHaveText(['Waiting for you 0', 'Ready for review 0', 'Working 0', 'Landing 0', 'Idle 0', 'Resolved 1']);
    await expect(region(page, 'Waiting for you')).toContainText('Nothing needs you.');
    await expect(region(page, 'Working')).toContainText('Nothing running.');
    await sectionTab(page, info, 'Pull requests');
    await expect(region(page, 'Pull requests')).toContainText('No open pull requests.');
    await sectionTab(page, info, 'Threads');
    await expect(region(page, 'Resolved').locator('.pw-thread-card').filter({ has: page.getByRole('link', { name: /^Write the welcome copy/ }) }).locator('.pw-outcome')).toHaveText('Merged #7');
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

  // The live thread card links to its thread and follows the reply from its own coordinator turn.
  const id = await threadId(page, 'Add a greeting');
  const tool = page.locator('.pw-timeline .pw-thread-card').filter({ hasText: 'Add a greeting' });
  await expect(tool).toBeVisible(LONG);
  await expect(tool.getByRole('link', { name: 'Add a greeting', exact: true })).toHaveAttribute('href', `/projects/projects_fixture/threads/${id}`);
  const currentThread = await threadView(page, id);
  await expect(tool.locator('.pw-card-meta')).toHaveText(`${currentThread.thread.modelLabel} · ${currentThread.thread.effort} · ${currentThread.thread.accountLabel} · ${currentThread.deviceName}`);
  expect((await threadView(page, id)).thread.title).toBe('Add a greeting');
  const reply = page.locator('.pw-reply').filter({ hasText: 'Started "Add a greeting".' });
  await expect(reply).toHaveText('Started "Add a greeting".', LONG);
  const entries = await page.locator('.pw-timeline > *').allTextContents();
  expect(entries.findIndex((entry) => entry.startsWith('Add a greeting'))).toBeGreaterThan(entries.indexOf('Started "Add a greeting".'));
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
    await sectionTab(page, info, 'Waiting');
    await expect(card).toBeVisible();
  } else {
    await expect(region(page, 'Waiting for you').locator('.pw-section-heading')).toHaveText('Waiting for you 1', LONG);
    await expect(projectRow(page.getByRole('navigation', { name: 'Projects', exact: true }), 'Projects fixture').locator('.suggestion-count')).toHaveText('1 waiting', LONG);
  }
  await expect(card.locator('.pw-source')).toHaveText(/^1 From the coordinator · /);
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
  await expect(waiting.getByText('Nothing needs you.', { exact: true })).toBeVisible();
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
  await tap(page, page.getByRole('button', { name: 'New task', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(LONG_TITLE);
  // The scripted thread keeps working on a task marked `PJ3 long` until it is released or interrupted.
  await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill('PJ3 long: read the project files, then wait for my message.');
  await dialog.locator('summary').filter({ hasText: 'Choose where it runs' }).click();
  for (const name of ['Model', 'Effort', 'Device']) {
    const select = dialog.getByRole('combobox', { name, exact: true });
    await expect(select).toHaveValue(''); await expect(select.locator('option').first()).toHaveText('Automatic');
  }
  await expect(dialog.getByRole('combobox', { name: 'Isolation', exact: true })).toHaveCount(0);
  // Every device of the mesh is offered in roster order (D281); one no thread can run on stays listed, disabled, with placement's reason.
  const roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster'));
  const device = dialog.getByRole('combobox', { name: 'Device', exact: true });
  await expect(device.locator('option')).toHaveText(['Automatic', ...roster.devices.filter((row) => !row.revoked)
    .map((row) => row.device.name === 'Offline fixture' ? 'Offline fixture: offline' : row.device.name)]);
  await expect(device.locator('option', { hasText: 'Offline fixture: offline' })).toHaveJSProperty('disabled', true);
  await expect(device.locator('option', { hasText: 'Browser member' })).toHaveJSProperty('disabled', false);
  await shot(page, 'new-thread-modal', false);
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();

  // A started thread opens its page; the toast tells where it was placed.
  await expect(dialog).toHaveCount(0);
  const toast = page.locator('.toast.success > span'); await expect(toast).toBeVisible(); const placed = await toast.textContent();
  let id = '';
  await expect.poll(async () => { const body = await read(page, '/api/projects/projects_fixture/tasks') as { tasks: Array<{ title: string; threadId: string | null }> }; id = body.tasks.find(task => task.title === LONG_TITLE)?.threadId ?? ''; return id; }, LONG).toMatch(/^thread_/);
  await page.goto(`/projects/projects_fixture/threads/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: LONG_TITLE, exact: true })).toBeVisible();
  await expect.poll(async () => (await threadView(page, id)).thread.branch ?? '', LONG).toMatch(/^jv\//);
  const view = await threadView(page, id); const runtime = await runtimeName(page, view.thread.runtime);
  expect(placed).toContain('Queued task');
  await expect(page.locator('.pw-state-chip')).toHaveText('Running', LONG);
  const sessionInformation = page.getByRole('button', { name: 'Session information', exact: true });
  await expect(sessionInformation).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.pw-thread-composer .pw-takeover')).toHaveCount(0);
  await sessionInformation.click();
  await expect(page.getByRole('region', { name: 'Session information', exact: true })).toBeVisible();
  await expect(page.locator('.pw-session-panel .pw-takeover')).toBeVisible();
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
  await sectionTab(page, info, 'Threads');
  const row = region(page, 'Working').locator('.pw-thread-card').filter({ has: page.getByRole('link', { name: LONG_TITLE, exact: true }) });
  await expect(row.locator('.pw-card-meta')).toHaveText(`${view.thread.modelLabel} · ${view.thread.effort} · ${view.thread.accountLabel} · ${view.deviceName}`);
  await expect(projectRow(await projectsSection(page), 'Projects fixture').locator('.pw-sidebar-running')).toHaveText('1 running', LONG);
  await closeDrawer(page, info);
  await row.getByRole('link', { name: LONG_TITLE, exact: true }).click();
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
  await report.locator('.pw-report-disclosure > summary').click();
  await expect(report.locator('.markdown')).toBeVisible();
  await expect(transcript.getByText('Read your message and adjusted the plan.', { exact: true })).toHaveCount(1);
  await report.locator('.pw-report-disclosure > summary').click();
  await expect(report.locator('.pw-report-preview')).toBeVisible();
  await expect(transcript.getByText('Read your message and adjusted the plan.', { exact: true })).toHaveCount(1);

  await expect(page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true })).toHaveCount(0);
  await expect(message).toHaveValue('');
  await expectAlignedCards(transcript);
  await expectReadableMutedText(page);
  await expectNoStaleJump(page, transcript);
  // This transcript has plain tool output and a report; coordinator links below exercise control clearance.
  await shot(page, 'thread-report');

  // Why on a thread whose title is longer than the panel: the title in the eyebrow truncates, while the panel title and Close
  // stay whole and the heading never scrolls sideways.
  await sessionDetails(page);
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
  await sectionTab(page, info, 'Pull requests');
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
  await sectionTab(page, info, 'Threads');
  const concluded = region(page, 'Resolved');
  await expect(concluded.locator('.pw-thread-card').filter({ has: page.getByRole('link', { name: /^Add a greeting/ }) }).locator('.pw-outcome')).toHaveText('Merged #1', LONG);
  await expect(concluded.locator('.pw-section-heading')).toHaveText('Resolved 2');
  // The merge reaches the coordinator as an event; the capture waits until it has answered.
  await coordinatorSettled(page, turnsBefore);
  await shot(page, 'concluded');
  const merged = await threadView(page, await threadId(page, 'Add a greeting'));
  expect({ state: merged.thread.state, pr: merged.thread.pr?.state }).toEqual({ state: 'done', pr: 'merged' });
  await tap(page, concluded.getByRole('link', { name: /^Add a greeting/ }));
  await expect(page.getByRole('textbox', { name: 'Message this thread' })).toBeEnabled(LONG);
  await expect(page.getByText('Continue here. Jev will classify your message and choose how to run the follow-up.', { exact: true })).toBeVisible();
  await shot(page, 'completed-thread-followup');
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

test('PJ3 Leave git to me keeps worktree isolation and preserves the manual git policy', async ({ page }, info) => {
  const errors = await begin(page); await openProject(page, 'Projects external');
  let dialog = await openSettings(page);
  await expect(dialog.getByRole('radio', { name: 'Main', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: 'Delivery', exact: true })).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true }).fill('3');
  await page.screenshot({ path: info.outputPath(`worktree-settings-${layout(info)}.png`), fullPage: true });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toBeHidden();
  dialog = await openSettings(page); await expect(dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true })).toHaveValue('3');
  expect(ProjectWorkViewSchema.parse(await read(page, '/api/projects/projects_external/work')).project.branchPolicy).toBe('external');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(errors).toEqual([]);
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
    await sectionTab(page, info, 'Threads');
    await region(page, 'Idle').getByRole('link', { name: new RegExp(`^${title}`) }).click();
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
  await page.getByRole('button', { name: 'Session information', exact: true }).click();
  await expect(page.locator('.pw-placement-line')).toHaveText(placementLine(placed));
  await expect(page.locator('.pw-fallback-chip')).toHaveCount(0);
  const why = button('Why');
  await sessionDetails(page);
  await tap(page, why); await expect(why).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('dialog', { name: 'Why this placement', exact: true });
  await expect(panel.locator('.panel-eyebrow')).toHaveText('Tidy the README wording');
  const section = (name: string) => panel.locator('.why-section').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}(?:\\s|$)`) }) });
  await expect(section('Placement').locator('h3')).toHaveText('Placement Jev');
  await expect(section('Placement').locator('.why-line')).toHaveText('Fixed: none');
  await expect(section('Isolation').locator('h3')).toHaveText('Isolation only option');
  await expect(section('Isolation').locator('.why-line')).toHaveText('Worktree');
  await expect(section('Isolation').locator('.why-option')).toHaveCount(0);
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
  await expect(panel.getByRole('heading', { name: 'Accounts when chosen', exact: true })).toBeVisible();
  // Every candidate account Jev weighed is listed with its ceiling; the chosen one is marked.
  const candidates = section('Accounts when chosen').locator('li');
  await expect(candidates).toHaveCount(placed.placement.accountChoice!.candidates.length);
  const chosenAccount = candidates.filter({ hasText: ' · chosen' });
  await expect(chosenAccount).toHaveCount(1);
  await expect(chosenAccount).toContainText(`${placed.thread.accountLabel} · chosen`);
  await expect(chosenAccount).toContainText('Ceiling 90%');
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
  await sessionDetails(page);
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
  await sessionDetails(page);
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
  const accountPin = await page.request.post(`${placementProject}/threads/${placedId}/override`, { data: {
    schema: 'thread-override-request-v1', clientRequestId: 'pin_current_account', mode: 'next-turn', accountId: placed.placement.accountId,
  } });
  expect(accountPin.status()).toBe(200);
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
  await sessionDetails(page);
  await tap(page, why);
  await expect(section('Model').locator('h3')).toHaveText('Model changed by you');
  await expect(section('Model').locator('.why-option.win > span:first-child')).toHaveText(`${claude} Opus`);
  await expect(section('Account')).toHaveCount(1);
  await expect(section('Account').locator('.why-line')).toHaveText(overridden.thread.accountLabel);
  await shot(page, 'why-overridden', false);
  await tap(page, panel.getByRole('button', { name: 'Close panel', exact: true }));

  // Restart with these choices: a new thread with the same title and task, the shown fields fixed; the old one links it.
  await sessionDetails(page);
  await tap(page, button('Override'));
  dialog = page.getByRole('dialog', { name: 'Override', exact: true });
  await dialog.getByRole('radio', { name: 'Restart with these choices', exact: true }).check();
  await expect(dialog.getByRole('combobox', { name: 'Isolation', exact: true })).toHaveCount(0);
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
  // Thread controls live in the collapsed session panel; open it so their absence is checked where they would appear.
  await sessionDetails(page);
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
  await tap(page, page.getByRole('button', { name: 'New task', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  // The member's scripted thread reads the README on a task marked `PJ5` and reports.
  await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill('PJ5: read the README on the member device and say what it holds.');
  await dialog.locator('summary').filter({ hasText: 'Choose where it runs' }).click();
  await dialog.getByRole('combobox', { name: 'Device', exact: true }).selectOption({ label: 'Browser member' });
  // The thread exists on the member only once it read the start from the hub; until then its page keeps loading (D274).
  await page.addInitScript(() => {
    const seen = window as unknown as { pj5NotFound?: boolean }; seen.pj5NotFound = false;
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => { if (document.body.textContent?.includes('This thread was not found.')) seen.pj5NotFound = true; })
      .observe(document.body, { childList: true, subtree: true, characterData: true }));
  });
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const toast = page.locator('.toast.success > span'); await expect(toast).toBeVisible(); const placed = await toast.textContent();
  let id = '';
  await expect.poll(async () => { const body = await read(page, '/api/projects/projects_fixture/tasks') as { tasks: Array<{ title: string; threadId: string | null }> }; id = body.tasks.find(task => task.title === title)?.threadId ?? ''; return id; }, LONG).toMatch(/^thread_/);
  await page.goto(`/projects/projects_fixture/threads/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible(LONG);

  // The hub's page shows the member's thread: its view and transcript come from the member through the proxy.
  const report = page.getByRole('region', { name: 'Report · turn 1', exact: true });
  await expect(report).toBeVisible(LONG);
  await expect(report).toContainText('Read the README on this device: a title and one line about the Projects journeys.');
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  const view = await threadView(page, id);
  expect(view.deviceName).toBe('Browser member');
  expect(view.placement).toMatchObject({ fixed: ['device'], deviceId: view.thread.ownerDeviceId });
  expect(placed).toContain('Queued task');
  const runtime = await runtimeName(page, view.thread.runtime);
  await page.getByRole('button', { name: 'Session information', exact: true }).click();
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
  await page.context().route(threadRead, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 409, json: { schema: 'error-v1', code: 'conflict', message: threadDeviceOffline('Browser member') } }) : route.continue());
  await page.reload();
  await expect(page.locator('.pw-page > .notice')).toHaveText(threadDeviceOffline('Browser member'));
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle');
  await expect(page.locator('.pw-page > .error')).toHaveCount(0);
  await page.context().unroute(threadRead);
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
  await tap(page, page.getByRole('button', { name: 'New task', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill('PJ7: tidy the README wording, then wait for me to look at it in a terminal.');
  await dialog.locator('summary').filter({ hasText: 'Choose where it runs' }).click();
  await dialog.getByRole('combobox', { name: 'Device', exact: true }).selectOption({ label: here });
  await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let id = '';
  await expect.poll(async () => { const body = await read(page, '/api/projects/projects_fixture/tasks') as { tasks: Array<{ title: string; threadId: string | null }> }; id = body.tasks.find(task => task.title === title)?.threadId ?? ''; return id; }, LONG).toMatch(/^thread_/);
  await page.goto(`/projects/projects_fixture/threads/${id}`);
  await expect(page.getByRole('region', { name: 'Report · turn 1', exact: true })).toBeVisible(LONG);
  await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
  expect((await threadView(page, id)).deviceName).toBe(here);

  // Under the composer of a thread that has not concluded: where and how to take it over, with the command to copy.
  const command = `jevellan thread attach ${id}`;
  await page.getByRole('button', { name: 'Session information', exact: true }).click();
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

  // The prompt folds during terminal ownership (the focused transcript folds every past text block); its complete task and live
  // context remain readable on request.
  const prompt = page.locator('.pw-transcript .cursor-turn-user').first(), folds = prompt.locator('.cursor-text-block');
  await expect(folds.first()).toBeVisible();
  for (const fold of await folds.all()) { await expect(fold).not.toHaveAttribute('open', ''); await fold.locator('summary').click(); await expect(fold).toHaveAttribute('open', ''); }
  await expect(prompt).toContainText('PJ7: tidy the README wording, then wait for me to look at it in a terminal.');
  await expect(prompt).toContainText('Project now');
  for (const fold of await folds.all()) await fold.locator('summary').click();

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

test('Thread history folds while current work and thinking stay expanded', async ({ page }, info) => {
  const errors = await begin(page);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `request_groups_${info.project.name}`, title: 'Inspect app files for grouping', task: 'Read the README and describe the files.', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok(), await created.text()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.state, LONG).not.toBe('preparing');
  const view = await threadView(page, started.threadId); const thread = view.thread;
  const tool = (id: string, name = 'Read') => ({ type: 'tool' as const, id, name, input: JSON.stringify({ file_path: `${id}.txt` }), output: `Output ${id}`, state: 'completed' as const });
  const turns: CursorTurn[] = [{ id: 'one', role: 'assistant' as const, blocks: [tool('one')] }, { id: 'two', role: 'assistant' as const, blocks: [tool('two')] },
    { id: 'boundary', role: 'assistant' as const, blocks: [{ type: 'thinking' as const, text: 'A thinking block starts a new group.' }, tool('three'), tool('four', 'Bash'), tool('five')] }];
  view.reports = []; view.transcript = { schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: 'claude_00000000000000000000000000000000', ownerDeviceId: thread.ownerDeviceId,
    deviceName: view.deviceName, title: thread.title, cwd: null, project: 'Projects fixture', state: 'idle', lastActivityAt: new Date().toISOString(), connected: false, canSteer: false, canSend: false },
    turns, messages: [], activity: [], truncated: false, observedAt: new Date().toISOString() };
  await page.context().route(`**${PROJECT}/threads/${thread.id}`, route => route.fulfill({ json: view }));
  await page.goto(`/projects/projects_fixture/threads/${thread.id}`);
  const areas = page.locator('.cursor-tool'); await expect(areas).toHaveCount(4);
  await expect(areas.first().locator('.cursor-tool-call')).toHaveCount(2); await expect(areas.first()).toContainText('Output one'); await expect(areas.first()).toContainText('Output two');
  await expect(page.locator('details.cursor-tool')).toHaveCount(4);
  await expect(page.locator('details.cursor-tool[open]')).toHaveCount(0);
  await expect(page.locator('.cursor-thinking[open]')).toHaveCount(1);
  await expect(areas.first().locator('pre').first()).toBeHidden();
  await areas.first().locator(':scope > summary').click();
  await areas.first().locator('.cursor-tool-call > summary').first().click();
  await expect(areas.first().getByText('Output one', { exact: true })).toBeVisible();
  turns[0]!.blocks.push(tool('appended')); await expect(areas.first().locator('.cursor-tool-call')).toHaveCount(3);
  await expect(areas.first()).toContainText('Output appended'); await expect(areas).toHaveCount(4);
  view.thread.state = 'running';
  const pending: Extract<CursorTurn['blocks'][number], { type: 'tool' }> = { type: 'tool', id: 'active', name: 'Bash', input: '{"command":"sleep 1"}', state: 'unknown' };
  turns.at(-1)!.blocks.push(pending);
  await expect(areas).toHaveCount(5);
  const current = areas.last();
  await expect(current).toHaveAttribute('open', '');
  await expect(current).toContainText('Waiting for result');
  await expect(current.locator('pre')).toBeVisible();
  pending.output = 'Finished'; pending.state = 'completed';
  view.thread.state = 'idle';
  await expect(current).not.toHaveAttribute('open');
  await expect(page.locator('.cursor-thinking[open]')).toHaveCount(1);
  await page.screenshot({ path: `/tmp/jevellan-tool-groups-${info.project.name}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('Thread images open from folded history and reports, with mobile swiping and useful report previews', async ({ page }, info) => {
  const errors = await begin(page);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `request_images_${info.project.name}`, title: 'Make the customer screen clearer', task: 'Improve the customer screen.', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok(), await created.text()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.state, LONG).not.toBe('preparing');
  const view = await threadView(page, started.threadId); const thread = view.thread; view.thread.state = 'idle';
  const files = ['shots/desktop.png', 'shots/phone.png', 'shots/removed.png'];
  const turns: CursorTurn[] = files.map((file, i) => ({ id: `image_${i}`, role: 'assistant', blocks: [{ type: 'tool', id: `read_${i}`, name: 'Read', input: JSON.stringify({ file_path: file }), output: '[Image attachment]', state: 'completed' }] }));
  view.transcript = { schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: 'claude_00000000000000000000000000000000', ownerDeviceId: thread.ownerDeviceId, deviceName: view.deviceName, title: thread.title, cwd: null, project: 'Projects fixture', state: 'idle', lastActivityAt: new Date().toISOString(), connected: false, canSteer: false, canSend: false }, turns, messages: [], activity: [], truncated: false, observedAt: new Date().toISOString() };
  view.reports = [{ schema: 'thread-report-v1', turn: 1, status: 'done', summary: 'Customers now see one clear next step.\n\nOpen Customers to try the new screen.\n\n![Phone result](shots/phone.png)', changedFiles: ['src/customers.tsx'], synthesized: false }];
  await page.context().route(`**${PROJECT}/threads/${thread.id}`, route => route.fulfill({ json: view }));
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
  await page.context().route(`**${PROJECT}/threads/${thread.id}/image?*`, route => new URL(route.request().url()).searchParams.get('ref') === files[2]
    ? route.fulfill({ status: 404, json: { schema: 'error-v1', code: 'not-found', message: 'This file is no longer in the working copy.' } })
    : route.fulfill({ json: { schema: 'conversation-file-v1', path: 'screen.png', source: 'working-tree', kind: 'image', encoding: 'base64', mime: 'image/png', content: pixel, bytes: 70 } }));
  await page.goto(`/projects/projects_fixture/threads/${thread.id}`);
  await expect(page.getByRole('button', { name: 'Images 3', exact: true })).toBeVisible();
  await expect(page.locator('details.cursor-tool[open]')).toHaveCount(0);
  await expect(page.locator('.pw-report-preview')).toContainText('Customers now see one clear next step.');
  await page.getByRole('button', { name: 'Images 3', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Session images', exact: true });
  await expect(gallery.getByRole('img')).toHaveAttribute('alt', 'desktop.png');
  await expect.poll(() => gallery.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(gallery.getByRole('button', { name: 'Previous image' })).toBeDisabled();
  await page.keyboard.press('ArrowRight'); await expect(gallery.getByRole('img')).toHaveAttribute('alt', 'phone.png');
  await gallery.locator('.thread-image-stage').dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 250, clientY: 200 }] });
  await gallery.locator('.thread-image-stage').dispatchEvent('touchend', { changedTouches: [{ identifier: 0, clientX: 100, clientY: 202 }] });
  await expect(gallery).toContainText('Image unavailable.'); await expect(gallery).toContainText('3 / 3');
  await gallery.getByRole('button', { name: 'Previous image' }).click(); await expect(gallery.getByRole('img')).toHaveAttribute('alt', 'phone.png');
  await shot(page, 'thread-image-gallery', true);
  await page.keyboard.press('Escape'); await expect(gallery).toHaveCount(0);
  await page.locator('.pw-report-disclosure > summary').click();
  await page.getByRole('button', { name: 'Phone result', exact: true }).click();
  await expect(gallery.getByRole('img')).toHaveAttribute('alt', 'phone.png');
  await gallery.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(page.locator('.pw-report-disclosure')).toHaveAttribute('open', '');
  await page.locator('.pw-report-disclosure > summary').click();
  await page.getByRole('button', { name: 'Open image desktop.png', exact: true }).click();
  await expect(gallery.getByRole('img')).toHaveAttribute('alt', 'desktop.png');
  expect(errors).toEqual([]);
});

test('LJ2 native setup remains visible and merge routing explains its ask-owner choice', async ({ page }, info) => {
  const errors = await begin(page);
  await page.goto('/settings/runtimes');
  await expect(page.getByRole('checkbox', { name: 'Use my own Claude Code setup' })).toBeChecked();
  await expect(page.locator('.native-setup').filter({ hasText: 'fixture_hello' })).toContainText('Applied from');
  await expect(page.locator('.native-setup').filter({ hasText: 'fixture_hello' })).toContainText('skills');
  await shot(page, 'native-setup');
  await page.goto('/projects/projects_fixture');
  const settingsResponse = await page.request.get(`${PROJECT}/work-settings`), settings = await settingsResponse.json();
  expect(settings.settings.autoLand).toBe(false);
  const saved = await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision: settings.settings.revision, clientRequestId: `merge_settings_${info.project.name}`, settings: { ...Object.fromEntries(Object.entries(settings.settings).filter(([key]) => !['schema', 'projectId', 'revision'].includes(key))), autoLand: false, riskyAreas: 'Stored data and deploy files.' } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await page.request.post(`${PROJECT}/tasks`, { data: { schema: 'task-create-request-v1', clientRequestId: `request_gate_${info.project.name}`, title: 'Review loop', brief: 'LJ2 review loop: add a greeting example.', type: 'fix', fixed: { isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } } });
  expect(created.ok(), await created.text()).toBe(true); const receipt = TaskReceiptSchema.parse(await created.json());
  await expect.poll(async () => TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks.find(task => task.id === receipt.taskId)?.threadId, LONG).toBeTruthy();
  const started = { threadId: TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks.find(task => task.id === receipt.taskId)!.threadId! };
  await expect.poll(async () => (await work(page)).pullRequests.find(entry => entry.threadId === started.threadId)?.pr?.number, LONG).toBeGreaterThan(0);
  const number = (await work(page)).pullRequests.find(entry => entry.threadId === started.threadId)!.pr!.number;
  await control(`/projects/github/${number}`, { schema: 'fixture-pull-change-v1', checks: 'passing', mergeable: 'clean' });
  await expect.poll(async () => MergeDocumentsViewSchema.parse(await read(page, `${PROJECT}/threads/${started.threadId}/pr/route`)).records.some(row => row.schema === 'merge-route-v1' && row.route === 'ask-owner'), LONG).toBe(true);
  expect((await work(page)).decisions.open.some(item => item.merge?.prNumber === number)).toBe(false); await page.reload();
  await sectionTab(page, info, 'Pull requests');
  const row = page.locator('.pw-pr').filter({ hasText: 'Review loop' }); await expect(row).toBeVisible(LONG);
  await expect(row).toContainText('Jev would: ask you'); await shot(page, 'merge-shadow-route');
  await row.getByRole('button', { name: 'Why', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Why this merge route' }); await expect(drawer).toContainText('Ask owner'); await expect(drawer).toContainText('Stored data and deploy files.');
  await drawer.getByRole('button', { name: "Didn't need asking", exact: true }).click(); await expect(drawer.getByRole('status')).toContainText('Saved');
  await shot(page, 'merge-route-why', true); await drawer.getByRole('button', { name: 'Close panel', exact: true }).click();
  await row.getByRole('button', { name: 'Merge', exact: true }).click(); const mergeDialog = page.getByRole('dialog', { name: /Squash and merge/ });
  await mergeDialog.getByRole('button', { name: 'Merge', exact: true }).click(); await expect.poll(async () => (await work(page)).pullRequests.find(entry => entry.threadId === started.threadId)?.pr?.state, LONG).toBe('merged');
  await page.getByText('Recently merged · last 7 days', { exact: true }).click();
  await expect(row.getByRole('button', { name: 'Should have asked me', exact: true })).toBeVisible(); await row.getByRole('button', { name: 'Should have asked me', exact: true }).click(); await shot(page, 'merged-pr-correction');
  await page.goto(`/projects/projects_fixture/tasks/${receipt.taskId}`); await expect(page.getByRole('heading', { name: 'Review loop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: "Didn't need asking", exact: true })).toBeVisible(); await page.getByRole('button', { name: "Didn't need asking", exact: true }).click(); await shot(page, 'task-merge-correction'); expect(errors).toEqual([]);
});


test('LJ3 one queue preserves dependency order, owner ordering and recovery without duplicate threads', async ({ page }, info) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  const first = `Queue parent ${info.project.name}`, second = `Queue dependent ${info.project.name}`;
  const add = async (title: string, parent?: string) => {
    await tap(page, page.getByRole('button', { name: 'New task', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill('PJ3 long: inspect the project, then wait for my message.');
    if (parent) { await dialog.getByRole('listbox', { name: 'After', exact: true }).selectOption(parent); await dialog.getByRole('checkbox', { name: 'Start now', exact: true }).check(); }
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click(); await expect(dialog).toHaveCount(0);
  };
  const queue = async () => await read(page, `${PROJECT}/tasks`) as { tasks: Array<{ id: string; title: string; threadId: string | null; state: string; ownerRanked: boolean }> };
  await add(first); let parentId = '', thread = '';
  await expect.poll(async () => { const task = (await queue()).tasks.find(task => task.title === first); parentId = task?.id ?? ''; thread = task?.threadId ?? ''; return task?.state; }, LONG).toBe('active');
  await add(second, parentId); await sectionTab(page, info, 'Queue');
  const row = page.locator('.pw-task').filter({ hasText: second }); await row.locator('summary').click();
  await expect(row).toContainText(`Waiting on: ${first}`); await expect(row).toContainText('Now');
  await row.getByRole('button', { name: 'Move to top', exact: true }).click();
  await expect.poll(async () => (await queue()).tasks.find(task => task.title === second)?.ownerRanked).toBe(true);
  const pending = (await queue()).tasks.find(task => task.title === second)!; expect(pending.threadId).toBeNull();
  await shot(page, 'queue-dependency');
  await page.reload(); await sectionTab(page, info, 'Queue');
  expect((await queue()).tasks.filter(task => task.title === first)).toHaveLength(1);
  const stopped = await page.request.post(`${PROJECT}/threads/${thread}/stop`, { data: { schema: 'thread-stop-request-v1' } }); expect(stopped.ok()).toBe(true);
  await expect.poll(async () => (await queue()).tasks.find(task => task.id === pending.id)?.state, LONG).toBe('active');
  expect((await queue()).tasks.filter(task => task.title === second)).toHaveLength(1);
  const dependent = (await queue()).tasks.find(task => task.id === pending.id)!;
  await page.request.post(`${PROJECT}/threads/${dependent.threadId}/stop`, { data: { schema: 'thread-stop-request-v1' } });
  await shot(page, 'queue-recovered'); expect(errors).toEqual([]);
});


test('LJ3 five tasks obey phone drag, Now, the two-thread cap and after links', async ({ page }, info) => {
  const errors = await begin(page), route = '/api/projects/projects_queue'; await openProject(page, 'Projects queue');
  const settings = await read(page, `${route}/work-settings`) as { settings: Record<string, unknown> };
  const { schema: _schema, projectId: _projectId, revision, ...fields } = settings.settings; void _schema; void _projectId;
  const saved = await page.request.put(`${route}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...fields, maxRunningThreads: 2, maxRunningPerDevice: 2 } } }); expect(saved.ok()).toBe(true);
  const blockers: string[] = [];
  for (const number of [1, 2]) { const result = await page.request.post(`${route}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `barrier_${number}`, title: `Queue barrier ${number}`, task: 'PJ3 long: hold the running slot while I arrange the queue.' } }); expect(result.ok()).toBe(true); blockers.push((await result.json()).threadId); }
  await expect.poll(async () => (ProjectWorkViewSchema.parse(await read(page, `${route}/work`))).threads.filter(thread => blockers.includes(thread.id) && thread.state === 'running').length, LONG).toBe(2);
  await composer(page).fill('LJ3 five queue tasks'); await composer(page).press('Enter');
  type Row = { id: string; title: string; state: string; threadId: string | null; ownerRanked: boolean; revision: number };
  const queue = async () => (await read(page, `${route}/tasks`) as { tasks: Row[] }).tasks;
  await expect.poll(async () => (await queue()).length, LONG).toBe(5);
  await sectionTab(page, info, 'Queue');
  const rows = await queue(), fourth = rows.find(row => row.title === 'Loop task 4')!, first = rows.find(row => row.title === 'Loop task 1')!;
  // Use the same touch events as a held finger, including the actual 450 ms long-press timer, in every layout.
  await page.evaluate(({ from, to }) => {
    const source = document.querySelector(`[data-session-id="${from}"] summary`)!, target = document.querySelector(`[data-session-id="${to}"] summary`)!;
    source.scrollIntoView({ block: 'nearest' }); const box = source.getBoundingClientRect(), point = new Touch({ identifier: 1, target: source, clientX: box.left + 20, clientY: box.top + 12 });
    source.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [point], targetTouches: [point], changedTouches: [point] }));
    const state = window as unknown as { queueDrag?: { source: Element; target: Element } }; state.queueDrag = { source, target };
  }, { from: fourth.id, to: first.id });
  await expect(page.locator('.pw-task-dragging')).toHaveCount(1);
  await page.evaluate(() => {
    const state = window as unknown as { queueDrag: { source: Element; target: Element } }, { source, target } = state.queueDrag;
    const box = target.getBoundingClientRect(), point = new Touch({ identifier: 1, target: source, clientX: box.left + 20, clientY: box.top + 4 });
    source.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [point], targetTouches: [point], changedTouches: [point] }));
    source.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [point] }));
  });
  await expect.poll(async () => (await queue()).find(row => row.id === fourth.id)?.ownerRanked).toBe(true);
  await page.waitForTimeout(750); // The shared drag hook suppresses accidental clicks for 700 ms after a drop.
  const fifth = page.locator('.pw-task').filter({ hasText: 'Loop task 5' }); await fifth.locator('summary').click(); await fifth.getByRole('button', { name: 'Start now', exact: true }).click();
  await shot(page, 'five-ranked-tasks');
  for (const id of blockers) expect((await page.request.post(`${route}/threads/${id}/stop`, { data: { schema: 'thread-stop-request-v1' } })).ok()).toBe(true);
  await expect.poll(async () => (await queue()).filter(row => row.state === 'active').map(row => row.title).sort(), LONG).toEqual(['Loop task 4', 'Loop task 5']);
  expect((await queue()).filter(row => row.state === 'queued')).toHaveLength(3);
  const third = page.locator('.pw-task').filter({ hasText: 'Loop task 3' }); await third.locator('summary').click(); await expect(third).toContainText('Waiting on: Loop task 4');
  await shot(page, 'priority-dispatched');
  expect(await control('/projects/release', { schema: 'fixture-release-v1', marker: 'LJ3 Loop task 4' })).toEqual({ released: 1 });
  await expect.poll(async () => (await queue()).find(row => row.id === fourth.id)?.state, LONG).toBe('done');
  // Starts can advance during cleanup. Resolve each current row rather than acting on an earlier revision.
  for (const original of await queue()) {
    if (original.state === 'done') continue;
    await expect.poll(async () => {
      const row = (await queue()).find(task => task.id === original.id)!;
      if (['done', 'cancelled', 'failed'].includes(row.state)) return true;
      const response = row.threadId
        ? await page.request.post(`${route}/threads/${row.threadId}/stop`, { data: { schema: 'thread-stop-request-v1' } })
        : await page.request.post(`${route}/tasks/${row.id}/action`, { data: { schema: 'task-action-request-v1', expectedRevision: row.revision, action: 'cancel' } });
      return response.ok();
    }, LONG).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('LJ4 owner goals refill into a draft, approve on phone, obey daily caps and pause queued work', async ({ page }, info) => {
  const errors = await begin(page), route = '/api/projects/projects_goals';
  await openProject(page, 'Projects goals'); await sectionTab(page, info, 'Routines');
  await tap(page, page.getByRole('button', { name: 'New goal', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'New goal', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Hardening through automated tests');
  await dialog.getByRole('textbox', { name: 'Motivation', exact: true }).fill('Protect the paths people rely on so the owner can trust daily work.');
  await dialog.getByRole('textbox', { name: 'Health', exact: true }).fill('Tests cover the important paths and findings are resolved.');
  await dialog.getByRole('spinbutton', { name: 'Refills a day', exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const queue = async () => (await read(page, `${route}/tasks`) as { tasks: Array<{ id: string; revision: number; title: string; state: string; threadId: string | null; goalId: string | null; source: string }> }).tasks;
  await expect.poll(async () => (await queue()).filter(task => task.source === 'refill').length, LONG).toBe(1);
  await sectionTab(page, info, 'Threads');
  const proposal = page.locator('.pw-proposed .pw-task').filter({ hasText: 'Exercise an important path' });
  await proposal.locator('summary').click(); await expect(proposal).toContainText('Draft'); await shot(page, 'goal-proposal');
  await proposal.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(async () => (await queue()).find(task => task.source === 'refill')?.state, LONG).toBe('active');
  expect(await control('/projects/release', { schema: 'fixture-release-v1', marker: 'LJ4 goal task' })).toEqual({ released: 1 });
  await expect.poll(async () => (await queue()).find(task => task.source === 'refill')?.state, LONG).toBe('done');
  await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 31 });
  expect((await queue()).filter(task => task.source === 'refill')).toHaveLength(1);
  await sectionTab(page, info, 'Routines');
  const card = page.locator('.pw-goal').filter({ hasText: 'Hardening through automated tests' });
  await expect(card).toContainText('1 refilled today');
  // Goal actions scroll with the side column; normal click brings the lower card into view on desktop.
  await card.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(card).toContainText('Paused');
  await tap(page, page.getByRole('button', { name: 'New task', exact: true }));
  const taskDialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await taskDialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Paused goal task');
  await taskDialog.getByRole('textbox', { name: 'Brief', exact: true }).fill('LJ4: wait until the owner reactivates this goal.');
  await taskDialog.getByRole('combobox', { name: 'Goal', exact: true }).selectOption({ label: 'Hardening through automated tests' });
  await taskDialog.getByRole('button', { name: 'Add to queue', exact: true }).click(); await expect(taskDialog).toHaveCount(0);
  await sectionTab(page, info, 'Queue');
  const paused = page.locator('.pw-section[data-tab="queue"] .pw-task').filter({ hasText: 'Paused goal task' });
  await paused.locator('summary').click(); await expect(paused).toContainText('Goal paused');
  await control('/projects/pulse'); expect((await queue()).find(task => task.title === 'Paused goal task')).toMatchObject({ state: 'queued', threadId: null });
  await page.getByRole('group', { name: 'Queue grouping' }).getByRole('button', { name: 'Goals', exact: true }).click();
  await shot(page, 'goal-paused'); await page.reload();
  await sectionTab(page, info, 'Queue');
  await expect(page.getByRole('group', { name: 'Queue grouping' }).getByRole('button', { name: 'Goals', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await queue()).find(task => task.title === 'Paused goal task')).toMatchObject({ state: 'queued', threadId: null });
  await sectionTab(page, info, 'Routines');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit goal', exact: true });
  await expect(editor.getByRole('spinbutton', { name: 'Open pull requests', exact: true })).toHaveValue('2');
  await editor.getByRole('spinbutton', { name: 'Open pull requests', exact: true }).fill('3');
  await shot(page, 'goal-shared-editor'); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor).toBeHidden();
  await expect(card).toContainText('Open pull requests: 3');
  await card.getByRole('button', { name: 'Mark done', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Mark "Hardening through automated tests" done?', exact: true });
  await expect(confirmation).toContainText('Queued and proposed tasks are cancelled. Running tasks finish.');
  await shot(page, 'goal-done-confirmation'); await confirmation.getByRole('button', { name: 'Mark done', exact: true }).click(); await expect(confirmation).toBeHidden();
  await expect(card.locator('.chip')).toHaveText('Done');
  expect((await queue()).find(task => task.title === 'Paused goal task')).toMatchObject({ state: 'cancelled', threadId: null });
  expect(errors).toEqual([]);
});

test('LJ5 nights run configured jobs before review and findings wait until the window ends', async ({ page }, info) => {
  const errors = await begin(page), route = '/api/projects/projects_daily';
  const step = (action: string) => control('/projects/daily', { schema: 'fixture-daily-control-v1', action });
  const prepared = await step('prepare') as { command: string };
  const post = async (path: string, data: object) => { const response = await page.request.post(`${route}${path}`, { data }); expect(response.ok(), await response.text()).toBe(true); return response.json(); };
  const goal = (await post('/goals', { schema: 'goal-create-request-v1', clientRequestId: 'daily_resilience', name: 'Resilience', motivation: 'Catch regressions.', health: 'Findings close promptly.' })).goal;
  const full = await post('/jobs', { schema: 'job-create-request-v1', clientRequestId: 'night_suite', name: 'Full suite', goalId: goal.id, enabled: true, gate: null, run: { kind: 'command', command: prepared.command, timeoutMinutes: 5 } });
  await post('/dailies', { schema: 'daily-create-request-v1', clientRequestId: 'night_suite', name: 'Full suite', goalId: goal.id, order: 1, enabled: true, target: { kind: 'job', jobId: full.id } });
  await post('/dailies', { schema: 'daily-create-request-v1', clientRequestId: 'night_review', name: 'Review since last', goalId: goal.id, order: 2, enabled: true, target: { kind: 'review-since-last' } });
  await openProject(page, 'Projects daily'); await sectionTab(page, info, 'Routines');
  const view = async () => ProjectDailyListViewSchema.parse(await read(page, `${route}/dailies`));
  await step('open'); await expect.poll(async () => (await view()).runs.some(run => run.phase === 'executing'), LONG).toBe(true);
  const window = (await view()).window!; expect(window.plans.map(task => task.title)).toEqual(['Full suite', 'Review since last']); expect(window.mergesHeld).toBe(true);
  await shot(page, 'WG3-nights-before-review', true);
  await step('pass'); await expect.poll(async () => (await view()).window?.state, LONG).toBe('finished');
  const completed = await view(); expect(completed.runs.find(run => run.jobId === full.id)?.conclusion).toBe('passed'); expect(completed.lastReview).not.toBeNull();
  await expect(page.getByText(/Last night's review/)).toBeVisible(); await shot(page, 'WG3-night-completed', true); expect(errors).toEqual([]);
});

test('PJ3b project GitHub tokens remain separate from the default connection', async ({ page }) => {
  const errors = await begin(page); await page.goto('/settings/git');
  const card = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'GitHub token', exact: true }) });
  await page.getByRole('combobox', { name: 'GitHub token scope', exact: true }).selectOption('projects_fixture');
  await expect(card.locator('.pw-token-summary')).toHaveText('Not set');
  await card.getByRole('button', { name: 'Add token', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Add a GitHub token', exact: true });
  const value = `fixture-${randomUUID()}`; await dialog.getByLabel('GitHub token', { exact: true }).fill(value); await dialog.getByRole('button', { name: 'Save token', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(card.locator('.pw-token-summary')).toContainText('Saved'); expect(await page.content()).not.toContain(value);
  await shot(page, 'project-github-token');
  await page.getByRole('combobox', { name: 'GitHub token scope', exact: true }).selectOption(''); await expect(card.locator('.pw-token-summary')).toContainText('Saved');
  await page.getByRole('combobox', { name: 'GitHub token scope', exact: true }).selectOption('projects_fixture'); await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove the GitHub token?', exact: true }).getByRole('button', { name: 'Remove', exact: true }).click(); await expect(card.locator('.pw-token-summary')).toHaveText('Not set');
  await page.getByRole('combobox', { name: 'GitHub token scope', exact: true }).selectOption(''); await expect(card.locator('.pw-token-summary')).toContainText('Saved'); expect(errors).toEqual([]);
});

test('WG3 command jobs and weekly nightly items preserve retired receipts', async ({ page }, info) => {
  const errors = await begin(page), route = '/api/projects/projects_workflows'; await openProject(page, 'Projects workflows');
  await sectionTab(page, info, 'Routines');
  await tap(page, page.getByRole('button', { name: 'New job', exact: true })); const dialog = page.getByRole('dialog', { name: 'New job', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Night command');
  await dialog.getByRole('textbox', { name: 'Command', exact: true }).fill('printf nightly-passed');
  await dialog.getByRole('textbox', { name: 'Device tags', exact: true }).fill('linux, prod-access');
  await dialog.getByRole('combobox', { name: 'Working directory', exact: true }).selectOption('workspace');
  await shot(page, 'WG3-command-editor', true);
  await dialog.getByRole('textbox', { name: 'Device tags', exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await tap(page, page.getByRole('button', { name: 'New nightly item', exact: true })); const daily = page.getByRole('dialog', { name: 'New nightly item', exact: true });
  await daily.getByRole('textbox', { name: 'Name', exact: true }).fill('Weekly checks');
  await daily.getByRole('combobox', { name: 'Job', exact: true }).selectOption({ label: 'Night command' });
  await daily.getByRole('checkbox', { name: 'Mon', exact: true }).check();
  await daily.getByRole('checkbox', { name: 'Thu', exact: true }).check();
  await shot(page, 'WG3-weekday-editor', true);
  await daily.getByRole('button', { name: 'Save', exact: true }).click(); await expect(daily).toHaveCount(0);
  const row = page.locator('[data-daily-id]').filter({ hasText: 'Weekly checks' }); await expect(row).toContainText('Mon, Thu');
  await row.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(async () => ProjectDailyListViewSchema.parse(await read(page, `${route}/dailies`)).runs[0]?.conclusion, LONG).toBe('passed');
  await expect(row).toContainText('Done today'); await row.locator('details summary').click(); await expect(row).toContainText('nightly-passed');
  const enabled = row.getByRole('checkbox', { name: 'Enable Weekly checks', exact: true });
  await enabled.click(); await expect(enabled).not.toBeChecked(); await expect(row.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await enabled.click(); await expect(enabled).toBeChecked(); await expect(row.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await page.locator('details.pw-jobs > summary').filter({ hasText: /^Jobs \(/u }).click();
  const command = page.locator('article.pw-goal').filter({ has: page.getByRole('heading', { name: 'Night command', exact: true }) });
  await command.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(command.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled(); await expect(command).toContainText('Paused');
  await command.getByRole('button', { name: 'Resume', exact: true }).click(); await expect(command.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  const refused = await page.request.post(`${route}/jobs`, { data: { schema: 'job-create-request-v1', clientRequestId: 'retired_workflow', name: 'Retired workflow', goalId: null, enabled: true, gate: null, run: { kind: 'github-workflow', workflow: 'old.yml', mode: 'watch', timeoutMinutes: 5 } } }); expect(refused.status()).toBe(400);
  await control('/projects/daily', { schema: 'fixture-daily-control-v1', action: 'retired' }); await page.reload(); await sectionTab(page, info, 'Routines');
  await expect(page.getByText('GitHub workflow (retired 19 October)', { exact: true }).first()).toBeVisible();
  await shot(page, 'WG3-retired-and-completed', true); expect(errors).toEqual([]);
});

test('LJ7 two fix effort corrections appear first in the next fix Why panel', async ({ page }) => {
  const errors = await begin(page); const api = '/api/projects/projects_typed';
  for (let i = 1; i <= 3; i++) {
    await page.goto('/projects/projects_typed');
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(`Small fix ${i}`);
    await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill(`LJ7 fix: repair edge case ${i}.`);
    await dialog.getByRole('combobox', { name: 'Type', exact: true }).selectOption('fix');
    await dialog.locator('summary').filter({ hasText: 'Choose where it runs' }).click();
    await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('codex-gpt');
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click(); await expect(dialog).toBeHidden();
    let id = '';
    await expect.poll(async () => { const tasks = TaskListViewSchema.parse(await read(page, `${api}/tasks`)); id = tasks.tasks.find(row => row.title === `Small fix ${i}`)?.threadId ?? ''; return id; }, LONG).toMatch(/^thread_/);
    await page.goto(`/projects/projects_typed/threads/${id}`); await expect(page.locator('.pw-state-chip')).toHaveText('Idle', LONG);
    if (i < 3) {
      await page.getByRole('button', { name: 'Override', exact: true }).click();
      const override = page.getByRole('dialog', { name: 'Override', exact: true });
      await override.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('medium');
      await override.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(override).toBeHidden();
    } else {
      const receipt = ThreadViewSchema.parse(await read(page, `${api}/threads/${id}`)).placement;
      const sentences = ["effort changed from high to medium for a fix task 'Small fix 2' (next-turn)", "effort changed from high to medium for a fix task 'Small fix 1' (next-turn)"];
      expect(receipt.correctionsShown).toEqual(sentences); expect(receipt.taskContext?.type).toBe('fix');
      await page.getByRole('button', { name: 'Why', exact: true }).click();
      const panel = page.getByRole('dialog', { name: 'Why this placement', exact: true });
      await expect(panel.getByRole('heading', { name: 'Corrections shown to Jev', exact: true })).toBeVisible();
      await expect(panel.locator('ol li')).toHaveText(sentences);
      await panel.locator('ol').scrollIntoViewIfNeeded();
      await expect(panel.locator('ol')).toBeInViewport();
      await expect(panel.getByRole('heading', { name: 'Corrections shown to Jev', exact: true })).toBeInViewport();
      await shot(page, 'typed-corrections', false);
    }
  }
  expect(errors).toEqual([]);
});

test('LJ8 Ekoa connection mirrors decisions, ask-owner pulls and aggregated drafts without duplicates', async ({ page }) => {
  const errors = await begin(page);
  const prepared = await control('/projects/ekoa', { schema: 'fixture-ekoa-loop-v1', action: 'prepare' }) as { url: string; token: string };
  await page.goto('/settings/ekoa'); await expect(page.getByRole('heading', { name: 'Ekoa', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'MCP URL', exact: true }).fill(prepared.url);
  await page.getByLabel('Ekoa token', { exact: true }).fill(prepared.token);
  await page.getByRole('checkbox', { name: 'Mirror tasks to Ekoa', exact: true }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByLabel('Ekoa token', { exact: true })).toHaveValue('');
  const step = (action: string) => control('/projects/ekoa', { schema: 'fixture-ekoa-loop-v1', action });
  await step('tick'); await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible(LONG);
  await expect(page.getByText('Jevellan · Projects mirror: 3 proposed tasks', { exact: true })).toBeVisible(LONG);
  await shot(page, 'connected-drafts');
  const routed = await step('ask-owner') as { tasks: Array<{ title: string; status: string }> };
  expect(routed.tasks.filter(row => row.title === 'Jevellan · Projects mirror: merge #99 Handle empty input')).toHaveLength(1);
  await step('tick'); await step('answer'); await step('approve'); await step('merge');
  // A periodic synchronization can already hold an earlier snapshot. Wait for the next completed pass.
  await expect.poll(async () => {
    const final = await step('tick') as { tasks: Array<{ title: string; status: string }> };
    return { decision: final.tasks.find(row => row.title === 'Jevellan · Projects mirror: Which empty state?')?.status,
      merge: final.tasks.find(row => row.title.includes('merge #99'))?.status,
      drafts: final.tasks.filter(row => row.title.includes('Projects mirror: 2 proposed tasks')).length };
  }, LONG).toEqual({ decision: 'done', merge: 'done', drafts: 1 });
  await page.reload(); await expect(page.getByText('Jevellan · Projects mirror: 2 proposed tasks', { exact: true })).toBeVisible(LONG);
  expect(await page.content()).not.toContain(prepared.token); await shot(page, 'mirror-updated');
  expect(errors).toEqual([]);
});

test('LJ10 hard device needs, resource refusals, facts in Why and confirmed orphan cleanup', async ({ page }, info) => {
  const errors = await begin(page), step = (action: string) => control('/projects/devices', { schema: 'fixture-devices-v1', action });
  const devices = await step('prepare') as { hubId: string; memberId: string; miniId: string };
  const start = async (name: string, needs: string[] = [], fixedDevice?: string) => {
    const response = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: name,
      task: 'LJ10 device: inspect without changing files.', isolation: 'worktree', taskContext: { type: 'analysis', goal: null, needs }, ...(fixedDevice ? { deviceId: fixedDevice } : {}) } });
    return { response, body: await response.json() };
  };
  const residential = await start('LJ10 residential task', ['residential']); expect(residential.response.ok()).toBe(true);
  const pro = await threadView(page, residential.body.threadId); expect(pro.thread.ownerDeviceId).toBe(devices.hubId);
  expect(pro.placement.excludedDevices).toContainEqual({ deviceId: devices.memberId, reason: 'missing tags: residential' });
  await expect.poll(async () => (await threadView(page, pro.thread.id)).thread.state, LONG).toBe('done');
  const datacenter = await start('LJ10 datacenter task', ['datacenter']); expect(datacenter.response.ok()).toBe(true);
  await expect.poll(async () => (await work(page)).threads.find(thread => thread.id === datacenter.body.threadId)?.state, LONG).toBe('done');
  expect((await threadView(page, datacenter.body.threadId)).thread.ownerDeviceId).toBe(devices.memberId);
  const any = await start('LJ10 choose from facts'); expect(any.response.ok()).toBe(true);
  const selected = await threadView(page, any.body.threadId); expect(selected.placement.deviceFacts?.find(row => row.deviceId === devices.hubId)?.facts?.cores).toBe(8);
  const packets = await step('healthy') as { packets: Array<{ schema: string; devices: Array<{ facts?: { cores: number } }> }> };
  expect(packets.packets.some(packet => packet.schema === 'placement-state-v3' && packet.devices.some(device => device.facts?.cores === 8))).toBe(true);
  await expect.poll(async () => (await threadView(page, any.body.threadId)).thread.state, LONG).toBe('done');
  const mini = await start('LJ10 mini exclusion', ['residential'], devices.miniId); expect(mini.response.status()).toBe(409);
  await step('low-disk'); const low = await start('LJ10 low disk', [], devices.hubId); expect(low.response.status()).toBe(409); expect(low.body.message).toContain('has 19 GB free; Jevellan needs at least 20 GB');
  await step('busy'); const busy = await start('LJ10 busy', [], devices.hubId); expect(busy.response.status()).toBe(409); expect(busy.body.message).toContain('is busy (load 17 on 8 cores)'); await step('healthy');
  await page.goto(`/projects/projects_fixture/threads/${any.body.threadId}`); await tap(page, page.getByRole('button', { name: 'Why', exact: true }));
  const why = page.getByRole('dialog', { name: 'Why this placement', exact: true }); await expect(why).toContainText('Devices when placed'); await expect(why).toContainText('80 GB free'); await shot(page, 'device-facts-why', false);
  await why.getByRole('button', { name: 'Close panel', exact: true }).click();
  await step('orphan'); await page.goto('/settings/devices');
  const roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster')), here = roster.devices.find(row => row.device.id === devices.hubId)!.device.name;
  const card = page.locator('.device-card').filter({ has: page.getByRole('heading', { name: here, exact: true }) });
  await expect(card).toContainText('Thread worktrees:'); await expect(page.getByText('Apps only', { exact: true })).toBeVisible();
  await card.getByRole('textbox', { name: 'Device tags', exact: true }).fill('mac, residential, browser-automation, phone-testing'); await card.getByRole('button', { name: 'Save tags', exact: true }).click();
  await expect.poll(async () => DeviceRosterSchema.parse(await read(page, '/hub/devices/roster')).devices.find(row => row.device.id === devices.hubId)?.device.tags).toContain('phone-testing');
  await card.getByRole('button', { name: 'Remove orphaned worktrees', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove orphaned worktrees', exact: true }); await expect(confirmation).toContainText('older than seven days');
  await shot(page, 'devices-confirm-cleanup', true); await confirmation.getByRole('button', { name: 'Remove worktrees', exact: true }).click(); await expect(confirmation).toBeHidden(LONG);
  expect(WorktreeDiskSchema.parse(await read(page, `/api/devices/${devices.hubId}/worktrees`)).entries.some(entry => entry.id === 'orphan_fixture')).toBe(false);
  await shot(page, 'devices-cleaned', true); expect(errors).toEqual([]); expect(layout(info)).toBeTruthy();
});

test('hub readiness warns about AC sleep and clears when the setting is safe', async ({ page }) => {
  const errors = await begin(page);
  await control('/projects/devices', { schema: 'fixture-devices-v1', action: 'power-sleep' });
  await page.goto('/settings/devices');
  const warning = page.getByText(/Hub readiness: this Mac can sleep on AC power/);
  await expect(warning).toHaveCount(1); await expect(warning).toBeVisible();
  await expect(warning).toContainText('sudo pmset -c sleep 0');
  await shot(page, 'hub-power-warning', true);
  await control('/projects/devices', { schema: 'fixture-devices-v1', action: 'power-awake' }); await page.reload();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  await expect(page.locator('.device-card').filter({ has: page.getByText('Hub', { exact: true }) })).toBeVisible();
  await expect(page.getByText(/Hub readiness: this Mac can sleep on AC power/)).toHaveCount(0);
  await shot(page, 'hub-power-ready', true); expect(errors).toEqual([]);
});

test('CACHE1 session metrics and runtime windows persist across reload in every layout', async ({ page }) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await composer(page).fill('CACHE1 metrics'); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).sessionCache?.some(row => row.owner.kind === 'coordinator' && row.cacheReadTokens === 80), LONG).toBe(true);
  await page.reload();
  await expect(page.getByLabel('Session cache today')).toContainText('80%');
  await page.getByText('Sessions and cache · today', { exact: true }).click();
  await expect(page.locator('.session-cache-table')).toContainText('48,000');
  await shot(page, 'sessions-cache', true);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Cache metrics thread', task: 'CACHE1 metrics', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.sessionCache?.length, LONG).toBe(1);
  await page.goto(`/projects/projects_fixture/threads/${started.threadId}`);
  await expect(page.getByLabel('Session cache today')).toContainText('80%');
  await shot(page, 'thread-cache', true);
  await page.goto('/settings/runtimes');
  const window = page.getByRole('spinbutton', { name: 'Claude Code cache window (minutes)', exact: true });
  await window.fill('17'); await window.press('Tab');
  await expect.poll(async () => (await (await page.request.get('/hub/config')).json()).configuration['x-jevellan'].runtimes.claude.cacheWindowMinutes, LONG).toBe(17);
  await page.reload(); await expect(window).toHaveValue('17');
  await shot(page, 'runtime-cache-window', true);
  expect(errors).toEqual([]);
});

test('CM1 compaction controls show context, persist the threshold and start a fresh session on request', async ({ page }) => {
  await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 0, reset: true });
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  let dialog = await openSettings(page); const percent = dialog.getByRole('spinbutton', { name: 'Compact at percent', exact: true });
  await expect(percent).toHaveValue('70'); await percent.fill('65'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0); dialog = await openSettings(page);
  await expect(dialog.getByRole('spinbutton', { name: 'Compact at percent', exact: true })).toHaveValue('65');
  await shot(page, 'compaction-settings', false); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await composer(page).fill('CM1 compaction'); await composer(page).press('Enter');
  await expect(page.getByLabel('Coordinator context', { exact: true })).toContainText('Context 15%');
  await expect(page.getByLabel('Coordinator context', { exact: true })).toContainText('Compacted 1 times today');
  await expect(page.getByLabel('Coordinator context', { exact: true })).toContainText('Last compaction');
  const statusBox = await page.locator('.pw-coordinator').boundingBox(), contextBox = await page.locator('.pw-context').boundingBox();
  expect(statusBox).not.toBeNull(); expect(contextBox).not.toBeNull(); expect(contextBox!.y).toBeGreaterThanOrEqual(statusBox!.y + statusBox!.height);
  await shot(page, 'compacted-session');
  await tap(page, page.getByRole('button', { name: 'Fresh session', exact: true }));
  await expect.poll(async () => (await work(page)).coordinator.session).toBeNull();
  expect(errors).toEqual([]);
});

test('CM2 questions share oldest-first numbering and show the owner chat answer in every layout', async ({ page }) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await composer(page).fill('CM2 questions'); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).decisions.open.length, LONG).toBe(3);
  const before = await work(page), questions = before.decisions.open;
  expect(questions.map(question => question.question)).toEqual(['Archive or remove customers?', 'Red or amber for overdue invoices?', 'How many customers per page?']);
  await sectionTab(page, test.info(), 'Waiting');
  const cards = page.locator('.pw-decision'); await expect(cards).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(cards.nth(index).getByLabel(`Question ${index + 1}`, { exact: true })).toHaveText(String(index + 1));
    await expect(cards.nth(index)).toContainText(questions[index]!.question);
  }
  await shot(page, 'numbered-questions');
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  const answer = '1 Archive, 2 Amber, 3 25'; await composer(page).fill(answer); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).decisions.open.length, LONG).toBe(0);
  const after = await work(page);
  expect(after.decisions.answered.filter(question => questions.some(before => before.id === question.id)).map(question => question.answer))
    .toEqual(expect.arrayContaining(['Archive', 'Amber', '25'].map(optionLabel => ({ optionLabel, source: 'owner-chat', ownerMessage: answer }))));
  await sectionTab(page, test.info(), 'Waiting');
  await page.locator('.pw-answered summary').click();
  await expect(page.locator('.pw-answered-answer').filter({ hasText: `Answered in chat: ${answer}` })).toHaveCount(3);
  await shot(page, 'answered-in-chat'); expect(errors).toEqual([]);
});

test('CM3 shared memory shows the inbox, dream diff, owner controls and Undo in every layout', async ({ page }) => {
  const errors = await begin(page); await control('/projects/memory', { schema: 'fixture-shared-memory-v1', action: 'prepare' });
  await page.goto('/settings/projects'); const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Shared memory fixture', exact: true }) });
  await card.getByRole('button', { name: 'Browse memory', exact: true }).click(); let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Inbox (from today)', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Customer test environment', exact: true })).toBeVisible(LONG);
  await expect(dialog.getByLabel('Capture durable knowledge from sessions')).toBeChecked();
  await dialog.getByLabel('Nightly dream', { exact: true }).selectOption('suggest');
  await expect.poll(async () => (await (await page.request.get('/api/projects/shared_memory_fixture/work-settings')).json()).settings.memory.dreamMode).toBe('suggest');
  await shot(page, 'shared-memory-inbox', false);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await control('/projects/memory', { schema: 'fixture-shared-memory-v1', action: 'suggest' });
  await card.getByRole('button', { name: 'Browse memory', exact: true }).click(); dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Kept the test conventions'); await dialog.locator('summary').filter({ hasText: 'Memory changes' }).click();
  await expect(dialog.locator('.pw-job-log')).toContainText('SANDBOX_DATA_DIR');
  await shot(page, 'memory-dream-suggestion', false);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeVisible(LONG);
  await expect(dialog.getByText('No inbox notes.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Customer test environment', exact: true })).toBeVisible(LONG);
  await shot(page, 'memory-dream-undone', false); expect(errors).toEqual([]);
});

test('CM4 owner commands and shell blocks show exact copy controls, with editable protected paths in every layout', async ({ page }) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await composer(page).fill('CM4 owner commands'); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).decisions.open.some(question => !!question.ownerCommands?.length), LONG).toBe(true);
  await expect(page.locator('.shell-command').filter({ hasText: 'codex login' }).getByRole('button', { name: 'Run in Terminal', exact: true })).toBeVisible(LONG);
  await sectionTab(page, test.info(), 'Waiting');
  const card = page.locator('.owner-command').first(); const command = (await work(page)).decisions.open.find(question => question.ownerCommands?.length)?.ownerCommands?.[0]?.command;
  expect(command).toBeTruthy(); await expect(card.locator('pre')).toHaveText(command!); await expect(card).toContainText('checkout');
  expect(await card.locator('pre').evaluate(pre => pre.scrollWidth > pre.clientWidth && pre.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await expect(card.getByText('Scroll sideways to read the full command.', { exact: true })).toBeVisible();
  expect(await card.locator('pre').evaluate(pre => { pre.scrollLeft = pre.scrollWidth; const reached = pre.scrollLeft + pre.clientWidth >= pre.scrollWidth - 1; pre.scrollLeft = 0; return reached; })).toBe(true);
  await card.getByRole('button', { name: 'Copy', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await expect(card.getByRole('button', { name: 'Run in Terminal', exact: true })).toBeVisible();
  await shot(page, 'owner-command-question');
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Reserved owner step', task: 'CM4 owner command thread', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).reports.some(report => report.ownerCommands?.length), LONG).toBe(true);
  const ownerDeviceId = (await threadView(page, started.threadId)).thread.ownerDeviceId;
  await page.goto(`/projects/projects_fixture/threads/${started.threadId}`);
  const report = page.locator('.pw-report').first(); await expect(report.locator('.owner-command pre')).toHaveText('scripts/owner-only.sh');
  await expect(report.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(2);
  await expect(report.getByRole('button', { name: 'Run in Terminal', exact: true })).toHaveCount(2);
  await shot(page, 'owner-command-report');
  await page.goto('/settings/devices'); const device = page.locator('.card').filter({ hasText: 'This device · Online' });
  await device.getByLabel('Protected paths', { exact: true }).fill('/srv/owner-checkout\n/srv/credentials');
  await device.getByRole('button', { name: 'Save protected paths', exact: true }).click();
  await expect.poll(async () => DeviceRosterSchema.parse(await read(page, '/hub/devices/roster')).devices.find(row => row.device.id === ownerDeviceId)?.device.protectedPaths).toEqual(['/srv/owner-checkout', '/srv/credentials']);
  await shot(page, 'protected-paths', false); expect(errors).toEqual([]);
});

test('CM5 owner terminal reconnects, relays, copies command records and returns owner actions in every layout', async ({ page }) => {
  const errors = await begin(page); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await openProject(page, 'Projects fixture');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const launcher = page.getByLabel('Project terminals'); await launcher.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(page).toHaveURL(/\/terminals\//u); const id = page.url().split('/').at(-1)!;
  const snapshot = async () => TerminalSnapshotSchema.parse(await read(page, `/api/terminals/${id}`));
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible(LONG);
  await page.getByRole('checkbox', { name: 'Type straight into terminal', exact: true }).check();
  await expect.poll(() => page.evaluate(() => {
    const heading = document.querySelector('.terminal-heading')!.getBoundingClientRect();
    const header = document.querySelector('.app-header')!.getBoundingClientRect();
    return heading.top >= header.bottom && document.documentElement.scrollHeight <= window.innerHeight + 1;
  }), LONG).toBe(true);
  await page.getByRole('checkbox', { name: 'Type straight into terminal', exact: true }).uncheck();
  const run = async (command: string) => { await page.getByRole('textbox', { name: 'Type or dictate a command' }).fill(command); await page.locator('.terminal-commandline').getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => (await snapshot()).commands.some(row => row.command === command && row.endedAt !== null), LONG).toBe(true); };
  await run('pwd'); expect((await snapshot()).commands.at(-1)!.output).toContain((await snapshot()).session.cwd);
  await run('echo hello'); const session = (await snapshot()).session;
  await page.getByRole('textbox', { name: 'Type or dictate a command' }).fill('sleep 100'); await page.locator('.terminal-commandline').getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(async () => (await snapshot()).commands.at(-1)?.command, LONG).toBe('sleep 100');
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'C', exact: true }).click(); await expect.poll(async () => (await snapshot()).commands.at(-1)?.endedAt, { timeout: 2000 }).not.toBeNull();
  expect((await snapshot()).commands.at(-1)!.exitCode).not.toBe(0);
  await page.reload(); await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible(LONG); expect((await snapshot()).session.id).toBe(session.id);
  await expect(page.locator('.xterm-screen')).toBeVisible();
  for (let number = 1; number <= 6; number++) await run(`echo record-${number}`);
  await shot(page, 'owner-terminal-connected', false);
  if (phone(test.info())) await page.getByRole('button', { name: 'Terminal menu', exact: true }).click();
  await page.getByRole('button', { name: 'Copy last command', exact: true }).filter({ visible: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('$ echo record-6'); let copied = await page.evaluate(() => navigator.clipboard.readText()); expect(copied).not.toContain('record-5');
  await page.getByRole('button', { name: 'Copy last 5 commands', exact: true }).filter({ visible: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('$ echo record-2'); copied = await page.evaluate(() => navigator.clipboard.readText()); for (let number = 2; number <= 6; number++) expect(copied).toContain(`$ echo record-${number}`); expect(copied).not.toContain('record-1');
  await page.getByRole('button', { name: 'Copy all', exact: true }).filter({ visible: true }).click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('hello'); copied = await page.evaluate(() => navigator.clipboard.readText()); expect(copied).not.toContain(String.fromCharCode(27));
  await page.getByRole('button', { name: 'Send to…', exact: true }).filter({ visible: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await page.goto('/projects/projects_fixture'); if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await expect(page.getByText('The owner sent output from the terminal on', { exact: false }).first()).toContainText('echo record-6', LONG);
  await page.goto(`/terminals/${id}`); await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible(LONG);
  if (phone(test.info())) await page.getByRole('button', { name: 'Terminal menu', exact: true }).click();
  await shot(page, 'owner-terminal-phone-controls', false);
  const roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster')), member = roster.devices.find(row => row.device.name === 'Browser member')!;
  const remote = await page.request.post('/api/terminals', { data: { schema: 'terminal-create-request-v1', clientRequestId: randomUUID(), deviceId: member.device.id, cwd: 'home' } }); expect(remote.ok()).toBe(true); const receipt = await remote.json();
  await page.goto(`/terminals/${receipt.session.id}`); await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible(LONG);
  await page.getByRole('textbox', { name: 'Type or dictate a command' }).fill('hostname'); await page.locator('.terminal-commandline').getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(async () => TerminalSnapshotSchema.parse(await read(page, `/api/terminals/${receipt.session.id}`)).commands.some(row => row.command === 'hostname' && row.exitCode === 0), LONG).toBe(true);
  await shot(page, 'member-terminal-relay', false);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Terminal owner setup', task: 'CM5 owner command thread', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } }); expect(created.ok()).toBe(true); const started = await created.json();
  await expect.poll(async () => (await threadView(page, started.threadId)).reports.some(row => row.ownerCommands?.length), LONG).toBe(true);
  await page.goto(`/projects/projects_fixture/threads/${started.threadId}`); const commandCard = page.locator('.owner-command').first(); await expect(commandCard.locator('pre')).toHaveText('scripts/owner-only.sh'); await commandCard.getByRole('button', { name: 'Run in Terminal', exact: true }).click();
  await expect(page).toHaveURL(/\/terminals\//u); await expect.poll(async () => (await threadView(page, started.threadId)).reports.some(row => row.summary.includes('owner command finished with exit code 0')), LONG).toBe(true);
  await page.goto(`/projects/projects_fixture/threads/${started.threadId}`); await expect(page.locator('.owner-command').first()).toContainText('Ran in terminal at', LONG); await shot(page, 'owner-command-return', false);
  if ((page.viewportSize()?.width ?? 1440) <= 600) {
    const actions = await page.locator('.pw-thread-heading > .actions').boundingBox(), meta = await page.locator('.pw-thread-heading > .conversation-meta').boundingBox();
    expect(actions).not.toBeNull(); expect(meta).not.toBeNull(); expect(meta!.y).toBeGreaterThanOrEqual(actions!.y + actions!.height);
  }
  await page.getByRole('button', { name: 'Take over in browser', exact: true }).click(); await expect(page).toHaveURL(/\/terminals\//u);
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.state, LONG).toBe('attached');
  await page.getByRole('textbox', { name: 'Type or dictate a command' }).fill('exit 0'); await page.locator('.terminal-commandline').getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(async () => (await threadView(page, started.threadId)).thread.state, LONG).toBe('idle'); expect(errors).toEqual([]);
});


test('CACHE2 cold checkpoints preserve earlier transcripts and the owner settings in every layout', async ({ page }) => {
  await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 0, reset: true });
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  let dialog = await openSettings(page);
  const enabled = dialog.getByRole('checkbox', { name: 'Checkpoint large cold sessions', exact: true });
  await expect(enabled).not.toBeChecked(); await enabled.check();
  const minimum = dialog.getByRole('spinbutton', { name: 'Checkpoint minimum context tokens', exact: true });
  await expect(minimum).toHaveValue('40000'); await minimum.fill('42000');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0);
  dialog = await openSettings(page); await expect(enabled).toBeChecked(); await expect(minimum).toHaveValue('42000');
  await shot(page, 'checkpoint-settings', false); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (phone(test.info())) await tap(page, tab(page, 'Chat'));
  await composer(page).fill('CACHE1 metrics'); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).coordinator.session?.context?.tokens, LONG).toBe(48000);
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Checkpoint thread', task: 'CACHE1 metrics', isolation: 'worktree', modelId: 'claude-fable', effort: 'high' } });
  expect(created.ok()).toBe(true); const thread = await created.json();
  await expect.poll(async () => (await threadView(page, thread.threadId)).thread.sessionCache?.length, LONG).toBe(1);
  await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 61 });
  await composer(page).fill('CACHE2 continue'); await composer(page).press('Enter');
  await expect.poll(async () => (await work(page)).coordinator.sessionHistory?.length, LONG).toBe(1);
  await page.getByText('Earlier sessions (1)', { exact: true }).click();
  await page.locator('a[href*="/session-transcript?session="]').click();
  dialog = page.getByRole('dialog', { name: 'Earlier session', exact: true });
  await expect(dialog).toContainText('Session usage is recorded.'); await shot(page, 'coordinator-earlier-session', false);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  const message = await page.request.post(`${PROJECT}/threads/${thread.threadId}/messages`, { data: { schema: 'thread-message-request-v1', clientMessageId: randomUUID(), text: 'Continue with the pending answer.', interrupt: false } });
  expect(message.ok()).toBe(true);
  await expect.poll(async () => (await threadView(page, thread.threadId)).sessionHistory?.length, LONG).toBe(1);
  await page.goto(`/projects/projects_fixture/threads/${thread.threadId}`);
  await page.getByText('Earlier sessions (1)', { exact: true }).click();
  await page.locator(`a[href*="/threads/${thread.threadId}?session="]`).click();
  dialog = page.getByRole('dialog', { name: 'Earlier session', exact: true });
  await expect(dialog).toContainText('Session usage is recorded.'); await shot(page, 'thread-earlier-session', false);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  expect(errors).toEqual([]);
});

test('PJ replay loads history once without historical working states and keeps live events', async ({ page }, info) => {
  const errors = await begin(page);
  const original = await work(page);
  await page.context().route(`**${PROJECT}/work`, route => route.fulfill({ json: {
    ...original, lastEventId: 6, coordinator: { ...original.coordinator, state: 'idle' },
  } }));
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const streams: Array<EventTarget & { url: string; readyState: number; onerror?: () => void }> = [];
    Object.defineProperty(window, '__replayStreams', { value: streams });
    Object.defineProperty(window, 'EventSource', { value: function (url: string, options?: EventSourceInit) {
      if (!url.includes('/coordinator/events')) return new Native(url, options);
      const stream = Object.assign(new EventTarget(), { url, readyState: 1, close() { this.readyState = 2; } });
      streams.push(stream); return stream;
    } });
    for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSED: 2 })) Object.defineProperty(window.EventSource, name, { value });
  });
  const deliver = async (id: number, type: string, data: unknown) => {
    const frame = ProjectEventFrameSchema.parse({ schema: 'project-event-v1', event: {
      schema: 'project-ledger-event-v1', id, type, t: new Date().toISOString(), data,
    } });
    await page.evaluate(value => {
      const streams = (window as unknown as { __replayStreams: EventTarget[] }).__replayStreams;
      streams.at(-1)!.dispatchEvent(new MessageEvent('project', { data: JSON.stringify(value) }));
    }, frame);
  };
  const start = (turn: number) => ({ schema: 'coordinator-turn-v1', turn, fresh: false, runtime: 'claude',
    modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', eventIds: [] });
  const end = (turn: number) => ({ schema: 'coordinator-turn-end-v1', turn, status: 'completed' });
  const text = (value: string) => ({ schema: 'coordinator-text-v1', text: value });
  await page.goto('/projects/projects_fixture');
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Idle');
  await deliver(1, 'coordinator-turn-start', start(1));
  await deliver(2, 'coordinator-text', text('First historical reply.'));
  await deliver(3, 'coordinator-turn-end', end(1));
  await expect(page.getByText('Loading chat…', { exact: true })).toBeVisible();
  await expect(page.locator('.pw-timeline')).toHaveCount(0);
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Idle');
  // A refused connection resumes the partial replay from its accepted cursor, without showing it in pieces.
  await page.evaluate(() => {
    const source = (window as unknown as { __replayStreams: Array<{ readyState: number; onerror(): void }> }).__replayStreams.at(-1)!;
    source.readyState = 2; source.onerror();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __replayStreams: Array<{ url: string }> }).__replayStreams.at(-1)!.url)).toContain('after=3');
  await page.evaluate(() => {
    const old = (window as unknown as { __replayStreams: EventTarget[] }).__replayStreams[0]!;
    old.dispatchEvent(new MessageEvent('project', { data: JSON.stringify({ schema: 'project-event-v1', event: {
      schema: 'project-ledger-event-v1', id: 99, t: new Date().toISOString(), type: 'coordinator-text',
      data: { schema: 'coordinator-text-v1', text: 'Stale connection reply.' },
    } }) }));
  });
  await deliver(4, 'coordinator-turn-start', start(2));
  await deliver(5, 'coordinator-text', text('Latest historical reply.'));
  await expect(page.getByText('Loading chat…', { exact: true })).toBeVisible();
  await expect(page.locator('.pw-timeline')).toHaveCount(0);
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Idle');
  await deliver(6, 'coordinator-turn-end', end(2));
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0);
  await expect(page.locator('.pw-timeline')).toContainText('First historical reply.');
  await expect(page.locator('.pw-timeline')).toContainText('Latest historical reply.');
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Idle');
  await deliver(7, 'coordinator-turn-start', start(3));
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Working…');
  await deliver(8, 'coordinator-text', text('New live reply.'));
  await deliver(9, 'coordinator-turn-end', end(3));
  await expect(page.locator('.pw-coordinator .chip')).toHaveText('Idle');
  await expect(page.locator('.pw-timeline')).toContainText('New live reply.');
  await page.screenshot({ path: `test-results/project-replay-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});

test('PAR1 project settings save, conflict, pause and archive', async ({ page }, info) => {
  const errors = await begin(page);
  const original = (await work(page)).settings;
  const restore = async () => {
    const current = (await work(page)).settings;
    const { schema: _schema, projectId: _project, revision: _revision, ...settings } = original; void _schema; void _project; void _revision;
    const response = await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision: current.revision, settings } });
    expect(response.ok()).toBe(true);
    await page.request.delete(`${PROJECT}/env-secrets/PARITY_TOKEN`, { data: { schema: 'empty-request-v1' } });
  };
  try {
    await page.goto('/projects/projects_fixture');
    let settings = await openSettings(page);
    await expect(settings.getByRole('navigation', { name: 'Project settings sections' })).toBeVisible();
    const configuration = await (await page.request.get(`${PROJECT}/config`)).json();
    const freshReply = page.waitForResponse(response => response.url().endsWith(`${PROJECT}/coordinator/fresh`) && response.request().method() === 'POST');
    await settings.getByRole('button', { name: 'Fresh coordinator session', exact: true }).click();
    expect((await freshReply).status()).toBe(202);
    await expect(page.getByText('The next coordinator turn starts a fresh session.', { exact: true })).toBeVisible();
    await expect(settings.getByRole('alert')).toHaveCount(0);
    const coordinator = await (await page.request.get(`${PROJECT}/coordinator/editor`)).json();
    const coordinatorModel = coordinator.models.find((model: { value: string; disabled: boolean }) => model.value && !model.disabled);
    expect(coordinatorModel).toBeDefined();
    await settings.getByLabel('Coordinator model', { exact: true }).selectOption(coordinatorModel.value);
    await settings.getByLabel('Coordinator effort', { exact: true }).selectOption('low');
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(settings.getByLabel('Project instructions', { exact: true })).toHaveAttribute('maxlength', String(configuration.configuration.instructions.maxLength));
    await expect(settings.getByLabel('Guidance for Jev', { exact: true })).toHaveAttribute('maxlength', String(configuration.configuration.guidance.maxLength));
    await expect(settings).toContainText(configuration.configuration.pauseHelp);
    await expect(settings).toContainText(configuration.configuration.archiveHelp);
    await expect(settings).toContainText(configuration.configuration.dailyThreadHelp);
    await settings.getByLabel('Project instructions', { exact: true }).fill('Keep changes small and explain the result.');
    await expect(settings).toContainText('42 / 16,000');
    await settings.getByLabel('Guidance for Jev', { exact: true }).fill('Choose a careful model for UI work.');
    const placement = settings.locator('#project-settings-placement');
    const placementEditor = await (await page.request.get(`${PROJECT}/config/placement-editor`)).json();
    await placement.getByLabel('All enabled models', { exact: true }).uncheck();
    const placementModel = placement.getByRole('checkbox', { name: placementEditor.models[placementEditor.models.length - 1].label, exact: true });
    await placementModel.uncheck(); await placementModel.check();
    await placement.getByLabel('Lowest effort for threads', { exact: true }).selectOption('high');
    await settings.getByLabel('New threads per day', { exact: true }).fill('17');
    const controls = (await (await page.request.get(`${PROJECT}/config/editor`)).json()).controls;
    for (const [key, field] of Object.entries(controls.numbers) as Array<[string, { label: string; min: number; max: number; step: number }]>) {
      if (key === 'perDeviceLimit') continue;
      const input = settings.getByLabel(field.label, { exact: true });
      await expect(input).toHaveAttribute('min', String(field.min)); await expect(input).toHaveAttribute('max', String(field.max)); await expect(input).toHaveAttribute('step', String(field.step));
    }
    const limitDevice = controls.devices[0];
    await settings.getByLabel(limitDevice.label, { exact: true }).fill('2');
    await settings.getByLabel('Turn limit per thread', { exact: true }).fill('41');
    await settings.getByLabel('Propose threads and wait for me', { exact: true }).check();
    await settings.getByLabel('Fix failing checks automatically', { exact: true }).uncheck();
    await settings.getByLabel('Automatic fixes per pull request', { exact: true }).fill('4');
    await settings.getByLabel('Risky areas', { exact: true }).fill('Fixture-sensitive paths.');
    const environmentRoute = `**${PROJECT}/config/environment-editor`; let passwordInPreview = false;
    await page.route(environmentRoute, async route => { if (route.request().method() === 'POST' && (route.request().postData() ?? '').includes('fixture-private-environment-value')) passwordInPreview = true; await route.continue(); });
    await expect(settings.getByLabel('Worktree setup command', { exact: true })).toHaveAttribute('maxlength', '500');
    await settings.getByLabel('Worktree setup command', { exact: true }).fill('  ');
    await settings.getByLabel('Copy these untracked files into new worktrees', { exact: true }).fill(' .env.local \n\n config/local \n');
    await expect(settings.getByLabel('Copy these untracked files into new worktrees', { exact: true })).toHaveValue(' .env.local \n\n config/local \n');
    await settings.getByRole('button', { name: 'Add variable', exact: true }).click();
    await settings.getByLabel('Variable 1 name', { exact: true }).fill('PARITY_DATA');
    await settings.getByLabel('Variable 1 value', { exact: true }).fill('/tmp/parity-data');
    await settings.getByRole('button', { name: 'Add secret', exact: true }).click();
    await settings.getByLabel('Secret 1 name', { exact: true }).fill('PARITY_TOKEN');
    await settings.getByLabel('Secret 1 value', { exact: true }).fill('fixture-private-environment-value');
    await settings.getByRole('button', { name: 'Add landing check', exact: true }).click();
    const check = settings.getByRole('group', { name: 'Check 1', exact: true });
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await check.getByLabel('Name', { exact: true }).fill('Fixture landing check');
    await check.getByLabel('Paths', { exact: true }).fill('src\n\n spaced path \n');
    await check.getByLabel('Command', { exact: true }).fill('true');
    const notificationSection = settings.locator('#project-settings-notifications');
    const notificationInfo = (await (await page.request.get(`${PROJECT}/config/editor`)).json()).notificationInfo;
    for (const level of notificationInfo.levels) await expect(notificationSection.getByRole('radio', { name: level.label, exact: true })).toBeVisible();
    await notificationSection.getByRole('radio', { name: 'Only what needs me', exact: true }).check();
    await notificationSection.getByRole('checkbox', { name: 'Quiet hours', exact: true }).check();
    await notificationSection.getByLabel('Quiet hours start', { exact: true }).fill('22:30');
    await notificationSection.getByLabel('Quiet hours end', { exact: true }).fill('07:30');
    await expect(notificationSection.getByLabel('Quiet hours timezone', { exact: true })).toHaveAttribute('maxlength', String(notificationInfo.quietHours.timezoneMaxLength));
    await expect(notificationSection).toContainText(notificationInfo.quietHours.help);
    await settings.getByLabel('Keep commits for these paths', { exact: true }).fill('docs\n\n notes \n');
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(check.getByLabel('Paths', { exact: true })).toHaveValue('src\n\n spaced path \n');
    let settingsWrites = 0;
    const settingsRoute = `**${PROJECT}/config/editor`, landingRoute = `**${PROJECT}/config/landing-editor`;
    await page.route(settingsRoute, async route => { if (route.request().method() === 'POST') settingsWrites++; await route.continue(); });
    let releasePreview!: () => void, previewStarted!: () => void;
    const release = new Promise<void>(resolve => { releasePreview = resolve; }), started = new Promise<void>(resolve => { previewStarted = resolve; });
    await page.route(landingRoute, async route => { previewStarted(); await release; await route.continue(); });
    try {
      await settings.getByLabel('Smoke check', { exact: true }).fill('true'); await started;
      await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await settings.locator('form.pw-settings').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    } finally { releasePreview(); }
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await page.unroute(landingRoute); expect(settingsWrites).toBe(0);
    await settings.locator('form.pw-settings').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect(page).toHaveURL(/\/projects\/projects_fixture$/);
    expect(settingsWrites).toBe(1); await page.unroute(settingsRoute);
    expect(passwordInPreview, 'Password values use only the normal vault writer.').toBe(false); await page.unroute(environmentRoute);
    await expect.poll(async () => (await work(page)).settings.maxNewThreadsPerDay).toBe(17);
    expect((await work(page)).settings).toMatchObject({ landingChecks: [{ name: 'Fixture landing check', paths: ['src', ' spaced path '], command: 'true' }], smokeCheck: 'true', mergeCommitPaths: ['docs', ' notes '] });
    expect((await work(page)).settings).toMatchObject({ threadTurnCap: 41, startMode: 'propose', perDeviceLimits: { [limitDevice.id]: 2 }, prAutoFix: { checks: false, maxRounds: 4 }, riskyAreas: 'Fixture-sensitive paths.' });
    expect((await work(page)).settings.coordinator).toMatchObject({ modelId: coordinatorModel.value, effort: 'low' });
    expect((await work(page)).settings.placement).toEqual({ allowedModelIds: placementEditor.restrictedModelIds, minEffort: 'high', guidance: 'Choose a careful model for UI work.' });
    expect((await work(page)).settings).toMatchObject({ setupCommand: '  ', environment: { copyFiles: ['.env.local', 'config/local'] } });
    expect((await work(page)).settings.notifications).toMatchObject({ level: 'needs-you', quietHours: { enabled: true, start: '22:30', end: '07:30', timezone: 'Europe/Lisbon' } });
    settings = await openSettings(page);
    await expect(settings.getByLabel('Project instructions', { exact: true })).toHaveValue('Keep changes small and explain the result.');
    await expect(settings.getByLabel('Secret 1 value', { exact: true })).toHaveValue('');
    await expect(settings).toContainText('Saved · updated');
    await page.screenshot({ path: `test-results/PAR1-settings-${layout(info)}.png`, fullPage: true });
    // A real revision conflict from another owner request keeps the local draft until Reload.
    const current = (await work(page)).settings;
    const { schema: _schema, projectId: _project, revision, ...changed } = current; void _schema; void _project;
    expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...changed, maxRunningThreads: 13 } } })).ok()).toBe(true);
    await settings.getByLabel('Max running threads', { exact: true }).fill('2');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('These settings changed elsewhere. Reload to see them.');
    await page.screenshot({ path: `test-results/PAR1-conflict-${layout(info)}.png`, fullPage: true });
    await settings.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(settings.getByLabel('Max running threads', { exact: true })).toHaveValue('13');
    await settings.getByLabel('Smoke check', { exact: true }).fill('echo unsaved draft');
    await settings.getByLabel('Coordinator effort', { exact: true }).selectOption('max');
    await settings.getByLabel('Guidance for Jev', { exact: true }).fill('Unsaved placement guidance.');
    await settings.getByLabel('Copy these untracked files into new worktrees', { exact: true }).fill(' raw local path \n\n');
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await settings.getByRole('button', { name: 'Paused', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Paused', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(settings.getByLabel('Smoke check', { exact: true })).toHaveValue('echo unsaved draft');
    await expect(settings.getByLabel('Coordinator effort', { exact: true })).toHaveValue('max');
    expect((await work(page)).settings.coordinator.effort).toBe('low');
    await expect(settings.getByLabel('Guidance for Jev', { exact: true })).toHaveValue('Unsaved placement guidance.');
    expect((await work(page)).settings.placement.guidance).toBe('Choose a careful model for UI work.');
    await expect(settings.getByLabel('Copy these untracked files into new worktrees', { exact: true })).toHaveValue(' raw local path \n\n');
    expect((await work(page)).settings.environment.copyFiles).toEqual(['.env.local', 'config/local']);
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('This project is paused. Nothing new starts until you resume it.', { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/PAR1-paused-${layout(info)}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByText('This project is paused. Nothing new starts until you resume it.', { exact: true })).toHaveCount(0);
    settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(settings.getByRole('button', { name: 'Archived', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('This project is archived. Nothing runs and it is hidden from the sidebar.', { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/PAR1-archived-${layout(info)}.png`, fullPage: true });
    const sidebar = await projectsSection(page);
    await expect(sidebar.locator('.pw-sidebar-list').getByRole('button', { name: /^Projects fixture/ })).toHaveCount(0);
    await expect(sidebar.locator('.pw-archived-projects')).toHaveJSProperty('open', false);
    await expect(sidebar.getByText('Archived (1)', { exact: true })).toBeVisible();
    await sidebar.locator('.pw-archived-projects > summary').click();
    await expect(sidebar.locator('.pw-archived-projects').getByRole('button', { name: 'Projects fixture', exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/PAR1-archived-sidebar-${layout(info)}.png`, fullPage: false });
    await closeDrawer(page, info);
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(page.getByText('This project is paused. Nothing new starts until you resume it.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(async () => (await work(page)).settings.status).toBe('active');
    expect(errors).toEqual([]);
  } finally { await restore(); }
});

test('PAR2 live cards, proposed starts, follow-ups and settings Undo', async ({ page }, info) => {
  const errors = await begin(page), original = (await work(page)).settings;
  const save = async (patch: Partial<typeof original>) => {
    const current = (await work(page)).settings;
    const { schema: _schema, projectId: _id, revision, ...settings } = current; void _schema; void _id;
    const response = await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, ...patch } } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const send = async (text: string) => { await composer(page).fill(text); await composer(page).press('Enter'); };
  try {
    await save({ startMode: 'propose', maxRunningThreads: 20, maxRunningPerDevice: 10 });
    await page.goto('/projects/projects_fixture');
    if (phone(info)) await tab(page, 'Chat').click();
    await send('PAR2 propose two small tasks');
    const cards = page.locator('.pw-timeline .pw-thread-card');
    const first = cards.filter({ hasText: 'PAR2 first small task' }), second = cards.filter({ hasText: 'PAR2 second small task' });
    await expect(first).toContainText('Proposed', LONG); await expect(second).toContainText('Proposed');
    await expect(page.locator('.pw-timeline').getByRole('button', { name: 'Start all (2)', exact: true })).toBeVisible();
    let tasks = TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks.filter(task => task.title.startsWith('PAR2 '));
    expect(tasks).toHaveLength(2); expect(tasks.every(task => task.state === 'draft' && task.threadId === null)).toBe(true);
    await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/${process.env.JEVELLAN_PARITY_PHASE ?? 'phase-2'}/screenshots/PAR2-proposals-${layout(info)}.png`, fullPage: false });
    await first.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(first.locator('.pw-card-meta')).toBeVisible(LONG);
    await expect(page.locator('.pw-timeline').getByRole('button', { name: 'Start all (1)', exact: true })).toBeVisible();
    await page.locator('.pw-timeline').getByRole('button', { name: 'Start all (1)', exact: true }).click();
    await expect(second.locator('.pw-card-meta')).toBeVisible(LONG);
    await expect(page.locator('.pw-timeline').getByRole('button', { name: /^Start all/ })).toHaveCount(0);
    tasks = TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks.filter(task => task.title.startsWith('PAR2 '));
    expect(tasks.every(task => task.threadId !== null)).toBe(true);
    await send('PAR2 follow up with the first small task');
    const sent = page.locator('.pw-chat-work-cards').filter({ hasText: 'Sent a message' });
    await expect(sent).toContainText('PAR2 first small task', LONG);
    await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/${process.env.JEVELLAN_PARITY_PHASE ?? 'phase-2'}/screenshots/PAR2-live-cards-${layout(info)}.png`, fullPage: false });
    await send('PAR2 two at a time');
    const setting = page.locator('.pw-chat-setting').filter({ hasText: 'Changed max running threads from 20 to 2.' });
    await expect(setting).toBeVisible(LONG); expect((await work(page)).settings.maxRunningThreads).toBe(2);
    await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/${process.env.JEVELLAN_PARITY_PHASE ?? 'phase-2'}/screenshots/PAR2-settings-undo-${layout(info)}.png`, fullPage: false });
    await setting.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await work(page)).settings.maxRunningThreads, LONG).toBe(20);
    await expect(setting.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    const tasks = TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks.filter(task => task.title.startsWith('PAR2 '));
    for (const task of tasks) {
      if (task.threadId) {
        const stopped = await page.request.post(`${PROJECT}/threads/${task.threadId}/stop`, { data: { schema: 'thread-stop-request-v1', reason: 'Browser journey complete.' }, timeout: LONG.timeout });
        expect(stopped.ok(), await stopped.text()).toBe(true);
      }
      else if (['draft', 'queued'].includes(task.state)) await page.request.post(`${PROJECT}/tasks/${task.id}/action`, { data: { schema: 'task-action-request-v1', expectedRevision: task.revision, action: 'cancel' } });
    }
    const { schema: _schema, projectId: _id, revision: _revision, ...restore } = original; void _schema; void _id; void _revision;
    await save(restore);
  }
});


test('PAR3 Overview groups, owner actions and saved-work publication', async ({ page }, info) => {
  const errors = await begin(page);
  await page.goto('about:blank');
  const prepared = await control('/projects/overview', { schema: 'fixture-overview-v1', action: 'prepare' }) as { threadId: string; publishThreadId: string };
  await page.goto('/projects/projects_fixture'); await expect(page.getByRole('heading', { name: 'Projects fixture', exact: true })).toBeVisible(LONG); await sectionTab(page, info, 'Threads');
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0, LONG);
  const overview = page.getByRole('tablist', { name: 'Overview', exact: true });
  await expect(overview.getByRole('tab')).toHaveText(['Threads', 'Pull requests', 'Queue', 'Routines', 'Library']);
  for (const group of ['Waiting for you', 'Ready for review', 'Working', 'Landing', 'Idle', 'Resolved']) await expect(region(page, group)).toBeVisible();
  await expect(region(page, 'Working')).toContainText('In a terminal');
  const dotColor = (group: string) => region(page, group).locator('.pw-card-dot').first().evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await dotColor('Ready for review')).not.toBe(await dotColor('Working'));
  expect(await dotColor('Waiting for you')).not.toBe(await dotColor('Working'));
  for (const label of ['Verifying', 'Merging', 'Held for the nightly window']) await expect(region(page, 'Landing')).toContainText(label);
  const review = region(page, 'Ready for review');
  for (const label of ['Fix checks', 'Resolve conflicts', 'Address comments (2)', 'Open on GitHub']) await expect(review.getByRole('button', { name: label, exact: true }).or(review.getByRole('link', { name: label, exact: true }))).toBeVisible();
  await expect(review.getByRole('button', { name: 'Resolve', exact: true })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-3/screenshots/PAR3-overview-${layout(info)}.png`, fullPage: false });
  await expect(region(page, 'Resolved')).not.toContainText('PAR3 older'); await region(page, 'Resolved').getByRole('button', { name: 'Show older', exact: true }).click();
  await expect(region(page, 'Resolved')).toContainText('PAR3 older');
  const card = page.locator(`.pw-side [data-thread-id="${prepared.threadId}"]`);
  await card.getByRole('button', { name: 'Resolve', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('This thread has commits that are not in a pull request. Resolve it anyway? The branch and worktree stay.');
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-3/screenshots/PAR3-resolve-confirmation-${layout(info)}.png`, fullPage: false });
  await dialog.getByRole('button', { name: 'Resolve', exact: true }).click(); await expect(region(page, 'Resolved')).toContainText('PAR3 saved work');
  await card.getByRole('button', { name: 'Reopen', exact: true }).click(); await expect(region(page, 'Idle')).toContainText('PAR3 saved work');
  await page.locator(`.pw-side [data-thread-id="${prepared.publishThreadId}"]`).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect.poll(async () => (await work(page)).threads.find(thread => thread.id === prepared.publishThreadId)?.pr?.state, LONG).toBe('open');
  await expect(region(page, 'Ready for review')).toContainText('PAR3 publish work');
  await page.goto('about:blank');
  await control('/projects/merge-hold', { schema: 'fixture-merge-hold-v1', held: true });
  await page.goto('/projects/projects_fixture'); await expect(page.getByRole('heading', { name: 'Projects fixture', exact: true })).toBeVisible(LONG); await sectionTab(page, info, 'Threads');
  const heldMerge = page.locator(`.pw-side [data-thread-id="${prepared.publishThreadId}"]`).getByRole('button', { name: 'Merge', exact: true });
  await expect(heldMerge).toBeDisabled(); await expect(heldMerge).toHaveAttribute('title', 'Merges are held while the nightly window runs.');
  await control('/projects/merge-hold', { schema: 'fixture-merge-hold-v1', held: false });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Projects fixture', exact: true })).toBeVisible(LONG); await sectionTab(page, info, 'Threads'); await expect(heldMerge).toBeEnabled();

  await sectionTab(page, info, 'Routines'); await expect(region(page, 'Nightly')).toBeVisible(); await expect(region(page, 'Goals')).toBeVisible();
  await sectionTab(page, info, 'Queue'); await expect(region(page, 'Queue')).toBeVisible();
  await sectionTab(page, info, 'Threads');
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0, LONG);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-3/screenshots/PAR3-published-${layout(info)}.png`, fullPage: false });
  await card.getByRole('link', { name: 'PAR3 saved work', exact: true }).click(); await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-3/screenshots/PAR3-thread-actions-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});


test('PAR3 header action rows stay separate on narrow screens', async ({ page }, info) => {
  const errors = await begin(page); await openProject(page, 'Projects placement'); await sectionTab(page, info, 'Threads');
  await region(page, 'Idle').getByRole('link', { name: 'Tidy the README wording', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toBeVisible();
  const overlaps = await page.locator('.pw-thread-heading button').evaluateAll(buttons => {
    const boxes = buttons.filter(button => button.getBoundingClientRect().width > 0).map(button => ({ name: button.getAttribute('aria-label') ?? button.textContent?.trim(), box: button.getBoundingClientRect() }));
    return boxes.flatMap((a, index) => boxes.slice(index + 1).filter(b => Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1).map(b => [a.name, b.name]));
  });
  expect(overlaps).toEqual([]);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-3/screenshots/PAR3-header-actions-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});

test('PAR4 automatic fix labels, round limit and an owner-requested fix', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('about:blank');
  const prepared = await control('/projects/automatic-fix', { schema: 'fixture-automatic-fix-v1', action: 'prepare' }) as { threadId: string; prNumber: number };
  const project = '/api/projects/projects_autofix', path = '/projects/projects_autofix';
  // Someone else pushes to the pull request first: the automatic fix starts from its head and says so (fix-051).
  await control('/projects/automatic-fix', { schema: 'fixture-automatic-fix-v1', action: 'owner-commit' });
  await control('/projects/automatic-fix', { schema: 'fixture-automatic-fix-v1', action: 'fail' });
  await page.goto(path); await expect(page.getByRole('heading', { name: 'Projects automatic fixes', exact: true })).toBeVisible(LONG);
  await sectionTab(page, info, 'Threads');
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0, LONG);
  const waiting = region(page, 'Waiting for you');
  await expect(waiting).toContainText(`Pull request #${prepared.prNumber} still has failing checks after 1 automatic fixes.`, LONG);
  await expect(waiting.getByRole('button', { name: 'Allow 1 more automatic fixes', exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-4/screenshots/PAR4-limit-${layout(info)}.png`, fullPage: false });
  await waiting.getByRole('button', { name: 'Leave it to me', exact: true }).click();
  await page.goto(`${path}/threads/${prepared.threadId}`);
  await expect(page.getByText('Automatic fix: failing checks', { exact: true })).toHaveCount(2, LONG);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-4/screenshots/PAR4-automatic-${layout(info)}.png`, fullPage: false });
  await sessionDetails(page);
  const sessionNotices = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Session notices' }) });
  if (await sessionNotices.getAttribute('open') === null) await sessionNotices.locator('summary').click();
  const updated = page.getByText(new RegExp(`Updated the worktree to pull request #${prepared.prNumber}'s head [0-9a-f]{7} before this fix\\.$`, 'u'));
  await expect(updated).toBeVisible(LONG); await updated.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/acceptance/fix-051-2026-10/screenshots/PAR4-head-updated-${layout(info)}.png`, fullPage: false });
  const session = page.getByRole('button', { name: 'Session information', exact: true });
  if (await session.getAttribute('aria-expanded') === 'true') await session.click();
  const previousHead = ThreadViewSchema.parse(await read(page, `${project}/threads/${prepared.threadId}`)).thread.pr!.headSha;
  await page.getByRole('button', { name: 'Fix checks', exact: true }).click();
  await expect(page.getByText('Requested by you', { exact: true })).toHaveCount(2, LONG);
  await expect.poll(async () => {
    const thread = ThreadViewSchema.parse(await read(page, `${project}/threads/${prepared.threadId}`)).thread;
    return thread.state === 'in-review' && thread.pr?.checks === 'passing' && thread.pr.headSha !== previousHead;
  }, LONG).toBe(true);
  await expect(page.getByText('In review', { exact: true })).toBeVisible(LONG);
  const view = ThreadViewSchema.parse(await read(page, `${project}/threads/${prepared.threadId}`));
  expect(view.thread.turns).toBe(3); expect(view.thread.pr?.number).toBe(prepared.prNumber);
  expect(view.reports.at(-1)?.fix).toEqual({ by: 'owner', kind: 'checks' });
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-4/screenshots/PAR4-owner-request-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});

test('PAR4 reconnect page recovers after a transient hub navigation failure', async ({ page }, info) => {
  const errors = await begin(page), context = page.context();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), LONG).toBe(true);
  let injected = false, healthSeen = false, release!: () => void;
  const recovered = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/api/health', async route => { healthSeen = true; await recovered; await route.continue(); });
  await context.route('**/projects/projects_fixture', async route => {
    if (!injected && route.request().serviceWorker()) { injected = true; await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Temporarily busy' }); }
    else await route.continue();
  });
  try {
    await page.goto('/projects/projects_fixture');
    await expect(page.getByRole('heading', { name: 'Let’s reconnect.', exact: true })).toBeVisible(LONG);
    await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-4/screenshots/PAR4-reconnect-${layout(info)}.png`, fullPage: false });
    release();
    await expect(page.getByRole('heading', { name: 'Projects fixture', exact: true })).toBeVisible(LONG);
    expect(injected).toBe(true); expect(healthSeen).toBe(true);
    await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0, LONG);
    await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-4/screenshots/PAR4-recovered-${layout(info)}.png`, fullPage: false });
  } finally { release(); await context.unrouteAll({ behavior: 'wait' }); }
  expect(errors).toEqual([]);
});

test('PAR5 usage, account waiting notice and placement constraints', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('about:blank');
  const prepared = await control('/projects/usage', { schema: 'fixture-usage-v1', action: 'prepare' }) as { threadId: string };
  const path = '/projects/projects_usage';
  await page.goto(`${path}/settings`); await expect(page.getByRole('heading', { name: 'Project settings', exact: true })).toBeVisible(LONG);
  const usage = page.locator('#project-settings-usage'); await usage.scrollIntoViewIfNeeded();
  await expect(usage).toContainText('1,200', LONG); await expect(usage).toContainText('$0.12');
  await expect(usage.getByRole('heading', { name: 'By account', exact: true })).toBeVisible();
  await usage.getByRole('button', { name: '7 days', exact: true }).click(); await expect(usage).toContainText('1,200', LONG);
  // Numbers never wrap inside a cell and every table fits its box, so no figure is cut on a phone.
  const layoutFacts = await usage.locator('.pw-usage-table').evaluateAll(boxes => boxes.map(box => {
    const table = box.querySelector('table')!, cells = [...table.querySelectorAll('tbody td:nth-last-child(-n+3)')];
    // Adjacent text fragments share a line; distinct line tops mean the figure wrapped.
    const wrapped = cells.filter(cell => { const range = document.createRange(); range.selectNodeContents(cell); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size > 1; }).map(cell => cell.textContent);
    return { tableWidth: table.scrollWidth, boxWidth: box.clientWidth, wrapped };
  }));
  for (const facts of layoutFacts) { expect(facts.wrapped, JSON.stringify(facts)).toEqual([]); expect(facts.tableWidth, JSON.stringify(facts)).toBeLessThanOrEqual(facts.boxWidth); }
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-5/screenshots/PAR5-usage-${layout(info)}.png`, fullPage: false });
  await page.goto(`${path}/threads/${prepared.threadId}`); await expect(page.getByRole('heading', { name: 'A narrow parsing test', exact: true })).toBeVisible(LONG);
  await expect(page.getByText(/Waiting for an account for Fable:/u)).toBeVisible(LONG);
  await expect(page.getByText(/1.5k tokens · \$0.12/iu)).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-5/screenshots/PAR5-wait-${layout(info)}.png`, fullPage: false });
  await sessionDetails(page); await page.locator('summary').filter({ hasText: 'Session notices' }).click();
  await expect(page.getByText('The turn stopped at a usage limit on Projects Claude. Waiting for an account.', { exact: false })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-5/screenshots/PAR5-recovery-${layout(info)}.png`, fullPage: false });
  await page.getByRole('button', { name: 'Why', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Why this placement' });
  await expect(panel).toContainText('Project placement constraints: Claude Code Fable · Lowest effort: high'); await expect(panel).toContainText('Placement reason: escalation');
  await expect(panel.getByRole('heading', { name: 'Escalation history', exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-5/screenshots/PAR5-why-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});

test('PAR6 Notifications subscribe, receive a browser push, suppress the focused path and turn off', async ({ page, context }, info) => {
  await context.grantPermissions(['notifications']);
  // The network subscription is simulated; the service worker and CDP push delivery are the real browser implementation.
  await page.addInitScript(() => {
    const stored = () => { try { return localStorage.getItem('par6-push') === 'on'; } catch { return false; } };
    const subscription = () => ({ endpoint: 'https://push.example/par6-browser', toJSON: () => ({ endpoint: 'https://push.example/par6-browser', keys: { p256dh: 'simulated_browser_public_key', auth: 'simulated_browser_auth' } }), unsubscribe: async () => { try { localStorage.removeItem('par6-push'); } catch { /* Disposable browser storage can be refused. */ } return true; } });
    Object.defineProperty(PushManager.prototype, 'getSubscription', { configurable: true, value: async () => stored() ? subscription() : null });
    Object.defineProperty(PushManager.prototype, 'subscribe', { configurable: true, value: async () => { try { localStorage.setItem('par6-push', 'on'); } catch { /* Refused storage is tested separately. */ } return subscription(); } });
  });
  const errors = await begin(page); await page.goto('/settings/notifications');
  await expect(page.getByText('Off for this device.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on for this device', exact: true })).toBeEnabled();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-6/screenshots/PAR6-off-${layout(info)}.png` });
  await page.getByRole('button', { name: 'Turn on for this device', exact: true }).click();
  await expect(page.getByText('On for this device.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Devices with notifications' })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test notification', exact: true }).click();
  const receipt = await control('/projects/notifications', { schema: 'fixture-notifications-v1', action: 'sweep' }) as { sent: Array<{ body: string }> };
  expect(receipt.sent.some(item => item.body === 'Notifications work on this device.')).toBe(true);
  const cdp = await context.newCDPSession(page); let registrationId: string | undefined;
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => { registrationId ??= event.registrations.find((registration: { scopeURL: string }) => registration.scopeURL === `${info.project.use.baseURL}/`)?.registrationId; });
  await cdp.send('ServiceWorker.enable'); await expect.poll(() => registrationId, LONG).toBeTruthy();
  await expect.poll(() => context.serviceWorkers().length, LONG).toBeGreaterThan(0);
  const serviceWorker = context.serviceWorkers().find(worker => worker.url().endsWith('/sw.js'))!;
  await serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as { ExtendableEvent: { prototype: { waitUntil(work: Promise<unknown>): void } }; par6Settled?: number };
    const original = scope.ExtendableEvent.prototype.waitUntil;
    scope.ExtendableEvent.prototype.waitUntil = function (this: { type: string }, work: Promise<unknown>) {
      return original.call(this, this.type === 'push' ? work.finally(() => { scope.par6Settled = (scope.par6Settled ?? 0) + 1; }) : work);
    };
  });
  const push = { schema: 'project-push-v1', title: 'Projects fixture: question', body: 'Which screenshot should we keep?', url: '/projects/projects_fixture?view=overview', tag: 'par6-question' };
  await control('/projects/notifications', { schema: 'fixture-notifications-v1', action: 'question' });
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: info.project.use.baseURL!, registrationId: registrationId!, data: JSON.stringify(push) });
  await expect.poll(() => serviceWorker.evaluate(() => (globalThis as unknown as { par6Settled?: number }).par6Settled ?? 0), LONG).toBe(1);
  await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(notification => notification.body)), LONG).toContain(push.body);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-6/screenshots/PAR6-on-${layout(info)}.png` });
  await page.goto('/projects/projects_fixture'); await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus()), LONG).toBe(true);
  await page.evaluate(async () => { for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close(); });
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: info.project.use.baseURL!, registrationId: registrationId!, data: JSON.stringify({ ...push, tag: 'par6-focused' }) });
  // Wait for the real handler's waitUntil promise, so an early empty list cannot falsely pass.
  await expect.poll(() => serviceWorker.evaluate(() => (globalThis as unknown as { par6Settled?: number }).par6Settled ?? 0), LONG).toBe(2);
  await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).filter(notification => notification.tag === 'par6-focused').length), LONG).toBe(0);
  await page.goto('/projects/projects_fixture/settings'); await expect(page.getByText('Turn on notifications for this device in Settings → Notifications.', { exact: true })).toHaveCount(0);
  await page.goto('/settings/notifications'); await page.getByRole('button', { name: 'Turn off for this device', exact: true }).click(); await expect(page.getByText('Off for this device.', { exact: true })).toBeVisible();
  await expect(page.getByText('No devices have notifications turned on.', { exact: true })).toBeVisible(); await cdp.detach(); expect(errors).toEqual([]);
});

test('Notifications editor main actions preserve the canonical subscription writer and device state', async ({ page, context }, info) => {
  await context.grantPermissions(['notifications'], { origin: info.project.use.baseURL! });
  // Only the push service subscription is simulated; native display remains the separate PAR6 check.
  await page.addInitScript(() => {
    const stored = () => localStorage.getItem('notification-editor-push') === 'on';
    const subscription = () => ({ endpoint: 'https://push.example/notification-editor-browser', toJSON: () => ({ keys: { p256dh: 'fixture_public_key', auth: 'fixture_auth' } }), unsubscribe: async () => { localStorage.removeItem('notification-editor-push'); return true; } });
    Object.defineProperty(PushManager.prototype, 'getSubscription', { configurable: true, value: async () => stored() ? subscription() : null });
    Object.defineProperty(PushManager.prototype, 'subscribe', { configurable: true, value: async () => { localStorage.setItem('notification-editor-push', 'on'); return subscription(); } });
  });
  const errors = await begin(page); await page.goto('/settings/notifications');
  await expect(page.getByText('Off for this device.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on for this device', exact: true }).click();
  await expect(page.getByText('On for this device.', { exact: true })).toBeVisible();
  const view = await (await page.request.get('/api/notifications/subscriptions')).json();
  expect(view.subscriptions).toHaveLength(1); await expect(page.getByText(view.subscriptions[0].label, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test notification', exact: true }).click();
  await expect(page.getByText('Test notification queued.', { exact: true })).toBeVisible();
  const receipt = await control('/projects/notifications', { schema: 'fixture-notifications-v1', action: 'sweep' }) as { sent: Array<{ body: string }> };
  expect(receipt.sent.some(item => item.body === 'Notifications work on this device.')).toBe(true);
  await page.screenshot({ path: `test-results/notification-editor-on-${layout(info)}.png` });
  await page.goto('/projects/projects_fixture/settings'); await expect(page.getByText('Turn on notifications for this device in Settings → Notifications.', { exact: true })).toHaveCount(0);
  await page.goto('/settings/notifications'); await page.getByRole('button', { name: 'Turn off for this device', exact: true }).click();
  await expect(page.getByText('Off for this device.', { exact: true })).toBeVisible();
  await expect(page.getByText('No devices have notifications turned on.', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notifications/subscriptions')).json()).subscriptions).toEqual([]);
  await page.screenshot({ path: `test-results/notification-editor-off-${layout(info)}.png` }); expect(errors).toEqual([]);
});

test('About renders the engine device version and maintenance text and opens the setup guide', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/about');
  const response = await page.request.get('/api/config/about'); expect(response.ok()).toBe(true); const view = await response.json();
  const devices = await (await page.request.get('/hub/devices')).json(); expect(view.currentDeviceId).toBe(devices.currentDeviceId);
  await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible();
  await expect(page.getByText(`Version ${view.currentVersion}`, { exact: true })).toBeVisible();
  await expect(page.locator('code').filter({ hasText: view.commands.update })).toHaveText(view.commands.update);
  await expect(page.locator('code').filter({ hasText: view.commands.uninstall })).toHaveText(view.commands.uninstall);
  await page.screenshot({ path: `test-results/ABOUT-device-${layout(info)}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Open setup guide', exact: true }).click(); await expect(page).toHaveURL(/\/setup$/); expect(errors).toEqual([]);
});

test('Endpoint login deep links open credential editing without starting a subscription login', async ({ page }, info) => {
  const errors = await begin(page);
  const response = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', kind: 'endpoint', label: 'Endpoint deep-link fixture', secret: 'fixture_endpoint_refused', clientRequestId: 'endpoint_deep_link_fixture', endpoint: { baseUrl: new URL('/anthropic', `http://127.0.0.1:${Number(new URL(info.project.use.baseURL!).port) + 200}`).href, billing: 'free', models: [{ id: 'deep-link', label: 'Deep link', efforts: ['medium'], description: 'Fixture model' }] } } }); expect(response.status()).toBe(201); const account = await response.json();
  let loginStarts = 0; page.on('request', request => { if (/\/api\/accounts\/[^/]+\/login$/.test(new URL(request.url()).pathname) && request.method() === 'POST') loginStarts++; });
  await page.goto(`/settings/runtimes?account=${account.account.id}&login=1`); const edit = page.getByRole('dialog', { name: 'Edit account', exact: true });
  await expect(edit).toBeVisible(); await expect(edit.getByLabel('Auth token', { exact: true })).toHaveValue(''); expect(loginStarts).toBe(0);
  await page.screenshot({ path: `test-results/LOGIN-endpoint-deep-link-${layout(info)}.png`, fullPage: true }); await edit.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(errors).toEqual([]);
});

test('Account editor creates and replaces API keys without sending credentials to readonly previews', async ({ page }, info) => {
  const errors = await begin(page), previews: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/accounts/editor/preview' && request.method() === 'POST') previews.push(request.postDataJSON() as Record<string, unknown>); });
  await page.goto('/settings/runtimes'); const runtime = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await runtime.getByRole('button', { name: 'Add account', exact: true }).click(); const form = page.getByRole('dialog', { name: 'Add account', exact: true });
  await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('api-key');
  await form.getByRole('textbox', { name: 'Label', exact: true }).fill('Account editor key fixture'); await form.getByLabel('API key', { exact: true }).fill('fixture-account-editor-key-one');
  await form.getByRole('combobox', { name: 'When may Jevellan use this key?', exact: true }).selectOption('never'); await form.getByRole('button', { name: 'Add account', exact: true }).click(); await expect(form).toHaveCount(0, LONG);
  const account = runtime.locator('.account').filter({ has: page.getByText('Account editor key fixture', { exact: true }) }); await expect(account).toContainText('••••-one', LONG);
  await expect(account.locator('.account-heading .status')).toHaveText('Paid use not allowed', LONG);
  await account.getByRole('button', { name: 'Replace key', exact: true }).click(); const replace = page.getByRole('dialog', { name: 'Replace API key', exact: true });
  await replace.getByLabel('New API key', { exact: true }).fill('fixture-account-editor-key-two'); await replace.getByRole('button', { name: 'Replace key', exact: true }).click(); await expect(replace).toHaveCount(0, LONG);
  await expect(account).toContainText('••••-two', LONG); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(previews.length).toBeGreaterThan(0); for (const request of previews) { expect(request).not.toHaveProperty('credential'); expect(request).not.toHaveProperty('secret'); expect(typeof request.credentialPresent).toBe('boolean'); }
  await page.screenshot({ path: `test-results/ACCTEDIT-key-replaced-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('Account edit accepts canonical fractional usage ceilings without changing the account kind', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/runtimes');
  const account = page.locator('.account').first(); await expect(account).toBeVisible();
  const id = (await account.getAttribute('id'))!.replace(/^account-/, ''), path = `/hub/accounts/${id}`;
  const before = await (await page.request.get(path)).json(), target = before.account.ceilingPct === 90.5 ? 91.5 : 90.5;
  await account.getByRole('button', { name: 'Edit', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Edit account', exact: true });
  await dialog.getByRole('spinbutton', { name: 'Usage ceiling (%)', exact: true }).fill(String(target)); await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(path)).json()).account.ceilingPct).toBe(target);
  await expect(dialog).toHaveCount(0); const after = await (await page.request.get(path)).json(); expect(after.account.kind).toBe(before.account.kind); expect(after.account.enabled).toBe(before.account.enabled); expect(after.account.label).toBe(before.account.label);
  await page.screenshot({ path: `test-results/ACCTEDIT-fractional-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('Runtime settings keep cache, own setup and enable writes scoped', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/runtimes');
  const before = await (await page.request.get('/hub/config')).json(), editor = await (await page.request.get('/api/config/runtimes')).json();
  const row = editor.rows.find((entry: { id: string }) => entry.id === 'claude'), runtime = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  const save = async (action: () => Promise<void>) => { const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/config/runtimes' && result.request().method() === 'PUT'); await action(); expect((await response).ok()).toBe(true); };
  const cache = runtime.getByRole('spinbutton', { name: row.cache.ariaLabel, exact: true }); await expect(cache).toHaveAttribute('min', String(row.cache.min)); await expect(cache).toHaveAttribute('max', String(row.cache.max));
  const target = row.cache.value < row.cache.max ? row.cache.value + 1 : row.cache.value - 1;
  await cache.fill(String(target)); await save(() => cache.blur());
  const toggle = async (control: Locator, checked: boolean) => { await save(() => control.click()); if (checked) await expect(control).toBeChecked(); else await expect(control).not.toBeChecked(); };
  const own = runtime.getByRole('checkbox', { name: row.ownSetup.label, exact: true }); await toggle(own, !row.ownSetup.checked);
  const enabled = runtime.getByRole('checkbox', { name: row.enabled.ariaLabel, exact: true }); await toggle(enabled, !row.enabled.checked); await toggle(enabled, row.enabled.checked);
  const after = await (await page.request.get('/hub/config')).json(); expect(after.configuration['x-jevellan'].runtimes.claude).toMatchObject({ enabled: row.enabled.checked, cacheWindowMinutes: target, useOwnSetup: !row.ownSetup.checked });
  expect(after.configuration['x-jevellan'].guards).toEqual(before.configuration['x-jevellan'].guards);
  await page.screenshot({ path: `test-results/RUNTIMES-settings-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('Runtime account views share model chips and preserve Check now', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/runtimes');
  const claude = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  const response = await page.request.get('/api/accounts/view'); expect(response.ok()).toBe(true);
  const view = await response.json(), runtime = view.runtimes.find((row: { id: string }) => row.id === 'claude'); expect(runtime.models.length).toBeGreaterThan(0);
  await expect(claude.locator('.model-chips .chip')).toHaveCount(runtime.models.length);
  for (const model of runtime.models) await expect(claude.locator('.model-chips .chip').filter({ hasText: model.label })).toHaveAttribute('title', model.title);

  const account = page.locator('.account').first(); await expect(account).toBeVisible();
  const checked = page.waitForResponse(response => /\/api\/accounts\/[^/]+\/check$/.test(response.url()) && response.request().method() === 'POST');
  await account.getByRole('button', { name: 'Check now', exact: true }).click(); expect((await checked).ok()).toBe(true);
  await expect(account.locator('.account-heading .status')).toHaveText('Ready');
  await page.screenshot({ path: `test-results/ACCOUNTS-read-model-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('Configuration import keeps edited source ahead of delayed previews and applies the current draft', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/configuration');
  const before = await page.request.get('/hub/config/export'); expect(before.ok()).toBe(true); const original = await before.text();
  const proposed = original.replace(/pauseAfterPlan: (true|false)/u, (_, value) => `pauseAfterPlan: ${value === 'false'}`); expect(proposed).not.toBe(original);
  await page.getByRole('button', { name: 'Import', exact: true }).click(); await page.getByRole('textbox', { name: 'YAML', exact: true }).fill(proposed);
  let release!: () => void, entered!: () => void, continued!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { continued = resolve; });
  const route = '**/config/import-preview';
  await page.route(route, async request => { entered(); await held; try { await request.continue(); } finally { continued(); } });
  try {
    await page.getByRole('button', { name: 'Validate and show diff', exact: true }).click(); await started;
    await page.getByRole('textbox', { name: 'YAML', exact: true }).fill(original);
  } finally { release(); }
  await resumed; await expect(page.getByRole('button', { name: 'Validate and show diff', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply import', exact: true })).toHaveCount(0);
  await page.unroute(route);
  await page.getByRole('button', { name: 'Validate and show diff', exact: true }).click(); await expect(page.getByRole('heading', { name: 'No changes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply import', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'YAML', exact: true }).fill(proposed); await page.getByRole('button', { name: 'Validate and show diff', exact: true }).click();
  await expect(page.getByText('/x-jevellan/guards/pauseAfterPlan', { exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/CONFIG-import-preview-${layout(info)}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Apply import', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Configuration imported.' })).toBeVisible();
  expect(await (await page.request.get('/hub/config/export')).text()).toBe(proposed);
  await page.screenshot({ path: `test-results/CONFIG-import-saved-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('PAR7 library uploads, attachments in both composers, images and project rigging', async ({ page }, info) => {
  const errors = await begin(page);
  await page.goto('/projects/projects_fixture'); if (phone(info)) await tab(page, 'Overview').click();
  await page.getByRole('tablist', { name: 'Overview', exact: true }).getByRole('tab', { name: 'Library', exact: true }).click();
  const panel = page.locator('.pw-library');
  await expect(panel).toContainText('Nothing in the library yet.');
  const png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 320; const context = canvas.getContext('2d')!; context.fillStyle = '#f4f7fb'; context.fillRect(0, 0, 600, 320); context.fillStyle = '#0d1b2a'; context.font = '28px sans-serif'; context.fillText('Invoices', 32, 58); context.font = '18px sans-serif'; context.fillText('Invoice 1001', 32, 114); context.fillText('Customer: Example office', 32, 152); context.fillStyle = '#ad237b'; context.fillText('Total: 120.00 EUR', 32, 220); return canvas.toDataURL('image/png').split(',')[1]!; }), 'base64');
  await panel.locator('input[type=file]').setInputFiles({ name: 'PAR7 screen.png', mimeType: 'image/png', buffer: png });
  await expect(panel.getByText('PAR7 screen.png', { exact: true })).toBeVisible(LONG);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-library-${layout(info)}.png` });
  await panel.getByRole('button', { name: 'Open PAR7 screen.png', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-image-${layout(info)}.png` });
  await page.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
  if (phone(info)) await tab(page, 'Chat').click();
  const compose = page.locator('.pw-composer');
  await compose.locator('input[type=file]').setInputFiles({ name: 'PAR7 attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('Shared file on every device.') });
  await composer(page).fill('PAR7 files: inspect these.');
  await expect(compose).toContainText('PAR7 attachment.txt'); await composer(page).press('Enter');
  const card = page.locator('.pw-timeline .pw-thread-card').filter({ hasText: 'PAR7 inspect attached files' });
  await expect(card).toBeVisible(LONG); await expect(page.locator('.pw-owner .pw-library-chips')).toContainText('PAR7 attachment.txt', LONG);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-chat-attachment-${layout(info)}.png` });
  await card.getByRole('link', { name: 'PAR7 inspect attached files', exact: true }).click();
  await expect(page.locator('.pw-report').last()).toContainText('Read attached files: PAR7 attachment.txt.', LONG);
  const threadComposer = page.locator('.pw-thread-composer');
  await threadComposer.locator('input[type=file]').setInputFiles({ name: 'PAR7 follow up.txt', mimeType: 'text/plain', buffer: Buffer.from('A follow-up file.') });
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).fill('PAR7 inspect: read this file too.');
  await page.getByRole('textbox', { name: 'Message this thread', exact: true }).press('Enter');
  await expect(page.locator('.pw-report').last()).toContainText('Read attached files: PAR7 follow up.txt.', LONG);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-thread-attachment-${layout(info)}.png` });
  // Desktop paste uses the same attachment controller without replacing the typed message.
  if (!phone(info)) {
    await threadComposer.evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71])], 'pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer })); });
    await expect(threadComposer).toContainText('pasted.png'); await threadComposer.getByRole('button', { name: 'Remove pasted.png' }).click();
  }
  await page.goto('/settings/rigging');
  await page.getByRole('button', { name: 'Add local item', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('PAR7 scoped rule');
  await dialog.getByLabel('Content', { exact: true }).fill('Keep fixture changes small.');
  await dialog.getByRole('checkbox', { name: 'Projects fixture', exact: true }).check();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-rigging-${layout(info)}.png` });
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('PAR7 scoped rule', { exact: true })).toBeVisible();
  await page.goto('/projects/projects_fixture/settings');
  await page.getByRole('link', { name: 'Environment', exact: true }).click();
  await expect(page.getByText(/Rigging for this project:.*PAR7 scoped rule/u)).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7-environment-${layout(info)}.png` });
  expect(errors).toEqual([]);
});

test('PAR7b images decode, gallery controls work and failed uploads keep the message without duplicates', async ({ page }, info) => {
  const errors = await begin(page);
  const previous = await (await page.request.get(`${PROJECT}/library`)).json() as { items: Array<{ id: string }> };
  for (const item of previous.items) expect((await page.request.delete(`${PROJECT}/library/${item.id}`)).ok()).toBe(true);
  await page.goto('/projects/projects_fixture');
  if (phone(info)) await tab(page, 'Overview').click();
  await page.getByRole('tablist', { name: 'Overview', exact: true }).getByRole('tab', { name: 'Library', exact: true }).click();
  const panel = page.locator('.pw-library');
  const png = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 320; const context = canvas.getContext('2d')!; context.fillStyle = '#e8eff6'; context.fillRect(0, 0, 600, 320); context.fillStyle = '#0d1b2a'; context.font = '28px sans-serif'; context.fillText('A shared image', 32, 58); context.font = '18px sans-serif'; context.fillText('Visible in the library and messages', 32, 118); return canvas.toDataURL('image/png').split(',')[1]!; }), 'base64');
  await panel.locator('input[type=file]').setInputFiles([{ name: 'gallery one.png', mimeType: 'image/png', buffer: png }, { name: 'gallery two.png', mimeType: 'image/png', buffer: png }]);
  await expect(panel.locator('.pw-library-row')).toHaveCount(2, LONG);
  await expect.poll(() => panel.locator('.pw-library-thumb img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 600)), LONG).toBe(true);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7b-decoded-${layout(info)}.png` });
  await panel.getByRole('button', { name: 'Open gallery one.png', exact: true }).click();
  const gallery = page.getByRole('dialog'); await expect.poll(() => gallery.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth), LONG).toBe(600);
  await gallery.getByRole('button', { name: 'Next image', exact: true }).click(); await expect(gallery.getByRole('heading', { name: 'gallery two.png', exact: true })).toBeVisible();
  await gallery.getByRole('button', { name: 'Previous image', exact: true }).click(); await expect(gallery.getByRole('heading', { name: 'gallery one.png', exact: true })).toBeVisible();
  await gallery.getByRole('button', { name: 'Close panel', exact: true }).click();
  await panel.getByRole('button', { name: 'From threads', exact: true }).click(); await expect(panel.locator('.pw-library-row')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Uploads', exact: true }).click(); await expect(panel.locator('.pw-library-row')).toHaveCount(2);
  if (phone(info)) await tab(page, 'Chat').click();
  const compose = page.locator('.pw-composer');
  await compose.locator('input[type=file]').setInputFiles({ name: 'message image.png', mimeType: 'image/png', buffer: png }); await composer(page).fill('Keep this image in the project library.'); await composer(page).press('Enter');
  const preview = page.locator('.pw-owner .pw-library-thumb img'); await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth), LONG).toBe(600);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7b-message-image-${layout(info)}.png` });
  await compose.locator('input[type=file]').setInputFiles([{ name: 'retry first.txt', mimeType: 'text/plain', buffer: Buffer.from('First file.') }, { name: 'retry second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file.') }]);
  await page.route('**/library/uploads/retry%20second.txt', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ schema: 'error-v1', code: 'fixture-upload', message: 'Simulated upload interruption.' }) }), { times: 1 });
  await composer(page).fill('Keep both files.');
  const refused = page.waitForResponse(response => response.url().includes('retry%20second.txt') && response.status() === 503); await composer(page).press('Enter'); await refused;
  await expect(composer(page)).toHaveValue('Keep both files.'); await expect(compose).toContainText('retry first.txt'); await expect(compose).toContainText('retry second.txt');
  await expect(compose.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7b-upload-retry-${layout(info)}.png` });
  await composer(page).press('Enter'); await expect(composer(page)).toHaveValue('', LONG); await expect(compose.locator('.pw-attachment')).toHaveCount(0);
  const listed = await (await page.request.get(`${PROJECT}/library`)).json() as { items: Array<{ name: string }> };
  expect(listed.items.filter(item => item.name === 'retry first.txt')).toHaveLength(1); expect(listed.items.filter(item => item.name === 'retry second.txt')).toHaveLength(1);
  await expect(page.locator('.toast[role=alert]')).toContainText('Simulated upload interruption.');
  await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  if (!phone(info)) {
    await compose.evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File(['Dropped text'], 'dropped.txt', { type: 'text/plain' })); element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer })); });
    await expect(compose).toContainText('dropped.txt'); await compose.getByRole('button', { name: 'Remove dropped.txt' }).click();
  }
  if (phone(info)) await tab(page, 'Overview').click();
  await page.getByRole('tablist', { name: 'Overview', exact: true }).getByRole('tab', { name: 'Library', exact: true }).click();
  await panel.getByRole('button', { name: 'Uploads', exact: true }).click();
  const row = panel.locator('.pw-library-row').filter({ hasText: 'gallery one.png' }); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete gallery one.png from the library?', exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-7/screenshots/PAR7b-delete-${layout(info)}.png` });
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PAR8 compatible endpoint form, menu, automatic account choice and Why', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/runtimes');
  const runtime = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await runtime.getByRole('button', { name: 'Add account', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add account', exact: true });
  await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('endpoint');
  await form.getByRole('textbox', { name: 'Label', exact: true }).nth(0).fill('PAR8 endpoint account');
  await form.getByRole('textbox', { name: 'Base URL', exact: true }).fill(new URL('/anthropic', `http://127.0.0.1:${Number(new URL(info.project.use.baseURL!).port) + 200}`).href);
  await form.getByRole('combobox', { name: 'Billing', exact: true }).selectOption('metered');
  await expect(form.getByRole('combobox', { name: 'When Jevellan may use it', exact: true })).toBeVisible();
  await form.getByRole('combobox', { name: 'Billing', exact: true }).selectOption('free');
  await expect(form.getByRole('combobox', { name: 'When Jevellan may use it', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-form-${layout(info)}.png` });
  await form.getByRole('textbox', { name: 'Model id', exact: true }).fill('par8-glm');
  await form.getByRole('textbox', { name: 'Label', exact: true }).nth(1).fill('PAR8 GLM');
  await expect(form.getByRole('checkbox', { name: 'Medium', exact: true })).toBeChecked();
  await form.getByRole('textbox', { name: 'When to use it (Jev reads this)', exact: true }).fill('Small bounded analysis work.');
  await form.getByRole('textbox', { name: 'Background model', exact: true }).fill('par8-glm');
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-form-bottom-${layout(info)}.png` });
  await form.getByLabel('Auth token', { exact: true }).fill('fixture_endpoint_ready'); await form.getByRole('button', { name: 'Add account', exact: true }).click(); await expect(form).toHaveCount(0, LONG);
  const account = page.locator('.account').filter({ has: page.getByText('PAR8 endpoint account', { exact: true }) });
  await expect(account.locator('.status')).toHaveText('Ready', LONG); await expect(account.locator('.usage-windows')).toHaveCount(0);
  await expect(runtime.locator('.model-chips')).toContainText('PAR8 GLM');
  const config = await read(page, '/hub/config') as { configuration: { 'x-jevellan': { menu: Array<{ id: string; model: string; enabled: boolean; unavailableReason?: string }> } } };
  const model = config.configuration['x-jevellan'].menu.find(model => model.model === 'par8-glm')!; expect(model.enabled).toBe(true);
  await openProject(page, 'Projects fixture'); await page.getByRole('button', { name: 'New task', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'New task', exact: true }); await task.locator('summary').filter({ hasText: 'Choose where it runs' }).click();
  await expect(task.getByRole('combobox', { name: 'Model', exact: true }).locator('option').filter({ hasText: 'PAR8 GLM' })).toHaveCount(1);
  await task.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id);
  // The capture shows the chosen menu entry, not the top of the scrolled dialog.
  await task.getByRole('combobox', { name: 'Model', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-menu-${layout(info)}.png` });
  await task.getByRole('button', { name: 'Cancel', exact: true }).click();
  const work = ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)), { schema, projectId, revision, ...settings } = work.settings; void schema; void projectId;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, placement: { ...settings.placement, allowedModelIds: [model.id], minEffort: null } } } })).ok()).toBe(true);
  if (phone(info)) await tab(page, 'Chat').click(); await composer(page).fill('PAR8 endpoint'); await composer(page).press('Enter');
  await expect(page.locator('.pw-timeline .pw-thread-card').filter({ hasText: 'PAR8 endpoint task' })).toContainText('PAR8 GLM', LONG);
  const tasks = TaskListViewSchema.parse(await read(page, `${PROJECT}/tasks`)).tasks;
  const started = tasks.find(task => task.title === 'PAR8 endpoint task')!; expect(started.threadId).toBeTruthy();
  await page.goto(`/projects/projects_fixture/threads/${started.threadId}`); await expect(page.getByText('The endpoint task inspected README.', { exact: false }).first()).toBeVisible(LONG);
  await sessionDetails(page);
  await page.getByRole('button', { name: 'Why', exact: true }).click();
  const why = page.getByRole('dialog', { name: 'Why this placement', exact: true }); await expect(why).toContainText('PAR8 endpoint account'); await expect(why).toContainText('PAR8 GLM');
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-why-${layout(info)}.png` });
  await why.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.goto('/settings/runtimes');
  for (const [token, status, capture] of [['fixture_endpoint_refused', 'Key refused', 'refused'], ['fixture_endpoint_unreachable', 'Unreachable: HTTP 503', 'unreachable'], ['fixture_endpoint_ready', 'Ready', 'ready']] as const) {
    await account.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit account', exact: true }); await edit.getByLabel('Auth token', { exact: true }).fill(token); await edit.getByRole('button', { name: 'Save account', exact: true }).click(); await expect(edit).toHaveCount(0, LONG);
    await expect(account.locator('.status')).toHaveText(status, LONG);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (capture !== 'ready') await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-${capture}-${layout(info)}.png` });
  }
  await account.getByRole('button', { name: 'Disable', exact: true }).click(); await expect(account.locator('.status')).toHaveText('Disabled', LONG);
  const disabled = await read(page, '/hub/config') as typeof config;
  expect(disabled.configuration['x-jevellan'].menu.find(row => row.id === model.id)).toMatchObject({ enabled: false, unavailableReason: 'The account that serves this model is disabled.' });
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-disabled-${layout(info)}.png` });
  await page.goto('/settings/decisions');
  const menuRow = page.locator('.menu-model').filter({ has: page.locator('input[value="PAR8 GLM"]') });
  await expect(menuRow.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked(); await expect(menuRow.getByRole('checkbox', { name: 'Enabled', exact: true })).toBeDisabled();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-8/screenshots/PAR8-model-settings-${layout(info)}.png` });
  const current = ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)), { schema: currentSchema, projectId: currentProjectId, revision: currentRevision, ...currentSettings } = current.settings; void currentSchema; void currentProjectId;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision: currentRevision, settings: { ...currentSettings, placement: work.settings.placement } } })).ok()).toBe(true);
  expect(errors).toEqual([]);
});

test('PAR9 suggested setup lets the owner edit, choose, apply and dismiss without changing other settings', async ({ page }, info) => {
  const errors = await begin(page); await openProject(page, 'Projects fixture');
  const original = ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)).settings;
  const request = async () => {
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, LONG);
    await page.getByLabel('Project menu', { exact: true }).click();
    await page.getByRole('button', { name: 'Suggest setup', exact: true }).click();
    if (phone(info)) await tab(page, 'Chat').click();
    const card = page.locator('.pw-setup-card').filter({ has: page.getByRole('button', { name: 'Apply setup', exact: true }) });
    await expect(card.getByRole('textbox', { name: 'Test command', exact: true })).toHaveValue('npm test', LONG); return card;
  };
  let card = await request();
  await expect(card.getByRole('checkbox', { name: 'Test command', exact: true })).toBeChecked();
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-9/screenshots/PAR9-suggested-${layout(info)}.png`, fullPage: true });
  for (const name of ['Test command', 'Worktree setup command', 'Copy into new worktrees']) await card.getByRole('checkbox', { name, exact: true }).uncheck();
  await card.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Use narrow tests and keep the work focused.');
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-9/screenshots/PAR9-edited-${layout(info)}.png`, fullPage: true });
  await card.getByRole('button', { name: 'Apply setup', exact: true }).click();
  await expect(page.getByText('Setup applied: 4 changes.', { exact: true })).toBeVisible(LONG);
  await expect(page.getByText('Fill in their values in Project settings → Environment.', { exact: true })).toBeVisible();
  const applied = ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)).settings;
  expect(applied.instructions).toBe('Use narrow tests and keep the work focused.'); expect(applied.setupCommand).toBe(original.setupCommand);
  const expectedVariables = original.environment.variables.some(row => row.name === 'SANDBOX_DATA_DIR') ? original.environment.variables : [...original.environment.variables, { name: 'SANDBOX_DATA_DIR', value: '' }];
  expect(applied.environment).toEqual({ variables: expectedVariables, secrets: [...new Set([...original.environment.secrets, 'SERVICE_TOKEN'])], copyFiles: original.environment.copyFiles });
  const goals = await read(page, `${PROJECT}/goals`) as { goals: Array<{ goal: { name: string; state: string; autonomy: string } }> }; expect(goals.goals.some(row => row.goal.name === 'Keep the fixture tidy' && row.goal.state === 'paused' && row.goal.autonomy === 'propose')).toBe(true);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-9/screenshots/PAR9-applied-${layout(info)}.png` });
  card = await request(); await card.getByRole('button', { name: 'Not now', exact: true }).click(); await expect(page.getByText('Setup dismissed.', { exact: true })).toBeVisible(LONG);
  expect(ProjectWorkViewSchema.parse(await read(page, `${PROJECT}/work`)).settings).toEqual(applied);
  await page.screenshot({ path: `docs/acceptance/projects-parity-2026-10/phase-9/screenshots/PAR9-dismissed-${layout(info)}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const { schema, projectId, revision, ...fields } = applied; void schema; void projectId;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...fields, instructions: original.instructions, environment: original.environment } } })).ok()).toBe(true);
  expect(errors).toEqual([]);
});

test('WG1 Health checks can be edited, disabled and run with step results', async ({ page }, info) => {
  const { createServer } = await import('node:http');
  let healthy = true;
  const server = createServer((_, response) => { response.writeHead(healthy ? 200 : 500); response.end('sandbox page'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const errors = await begin(page);
    await page.goto('/projects/projects_fixture/settings');
    await page.getByRole('button', { name: 'Add health check', exact: true }).click();
    const health = page.locator('#project-settings-health');
    await health.getByLabel('Check name', { exact: true }).fill('Sandbox app');
    await health.getByLabel('URL', { exact: true }).fill(`http://127.0.0.1:${port}/`);
    await health.getByLabel('Expected text (optional)', { exact: true }).fill('sandbox page');
    await health.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(health.getByText('Passed', { exact: true })).toBeVisible();
    healthy = false;
    await health.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(health.getByText(/status 500, expected \[200\]/)).toBeVisible();
    await health.getByText(/status 500, expected \[200\]/).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`health-results-${layout(info)}.png`) });
    await health.getByLabel('Enabled', { exact: true }).uncheck();
    await page.screenshot({ path: info.outputPath(`health-checks-${layout(info)}.png`) });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL('/projects/projects_fixture');
    const saved = (await work(page)).settings.healthChecks.find(check => check.name === 'Sandbox app');
    expect(saved).toMatchObject({ enabled: false, steps: [{ expectBody: 'sandbox page' }] });
    await page.goto('/projects/projects_fixture/settings');
    await expect(page.locator('#project-settings-health').getByText(/status 500, expected \[200\]/)).toBeVisible();
    expect(errors).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('WG4 landing settings, owner route, landed groups and branch continuation', async ({ page }, info) => {
  const errors = await begin(page);
  const legacyResponse = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `legacy_${info.project.name}`, title: 'A legacy pull request', task: 'WG4 legacy: preserve this work.', modelId: 'codex-gpt', effort: 'high' } }); expect(legacyResponse.ok()).toBe(true);
  const { threadId: legacyId } = await legacyResponse.json() as { threadId: string };
  await expect.poll(async () => (await threadView(page, legacyId)).thread.pr?.state, { timeout: 90_000 }).toBe('open');
  await page.goto('/projects/projects_fixture/settings');
  const landing = page.locator('#project-settings-pull-requests');
  await landing.getByRole('combobox', { name: 'Delivery', exact: true }).selectOption('land');
  await landing.getByLabel('Land automatically', { exact: true }).uncheck();
  await landing.getByRole('button', { name: 'Add landing check', exact: true }).click();
  const check = landing.locator('fieldset fieldset').last();
  await check.getByLabel('Name', { exact: true }).fill('Selected check');
  await check.getByLabel('Paths', { exact: true }).fill('wg-landing.txt');
  await check.getByLabel('Command', { exact: true }).fill('test -f wg-landing.txt');
  await landing.getByLabel('Smoke check', { exact: true }).fill('true');
  await landing.getByLabel('Keep commits for these paths', { exact: true }).fill('docs/legal/');
  await landing.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`landing-settings-${layout(info)}.png`), fullPage: true });
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page).toHaveURL('/projects/projects_fixture');
  expect((await work(page)).settings.delivery).toBe('land');
  const created = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `landing_${info.project.name}`, title: 'A checked landing', task: 'WG4 landing: make a checked change.', modelId: 'codex-gpt', effort: 'high' } }); expect(created.ok()).toBe(true);
  const { threadId } = await created.json() as { threadId: string };
  await expect.poll(async () => (await read(page, `${PROJECT}/threads/${threadId}`) as ThreadView).thread.state, { timeout: 90_000 }).toBe('in-review');
  await page.reload(); await sectionTab(page, info, 'Threads');
  const question = page.locator('.pw-decision').filter({ hasText: 'A checked landing' });
  // Owner action is available both on the thread and on its pinned decision.
  await page.goto(`/projects/projects_fixture/threads/${threadId}`);
  await page.getByRole('button', { name: 'Why this landing', exact: true }).click();
  const why = page.getByRole('dialog', { name: 'Why this landing', exact: true }); await expect(why.getByText('Selected check: passed', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`landing-why-${layout(info)}.png`) });
  await why.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Land now', exact: true }).click();
  await expect(page.getByText(/^Landed as /)).toBeVisible({ timeout: 90_000 });
  await page.goto('/projects/projects_fixture'); await sectionTab(page, info, 'Threads');
  await expect(page.getByRole('heading', { name: 'Landed, waiting for deploy', exact: true })).toBeVisible();
  await page.getByText(/^Landed as /).first().scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`landing-groups-${layout(info)}.png`) });
  await page.goto(`/projects/projects_fixture/threads/${legacyId}`);
  await page.getByRole('button', { name: 'Land instead', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Land now', exact: true })).toBeVisible(LONG);
  await page.getByRole('button', { name: 'Land now', exact: true }).click();
  await expect(page.getByText(/^Landed as /)).toBeVisible(LONG);
  await page.screenshot({ path: info.outputPath(`landing-legacy-converted-${layout(info)}.png`) });
  await page.goto('/projects/projects_fixture');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const form = page.getByRole('dialog'); await form.getByLabel('Title', { exact: true }).fill('Continue a branch'); await form.getByLabel('Brief', { exact: true }).fill('Continue existing work.'); await form.getByLabel('From branch', { exact: true }).fill('missing-branch');
  await page.screenshot({ path: info.outputPath(`landing-branch-form-${layout(info)}.png`) });
  await form.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(form.getByText('Branch missing-branch is not on origin.', { exact: true })).toBeVisible();
  void question; expect(errors).toEqual([]);
});

test('WG5 pinned deploy message, Not now and confirmed rollback', async ({ page }, info) => {
  const { createServer } = await import('node:http');
  const server = createServer((_, response) => { response.writeHead(200); response.end('sandbox app'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const errors = await begin(page); await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 0, reset: true });
    const command = `node -e 'const e=process.env; require("fs").writeFileSync(e.JEVELLAN_JOB_WORKSPACE+"/project-deploy-job-result.json",JSON.stringify({schema:"project-deploy-job-result-v1",mode:e.JEVELLAN_JOB_MODE||"preflight",commit:e.JEVELLAN_JOB_COMMIT,previousCommit:e.JEVELLAN_DEPLOY_PREVIOUS_COMMIT||null,rollbackAvailable:!!e.JEVELLAN_DEPLOY_PREVIOUS_COMMIT,released:!!e.JEVELLAN_JOB_MODE,migrationChanged:false,missing:[],summary:"Harmless fixture release"}))'`;
    const jobResponse = await page.request.post(`${PROJECT}/jobs`, { data: { schema: 'job-create-request-v1', clientRequestId: `deploy_${info.project.name}`, name: 'Harmless deploy', goalId: null, enabled: true, run: { kind: 'command', command, timeoutMinutes: 1 }, gate: null } }); expect(jobResponse.ok()).toBe(true); const job = await jobResponse.json() as { id: string };
    expect((await page.request.post(`${PROJECT}/jobs/${job.id}/run`, { data: { schema: 'project-run-request-v1', clientRequestId: `base_${info.project.name}` } })).ok()).toBe(true);
    const jobRuns = async () => ProjectJobRunListViewSchema.parse(await read(page, `${PROJECT}/job-runs`)).runs;
    await expect.poll(async () => (await jobRuns()).find(run => run.jobId === job.id)?.conclusion, { timeout: 60000 }).toBe('passed');
    const base = (await jobRuns()).find(run => run.jobId === job.id)!.commit;
    const original = (await work(page)).settings, { schema, projectId, revision, ...settings } = original; void schema; void projectId;
    expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, delivery: 'land', autoLand: false, landingChecks: [], smokeCheck: 'true', nightlyWindow: { ...settings.nightlyWindow, enabled: false }, deploy: { mode: 'approve', jobId: job.id, desktopJobId: job.id, suiteJobId: null }, healthChecks: [{ id: 'wg5_app', name: 'Sandbox app', enabled: true, steps: [{ name: 'The page', method: 'GET', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, expectStatus: [200], expectBody: 'sandbox app' }] }] } } })).ok()).toBe(true);
    await page.goto('/projects/projects_fixture/settings'); const landing = page.locator('#project-settings-pull-requests');
    await expect(landing.getByRole('combobox', { name: 'Deploy job', exact: true })).toHaveValue(job.id); await landing.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`deploy-settings-${layout(info)}.png`), fullPage: true });
    const start = await page.request.post(`${PROJECT}/threads`, { data: { schema: 'thread-create-request-v1', clientRequestId: `wg5_${info.project.name}`, title: 'A deployable change', task: 'WG5 landing: create a harmless fixture.', modelId: 'codex-gpt', effort: 'high' } }); expect(start.ok()).toBe(true); const { threadId } = await start.json() as { threadId: string };
    await expect.poll(async () => (await threadView(page, threadId)).thread.state, { timeout: 90_000 }).toBe('in-review');
    expect((await page.request.put(`${PROJECT}/deploys/baseline`, { data: { schema: 'project-deploy-baseline-request-v1', expectedRevision: ProjectDeployViewSchema.parse(await read(page, `${PROJECT}/deploys`)).baseline?.revision ?? 0, commit: base, rollbackAvailable: true, migrationPaths: [], desktopPaths: ['wg-deploy.txt'], desktopSecretNames: ['FIXTURE_SIGNING_SECRET'] } })).ok()).toBe(true);
    await page.goto(`/projects/projects_fixture/threads/${threadId}`); await page.getByRole('button', { name: 'Land now', exact: true }).click(); await expect(page.getByText(/^Landed as /)).toBeVisible({ timeout: 90_000 });
    const commit = (await threadView(page, threadId)).thread.landing!.commit;
    await pulse(); await page.goto('/projects/projects_fixture'); await sectionTab(page, info, 'Waiting');
    const message = page.locator('.pw-decision').filter({ hasText: `Deploy 1 landed thread(s) to production at ${commit.slice(0, 7)}?` }); await expect(message).toBeVisible(LONG); await expect(message.getByText(/Sandbox app: passed/)).toBeVisible(); await expect(message.getByText('Desktop build skipped: Missing signing secrets: FIXTURE_SIGNING_SECRET', { exact: true })).toBeVisible();
    await message.getByRole('button', { name: 'Not now', exact: true }).click(); await expect(message.getByText(/Not now at/)).toBeVisible(LONG); await message.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`deploy-not-now-${layout(info)}.png`) });
    await message.getByRole('button', { name: `Deploy ${commit.slice(0, 7)}`, exact: true }).click();
    await expect.poll(async () => { const value = await read(page, `${PROJECT}/deploys`) as { records: Array<{ commit: string; deployedAt?: string }> }; return value.records.find(row => row.commit === commit)?.deployedAt; }, { timeout: 60_000 }).toBeTruthy();
    await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 6 }); await pulse();
    await expect.poll(async () => (await threadView(page, threadId)).thread.resolution?.by, { timeout: 60_000 }).toBe('deploy');
    await page.reload(); await sectionTab(page, info, 'Threads'); const overview = page.locator('.pw-last-deploy'); await expect(overview.getByText(new RegExp(`Last deploy: ${commit.slice(0, 7)}`))).toBeVisible(LONG); await overview.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`deploy-last-${layout(info)}.png`) });
    const rollbackModel = await read(page, `${PROJECT}/deploy-summary`) as { rollback: { confirmation: string; body: { expectedRevision: number } } };
    await overview.getByRole('button', { name: `Roll back to ${base.slice(0, 7)}`, exact: true }).click(); await expect(overview.getByRole('button', { name: 'Confirm rollback', exact: true })).toBeVisible();
    await expect(overview.getByText(rollbackModel.rollback.confirmation, { exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath(`deploy-rollback-confirm-${layout(info)}.png`) });
    await overview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await overview.getByRole('button', { name: `Roll back to ${base.slice(0, 7)}`, exact: true }).click(); await overview.getByRole('button', { name: 'Confirm rollback', exact: true }).click();
    const rollbackStage = async () => ProjectDeployViewSchema.parse(await read(page, `${PROJECT}/deploys`)).records.find(row => row.commit === commit)?.monitor?.stage;
    await expect.poll(rollbackStage, { timeout: 60_000 }).toBe('rollback-one');
    await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 1 }); await pulse();
    await expect.poll(rollbackStage, { timeout: 60_000 }).toBe('rollback-five');
    await control('/projects/clock', { schema: 'fixture-project-clock-v1', advanceMinutes: 4 }); await pulse();
    await expect.poll(async () => ProjectDeployViewSchema.parse(await read(page, `${PROJECT}/deploys`)).records.find(row => row.commit === commit)?.rollback?.result, { timeout: 60_000 }).toBe('done');
    await page.reload(); await sectionTab(page, info, 'Threads'); await expect(page.locator('.pw-last-deploy').getByText(new RegExp(`Last deploy: ${base.slice(0, 7)}`))).toBeVisible(LONG);
    await page.screenshot({ path: info.outputPath(`deploy-rollback-result-${layout(info)}.png`) }); expect(errors).toEqual([]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('WG6 coordinator session settings and durable save', async ({ page }, info) => {
  const errors = await begin(page);
  const current = (await work(page)).settings, { schema, projectId, revision, ...settings } = current; void schema; void projectId;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, coordinator: { ...settings.coordinator, modelId: 'codex-gpt' }, nightlyWindow: { ...settings.nightlyWindow, enabled: false }, coordinatorHandoffAtPercent: 75, deploy: { ...settings.deploy, mode: 'automatic' } } } })).ok()).toBe(true);
  await page.goto('/projects/projects_fixture/settings');
  const limits = page.locator('#project-settings-limits'); await limits.scrollIntoViewIfNeeded();
  await expect(limits.getByRole('spinbutton', { name: 'Coordinator session reset at (%)', exact: true })).toHaveValue('75');
  await expect(limits.getByRole('spinbutton', { name: 'Thread compaction at (%)', exact: true })).toHaveValue(String(settings.compactAtPercent));
  await page.screenshot({ path: info.outputPath(`coordinator-session-settings-${layout(info)}.png`), fullPage: true });
  const jobResponse = await page.request.post(`${PROJECT}/jobs`, { data: { schema: 'job-create-request-v1', clientRequestId: `wg6_job_${info.project.name}`, name: 'Automation fixture', goalId: null, enabled: false, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } } });
  expect(jobResponse.ok()).toBe(true); const job = await jobResponse.json() as { id: string }; await page.reload();
  const deployMode = page.getByRole('combobox', { name: 'Deploy mode', exact: true }), deployJob = page.getByRole('combobox', { name: 'Deploy job', exact: true });
  await expect(deployMode.getByRole('option', { name: 'Automatic', exact: true })).toHaveJSProperty('disabled', true);
  await expect(deployMode.getByRole('option', { name: 'Automatic', exact: true })).toHaveAttribute('disabled', '');
  await expect(deployMode.getByRole('option', { name: "After the night's full suite", exact: true })).toHaveJSProperty('disabled', true);
  await expect(deployMode.getByRole('option', { name: 'Owner approval', exact: true })).toHaveJSProperty('disabled', false);
  await expect(page.getByText("Change through config when you're ready.", { exact: true })).toBeVisible();
  await deployJob.selectOption(job.id); await expect(deployMode).toHaveValue('automatic');
  await limits.getByRole('spinbutton', { name: 'Coordinator session reset at (%)', exact: true }).fill('76');
  const automation = page.locator('#project-settings-automation'); await automation.scrollIntoViewIfNeeded();
  await automation.getByRole('checkbox', { name: 'Pause deploys', exact: true }).check();
  await automation.getByRole('spinbutton', { name: 'Landing debounce (minutes)', exact: true }).fill('8');
  await automation.getByRole('spinbutton', { name: 'Missed-night catch-up (hours)', exact: true }).fill('0');
  await automation.getByRole('button', { name: 'Save automation preferences', exact: true }).click(); await expect(automation.getByRole('status')).toHaveText('Automation preferences saved.');
  await expect(deployMode).toHaveValue('automatic'); await expect(deployJob).toHaveValue(job.id); await expect(limits.getByRole('spinbutton', { name: 'Coordinator session reset at (%)', exact: true })).toHaveValue('76');
  expect((await work(page)).settings).toMatchObject({ coordinatorHandoffAtPercent: 75, deploy: { mode: 'automatic', jobId: null } });
  await automation.screenshot({ path: info.outputPath(`routine-automation-settings-${layout(info)}.png`) });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await work(page)).settings.coordinatorHandoffAtPercent).toBe(76);
  expect((await work(page)).settings.deploy).toMatchObject({ mode: 'automatic', jobId: job.id });
  expect(await read(page, `${PROJECT}/routine-settings`)).toMatchObject({ automation: { fields: { deployPaused: true, debounceMinutes: '8', catchUpHours: '0' } } });
  expect((await page.request.post(`${PROJECT}/coordinator/messages`, { data: { schema: 'coordinator-message-request-v1', clientMessageId: `wg6_${info.project.name}`, text: 'Remember this completed browser check.' } })).ok()).toBe(true);
  await expect.poll(async () => (await work(page)).coordinator.session?.turns, { timeout: 60000 }).toBeGreaterThan(0);
  expect((await page.request.post(`${PROJECT}/coordinator/handoff`, { data: { schema: 'empty-request-v1' } })).ok()).toBe(true);
  await expect.poll(async () => (await work(page)).coordinator.session, { timeout: 60000 }).toBeNull();
  await page.goto('/projects/projects_fixture'); await sectionTab(page, info, 'Chat');
  await expect(page.getByText('I saved the current work for the next session.', { exact: true })).toBeVisible(LONG);
  await page.screenshot({ path: info.outputPath(`coordinator-saved-work-${layout(info)}.png`) });
  expect(errors).toEqual([]);
});

test('Settings navigation keeps engine order and the runtimes fallback', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/not-a-page');
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Settings', exact: true });
  await expect(tabs.locator('.settings-tabs-strip').getByRole('button')).toHaveText(['Runtimes', 'Notifications', 'Rigging', 'Decisions', 'Improver', 'Devices', 'Projects', 'Git', 'Ekoa', 'Agents', 'Cleanup', 'Configuration', 'About']);
  await tabs.getByRole('button', { name: 'Cleanup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cleanup', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Job logs and daemon logs: Keep for (days)', exact: true })).toHaveValue('14');
  await page.screenshot({ path: info.outputPath(`settings-navigation-${layout(info)}.png`), fullPage: true }); expect(errors).toEqual([]);
});

test('WG7 cleanup settings and per-device Clean now receipt', async ({ page }, info) => {
  const errors = await begin(page); const seed = await control('/projects/cleanup-seed', { schema: 'fixture-cleanup-seed-v1' }) as { deviceName: string; deviceId: string };
  await page.goto('/settings/cleanup'); await expect(page.getByRole('heading', { name: 'Cleanup', exact: true })).toBeVisible();
  const keep = page.getByRole('spinbutton', { name: 'Job logs and daemon logs: Keep for (days)', exact: true }); await keep.fill('15');
  await page.getByRole('button', { name: 'Save cleanup settings', exact: true }).click(); await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible(); await page.reload(); await expect(keep).toHaveValue('15');
  await expect(page.getByRole('spinbutton', { name: 'Keep at least (GB) free', exact: true })).toHaveValue('50');
  await page.screenshot({ path: info.outputPath(`cleanup-settings-${layout(info)}.png`), fullPage: true });
  const local = page.locator('section.card').filter({ has: page.getByRole('heading', { name: seed.deviceName, exact: true }) });
  const clean = local.getByRole('button', { name: 'Clean now', exact: true });
  await expect.poll(async () => {
    await clean.click(); await expect(clean).toBeEnabled();
    const state = CleanupStateSchema.parse(await read(page, `/api/devices/${seed.deviceId}/cleanup`));
    return state.lastRun?.state === 'completed' ? state.lastRun.removed : -1;
  }, { timeout: 60000, intervals: [1000, 2000, 3000] }).toBe(1);
  await expect(local.getByText(/^Last run: freed /)).toBeVisible(LONG); await expect(local.getByText(/^1 removed/)).toBeVisible();
  await local.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`cleanup-last-run-${layout(info)}.png`) }); expect(errors).toEqual([]);
});

test('Project definitions preserve folder naming, device choices and canonical create and edit', async ({ page }, info) => {
  const errors = await begin(page), roster = DeviceRosterSchema.parse(await read(page, '/hub/devices/roster'));
  const device = roster.devices.find(row => row.device.id === roster.currentDeviceId)!.device;
  const original = ProjectsListSchema.parse(await read(page, '/hub/projects')).projects.find(row => row.project.id === 'projects_fixture')!.project;
  const path = original.paths[device.id]!, name = `Definition fixture ${layout(info)}`;
  await page.goto('/settings/projects'); await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog'), localPath = dialog.getByLabel(`Path on ${device.name}`, { exact: true });
  await localPath.fill(path + '/'); await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(basename(path));
  await dialog.getByLabel('Name', { exact: true }).fill(name); await localPath.fill(path + '///'); await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
  const memory = dialog.getByRole('combobox', { name: 'Keep project memory', exact: true }), policy = dialog.getByRole('combobox', { name: 'Git policy', exact: true });
  await memory.selectOption('repo'); await policy.selectOption('external'); await expect(memory).toHaveValue('device'); await policy.selectOption('main'); await expect(memory).toHaveValue('repo'); await memory.selectOption('hub');
  const allowed = dialog.getByRole('checkbox', { name: device.name, exact: true }); await allowed.click(); await expect(allowed).not.toBeChecked(); await allowed.click(); await expect(allowed).toBeChecked();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/hub/projects' && response.request().method() === 'PUT'); await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); expect((await saved).status()).toBe(200); await expect(dialog).not.toBeVisible(LONG);
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name, exact: true }) }); await expect(card).toContainText('Shared hub memory');
  const stored = ProjectsListSchema.parse(await read(page, '/hub/projects')).projects.find(row => row.project.name === name)!;
  expect(stored.project.allowedDevices?.slice().sort()).toEqual(roster.devices.map(row => row.device.id).sort());
  await expect.poll(async () => { const panel = ContextPanelSchema.parse(await read(page, `/api/projects/${stored.project.id}/context/operations`)); return !panel.busy && panel.operations.every(operation => ['completed', 'cancelled'].includes(operation.status)); }, LONG).toBe(true);
  await card.getByRole('button', { name: 'Edit', exact: true }).click(); await dialog.getByLabel('Name', { exact: true }).fill(`  ${name} edited  `);
  const editSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/hub/projects' && response.request().method() === 'PUT'); await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); const editResponse = await editSaved; expect(editResponse.status(), (await editResponse.json()).message).toBe(200); await expect(dialog).not.toBeVisible(LONG);
  await expect(page.getByRole('heading', { name: `${name} edited`, exact: true })).toBeVisible(); await page.screenshot({ path: `test-results/PROJECT-definition-editor-${layout(info)}.png`, fullPage: true }); expect(errors).toEqual([]);
});

test('WG8 the shared thread limit is editable in Settings Projects', async ({ page }, info) => {
  const errors = await begin(page); await page.goto('/settings/projects');
  await expect(page.getByRole('heading', { name: 'Running threads across all projects', exact: true })).toBeVisible();
  const limit = page.getByRole('spinbutton', { name: 'Maximum running threads', exact: true }); await expect(limit).toHaveValue('6');
  await limit.fill('7'); await page.getByRole('button', { name: 'Save thread limit', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible(); await page.reload(); await expect(limit).toHaveValue('7');
  await page.screenshot({ path: info.outputPath(`global-thread-limit-${layout(info)}.png`), fullPage: true });
  await limit.fill('6'); await page.getByRole('button', { name: 'Save thread limit', exact: true }).click(); expect(errors).toEqual([]);
});

test('WG9 owner labels, Claude app prompts, quiet hours and OAuth connect', async ({ page }, info) => {
  const errors = await begin(page), before = (await work(page)).settings;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const { schema, projectId, revision, ...settings } = before; void schema; void projectId;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, coordinator: { ...settings.coordinator, modelId: 'codex-gpt' }, nightlyWindow: { ...settings.nightlyWindow, enabled: false } } } })).ok()).toBe(true);
  await page.goto('/projects/projects_fixture/settings');
  const notifications = page.locator('#project-settings-notifications');
  await notifications.getByRole('checkbox', { name: 'Quiet hours', exact: true }).check();
  await notifications.getByLabel('Quiet hours start', { exact: true }).fill('23:00');
  await notifications.getByLabel('Quiet hours end', { exact: true }).fill('08:00');
  await expect(notifications.getByLabel('Quiet hours timezone', { exact: true })).toHaveValue('Europe/Lisbon');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await work(page)).settings.notifications.quietHours.enabled).toBe(true);
  await page.goto('/projects/projects_fixture/settings'); await expect(notifications.getByRole('checkbox', { name: 'Quiet hours', exact: true })).toBeChecked();
  await notifications.getByLabel('Quiet hours timezone', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`quiet-hours-${layout(info)}.png`) });
  expect((await page.request.post(`${PROJECT}/coordinator/messages`, { data: { schema: 'coordinator-message-request-v1', clientMessageId: `wg9_${info.project.name}`, via: 'CLI test', text: 'WG9 owner prompt' } })).ok()).toBe(true);
  await page.goto('/projects/projects_fixture'); await sectionTab(page, info, 'Chat');
  await expect(page.getByText('You, via CLI test', { exact: true })).toBeVisible(LONG);
  await expect(page.getByText('The Mac step is ready to copy.', { exact: true })).toBeVisible(LONG);
  await page.screenshot({ path: info.outputPath(`owner-via-${layout(info)}.png`) });
  await sectionTab(page, info, 'Waiting'); const card = page.locator('.owner-command').filter({ hasText: 'The local Mac step uses the Claude app.' });
  await expect(card.getByText(/^Paste into the Claude app on /)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Run in Terminal', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Inspect the local app connection and tell me whether it is online.');
  await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`claude-app-prompt-${layout(info)}.png`) });
  const state = await (await page.request.get('/hub/ekoa')).json();
  await page.route('**/hub/ekoa/connect', route => route.fulfill({ json: { ...state, oauth: { schema: 'ekoa-oauth-status-v1', connected: false, connecting: true, authorizationUrl: new URL('/settings/ekoa/callback?state=fixture_state_browser_123456&code=fixture_code', page.url()).href } } }));
  await page.route('**/hub/ekoa/callback', route => route.fulfill({ json: { ...state, settings: { ...state.settings, enabled: true, url: 'https://fixture.example/mcp' }, tokenSaved: true, oauth: { schema: 'ekoa-oauth-status-v1', connected: true, connecting: false }, connection: { schema: 'ekoa-connection-v1', status: 'connected', tools: [], at: new Date().toISOString() } } }));
  await page.goto('/settings/ekoa'); await page.getByRole('button', { name: 'Connect to Ekoa', exact: true }).click();
  await expect(page.getByText('OAuth sign-in saved. Access refreshes automatically.', { exact: true })).toBeVisible(LONG);
  await expect(page).toHaveURL(/\/settings\/ekoa$/u);
  await page.screenshot({ path: info.outputPath(`ekoa-oauth-${layout(info)}.png`), fullPage: true });
  const latest = (await work(page)).settings, { schema: _s, projectId: _p, revision: rev, ...kept } = latest; void _s; void _p;
  expect((await page.request.put(`${PROJECT}/work-settings`, { data: { schema: 'project-work-settings-request-v1', revision: rev, settings: { ...kept, notifications: before.notifications } } })).ok()).toBe(true);
  expect(errors).toEqual([]);
});


test('EV1 engine card publication and owner merge confirmation preserve the resulting thread state', async ({ page }, info) => {
  const errors = await begin(page);
  await page.goto('about:blank');
  const prepared = await control('/projects/overview', { schema: 'fixture-overview-v1', action: 'prepare' }) as { threadId: string; publishThreadId: string };
  await page.goto('/projects/projects_fixture');
  await expect(page.getByRole('heading', { name: 'Projects fixture', exact: true })).toBeVisible(LONG);
  await sectionTab(page, info, 'Threads');
  const card = page.locator(`.pw-side [data-thread-id="${prepared.publishThreadId}"]`);
  await card.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(region(page, 'Ready for review')).toContainText('PAR3 publish work', LONG);
  await expect(card.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled(LONG);
  const actions = ProjectThreadActionsViewSchema.parse(await read(page, `${PROJECT}/threads/${prepared.publishThreadId}/actions-view`));
  expect(actions.mergeConfirmation).not.toBeNull();
  await card.getByRole('button', { name: 'Merge', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(actions.mergeConfirmation!.body);
  await expect(dialog.getByRole('button', { name: actions.mergeConfirmation!.actionLabel, exact: true })).toBeEnabled(LONG);
  await page.screenshot({ path: `test-results/EV1-owner-merge-confirmation-${layout(info)}.png`, fullPage: false });
  await dialog.getByRole('button', { name: actions.mergeConfirmation!.actionLabel, exact: true }).click();
  await expect(dialog).toHaveCount(0, LONG);
  await expect.poll(async () => (await threadView(page, prepared.publishThreadId)).thread.pr?.state, LONG).toBe('merged');
  const finished = await threadView(page, prepared.publishThreadId);
  await expect(region(page, 'Resolved')).toContainText('PAR3 publish work', LONG);
  await expect(card.locator('.pw-outcome')).toHaveText(finished.card!.mergedOutcome!);
  expect(finished.card!.outcome).toBe(finished.card!.mergedOutcome);
  await page.screenshot({ path: `test-results/EV1-engine-card-merged-${layout(info)}.png`, fullPage: false });
  expect(errors).toEqual([]);
});
