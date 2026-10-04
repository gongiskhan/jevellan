import type { Locator, Page, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ProjectWorkViewSchema, RuntimeListSchema, ThreadViewSchema, type ThreadView } from '../../packages/core/dist/client.js';
import { expect, test } from './fixtures.js';
import { openSidebar } from './navigation.js';

// PJ3 (brief 13) on the --projects fixture servers (scripts/test-server.mjs, design 5.5): a GitHub-shaped project with a
// fake GitHub and scripted coordinator and thread turns; Git, worktrees, the bridge, the ledgers and pull requests are
// real. The journeys build on one fresh server's state in order (the greeting thread's pull request is merged in the
// fourth and the token is removed only in the last), so the file runs serially and stops at the first failure.
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
 * Evidence for one step: transient confirmations are read by the journey first, then dismissed so they never cover the
 * screen; the layout must not scroll sideways. Pages are captured whole, dialogs and panels as the viewport shows them.
 */
async function shot(page: Page, name: string, fullPage = true) {
  const toasts = page.locator('.toast:not(.hub-wait)');
  for (const toast of await toasts.all()) await toast.getByRole('button', { name: 'Dismiss message', exact: true }).click().catch(() => undefined);
  // The pointer rests where the last click landed; a full-page capture grows the viewport, and the row or field that then
  // slides under it would show its hover state (a second "selected" sidebar row). The corner hovers nothing.
  await page.mouse.move(0, 0);
  await expect(toasts).toHaveCount(0);
  // Neither the page nor the side column (a scroll container beside the chat) may scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && [...document.querySelectorAll('.pw-side')].every((side) => side.scrollWidth <= side.clientWidth))).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/PJ3-${name}-${layout(test.info())}.png`, fullPage });
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
  await shot(page, 'empty-chat');

  // The scripted coordinator holds its turn after its first words until the fixture releases it.
  await composer(page).fill('PJ3: add a greeting'); await composer(page).press('Enter');
  await expect(page.locator('.pw-owner').filter({ hasText: 'PJ3: add a greeting' })).toBeVisible();
  const working = page.getByRole('status').filter({ hasText: 'Coordinator is working…' });
  await expect(working).toBeVisible(LONG);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.locator('.pw-chip')).toHaveText('Working…');
  await expect(composer(page)).toHaveValue('');
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
    await shot(page, 'waiting-tab');
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
  await expect(isolation.locator('option')).toHaveText(['Automatic', 'Worktree', 'Main']);
  await expect(isolation.locator('option[value="main"]')).toHaveJSProperty('disabled', true);
  await expect(isolation).toHaveAccessibleDescription('Main isolation is not available yet.');
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
  const transcript = page.locator('[aria-label="Thread transcript"]');
  await expect(transcript.locator('.cursor-tool > summary > span:first-child')).toHaveText(['Read', 'Grep', 'Bash', 'Read'], LONG);
  await expect(page.getByRole('status').filter({ hasText: 'Working on turn 1…' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0);
  await shot(page, 'thread-running');

  // Back on the project page the thread is a Running row with its meta; the sidebar counts it.
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
  await expect(page.getByRole('checkbox', { name: 'Interrupt current turn', exact: true })).toHaveCount(0);
  await expect(message).toHaveValue('');
  await shot(page, 'thread-report');
  expect(errors).toEqual([]);
});

test('PJ3 a pull request merges through the modal and moves to Concluded', async ({ page }, info) => {
  const errors = await begin(page);
  // The greeting thread of the first journey opened pull request #1; new pull requests start with their checks queued.
  await expect.poll(async () => (await work(page)).pullRequests.find((entry) => entry.title === 'Add a greeting')?.pr?.number, LONG).toBe(1);
  const url = (await work(page)).pullRequests.find((entry) => entry.title === 'Add a greeting')!.pr!.url;
  await openProject(page, 'Projects fixture');
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
  await shot(page, 'pull-request-conflict');
  await pullChange({ mergeable: 'clean' }); await pulse();
  await expect(badges).toHaveText(['Checks passing'], LONG);
  await expect(merge).toBeEnabled(); await expect(merge).not.toHaveAttribute('title');
  await shot(page, 'pull-requests');

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

test('PJ3 project settings disable Main for a Leave git to me project', async ({ page }) => {
  const errors = await begin(page);
  await openProject(page, 'Projects external');
  let dialog = await openSettings(page);
  const main = dialog.getByRole('radio', { name: 'Main', exact: true });
  await expect(dialog.getByRole('radio', { name: 'Worktree and pull request', exact: true })).toBeChecked();
  await expect(main).toBeDisabled();
  await expect(main).toHaveAccessibleDescription('This project is set to Leave git to me.');
  await expect(dialog.getByText('This project is set to Leave git to me.', { exact: true })).toBeVisible();
  const model = dialog.getByRole('combobox', { name: 'Coordinator model', exact: true });
  await expect(model).toHaveValue(''); await expect(model.locator('option').first()).toHaveText('Automatic: first available');
  await expect(dialog.getByRole('combobox', { name: 'Coordinator effort', exact: true })).toHaveValue('medium');
  await expect(dialog.getByRole('textbox', { name: 'Worktree setup command', exact: true })).toHaveAttribute('placeholder', 'npm ci');
  const limits = { 'Max running threads': '6', 'Max per device': '4', 'Turn limit per thread': '30' };
  for (const [name, value] of Object.entries(limits)) await expect(dialog.getByRole('spinbutton', { name, exact: true })).toHaveValue(value);
  await shot(page, 'project-settings', false);
  await dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Project settings saved.' })).toBeVisible();
  dialog = await openSettings(page);
  await expect(dialog.getByRole('spinbutton', { name: 'Max running threads', exact: true })).toHaveValue('3');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);

  // A project that may use main still cannot choose it before main isolation exists (phase gate, D88).
  await openProject(page, 'Projects fixture');
  dialog = await openSettings(page);
  await expect(dialog.getByRole('radio', { name: 'Main', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'Main', exact: true })).toHaveAccessibleDescription('Main isolation is not available yet.');
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
    await expect(card.getByText('Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and Checks read on your repositories is enough.', { exact: true })).toBeVisible();
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
