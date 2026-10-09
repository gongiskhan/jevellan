import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { closeConversationSettings, expectClearOfComposer, expectNoStaleJump, openConversationSettings, openDeviceSwitcher, settlement } from './navigation.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AccountListSchema, AccountViewSchema, ContextPanelSchema, ConversationPublicSchema, DeviceRosterSchema, MemorySearchSchema, ProjectsListSchema, RiggingDiskListSchema, RiggingSaveSchema } from '../../packages/core/dist/client.js';

const J8EvidenceSchema = z.strictObject({ schema: z.literal('j8-simulated-v1'), layout: z.string(), transport: z.literal('live-local-http'), devices: z.literal('simulated'), providers: z.literal('simulated'), selection: z.literal('manual'), separateCheckouts: z.literal(true), remoteLoginReadyOnlyOnB: z.literal(true), switchedWithoutSignIn: z.literal(true), ownerStayedOnB: z.literal(true), proxyStreamGrew: z.literal(true), correctionInterruptedB: z.literal(true), automaticChoiceDisabled: z.literal(true), externalSessionVisible: z.literal(true), writingBlockedUntilQuiet: z.literal(true), writingResumedAfterQuiet: z.literal(true) });
const J11EvidenceSchema = z.strictObject({ schema: z.literal('j11-mesh-simulated-v1'), layout: z.string(), devices: z.literal('simulated'), providers: z.literal('simulated'), memory: z.literal('live-basic-memory'), selection: z.literal('manual-search-rank'), compatibilityLinkExcluded: z.literal(true), explicitMemoryPublished: z.literal(true), readOnlyProposalPreservedCheckout: z.literal(true), proposalAppliedByOwner: z.literal(true), alreadyOpenIndexRefreshedAfterPull: z.literal(true), claudeAndCodexReceivedNote: z.literal(true), whyShowsChosenMemory: z.literal(true), contextDraftPreservedFiles: z.literal(true), contextMergePublished: z.literal(true), chosenNote: z.string() });

// The conversation composer stays pinned to the bottom of the screen, so older steps are scrolled to the
// middle of the viewport before they are clicked, as a person would.
function centered(locator: Locator) {
  return { click: async () => { await locator.evaluate((element) => element.scrollIntoView({ block: 'center' })); await locator.click(); } };
}

/**
 * Scrolled up until `behind` sits under the top of the composer's live bar, Jump to latest shows in the bar (the page is more than
 * 160 px from its end, so `behind` must be that far up). The bar sits on the page colour (D318): beside its button it reads the
 * same with the conversation hidden behind it, so no transcript text runs through the bar. While Jump to latest shows, the
 * composer's top padding above the bar is opaque too (a hard edge instead of the fade), so the transcript passes under the
 * footer and never shows between Jump to latest and the content it would seem to cover.
 */
async function expectOpaqueLiveBar(page: Page, behind: Locator) {
  const bar = page.locator('.composer .cursor-live-bar'); const jump = bar.getByRole('button', { name: 'Jump to latest ↓', exact: true });
  await page.evaluate(() => window.scrollTo(0, 0)); await expect(jump).toBeVisible();
  const [target, under] = [(await behind.boundingBox())!, (await bar.boundingBox())!];
  // `behind` goes under the top of the bar, where the composer's fade used to start.
  await page.evaluate((delta) => window.scrollBy(0, delta), target.y + target.height / 2 - (under.y + 4)); await expect(jump).toBeVisible();
  // A transparent probe fixed over the bar beside the button. Capturing the sticky bar itself would first scroll the page to the
  // bar's place in the document, where nothing is behind it and the bar goes away; a fixed element is captured where it is.
  await bar.evaluate((element) => {
    // Whole pixels inside the bar beside its button, and inside the composer's top padding above the bar.
    const box = element.getBoundingClientRect(); const left = Math.ceil(element.querySelector('button')!.getBoundingClientRect().right) + 8; const top = Math.ceil(box.top);
    const composer = element.closest('.composer')!.getBoundingClientRect();
    const add = (id: string, area: { left: number; top: number; width: number; height: number }) => {
      const probe = document.createElement('div'); probe.id = id;
      Object.assign(probe.style, { position: 'fixed', left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px`, pointerEvents: 'none' });
      document.body.append(probe);
    };
    add('live-bar-probe', { left, top, width: Math.floor(box.right) - left, height: Math.floor(box.bottom) - top });
    add('live-bar-edge-probe', { left: Math.ceil(composer.left), top: Math.ceil(composer.top), width: Math.floor(composer.right) - Math.ceil(composer.left), height: Math.floor(box.top) - Math.ceil(composer.top) });
  });
  const probes = page.locator('#live-bar-probe, #live-bar-edge-probe'); const capture = async () => [await probes.nth(0).screenshot({ animations: 'disabled' }), await probes.nth(1).screenshot({ animations: 'disabled' })];
  // Hides everything on the page but the composer, through style properties (the page's policy refuses a style sheet).
  const hide = (hidden: boolean) => page.locator('.conversation-page').evaluate((element, hidden) => {
    (element as HTMLElement).style.visibility = hidden ? 'hidden' : ''; element.querySelector<HTMLElement>('.composer')!.style.visibility = hidden ? 'visible' : '';
  }, hidden);
  const shown = await capture();
  await hide(true); const alone = await capture(); await hide(false); await probes.evaluateAll((elements) => elements.forEach((element) => element.remove()));
  expect(alone[0]!.equals(shown[0]!), 'transcript text shows through the live bar').toBe(true);
  expect(alone[1]!.equals(shown[1]!), 'transcript text shows above the live bar while Jump to latest shows').toBe(true);
}

/**
 * Server work the heaviest journeys wait for (a manual step, accepting reviewed changes, a verified publication, a context change),
 * each in a named step so the report records how long it took.
 */
const serverWork = (title: string, body: () => Promise<unknown>) => test.step(`server work: ${title}`, async () => { await body(); });
/**
 * Budgets for that work and for the journeys that wait on it (D321): the worst duration measured with the journey alone (one
 * worker, four layouts, 2026-10-05, in seconds) times a load margin, rounded up to 5 s and never below the earlier fixed wait.
 * Under the four-worker matrix the four layouts run the same heavy journey at the same time, beside the improver and Projects
 * servers: whole journeys took up to 2.6 times as long as alone, and single waits failed past 3.4 times.
 */
const LOAD_MARGIN = 6;
const budgetMs = (aloneSeconds: number, floorMs: number) => Math.max(floorMs, Math.ceil((aloneSeconds * LOAD_MARGIN) / 5) * 5_000);
const budget = (aloneSeconds: number, floorMs = 30_000) => ({ timeout: budgetMs(aloneSeconds, floorMs) });
/** J11's manual steps alone, by their `serverWork` title. */
const J11_STEPS_ALONE: Record<string, number> = { 'reply with memory': 13.3, review: 9.6, done: 4.8, 'reply on the member': 8.9, 'done on the member': 0.8 };

async function currentProjectPath(page: Page) {
  const roster = DeviceRosterSchema.parse(await (await page.request.get(new URL('/hub/devices/roster', page.url()).href)).json());
  const current = roster.devices.find(row => row.device.id === roster.currentDeviceId)!.device;
  return page.getByRole('dialog').getByRole('textbox', { name: `Path on ${current.name}`, exact: true });
}

test('Codex usage shows a reported weekly window and keeps an absent five-hour window unknown', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const view = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Codex usage fixture' } })).json());
  let weeklyPct = 0;
  await page.route('**/hub/accounts', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); const body = await response.json();
    for (const entry of body.accounts) if (entry.account.id === view.account.id) {
      for (const status of entry.statuses) status.usage = { source: 'probe', observedAt: new Date().toISOString(), weeklyPct, weeklyResetsAt: '2027-05-11T01:46:40.000Z' };
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/settings/runtimes'); const card = page.locator(`#account-${view.account.id}`);
  await expect(card.getByRole('progressbar', { name: 'Week usage', exact: true })).toHaveAttribute('value', '0');
  await expect(card.locator('.usage').filter({ hasText: 'Week' })).toContainText('0%');
  const five = card.locator('.usage').filter({ hasText: 'Five hours' });
  await expect(five).toContainText('Unknown'); await expect(five).not.toContainText('Resets');
  weeklyPct = 37; await page.reload();
  await expect(card.getByRole('progressbar', { name: 'Week usage', exact: true })).toHaveAttribute('value', '37');
  await expect(card.locator('.usage').filter({ hasText: 'Week' })).toContainText('37%');
  await expect(card.locator('.usage').filter({ hasText: 'Week' })).toContainText('Resets');
  await expect(card).toContainText('Usage checked'); await expect(five).toContainText('Unknown');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Settings account, login, Rigging and configuration flows work without horizontal overflow', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const claude = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await claude.getByRole('button', { name: 'Add account', exact: true }).click();
  const form = page.getByRole('dialog'); await form.getByLabel('Label', { exact: true }).fill('Browser fixture'); await form.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('api-key');
  await expect(form.getByLabel('When may Jevellan use this key?')).toHaveValue('');
  const accountCreated = () => page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/hub/accounts', { timeout: 60_000 });
  const secret = `fixture-${randomUUID()}`; await form.getByLabel('API key', { exact: true }).fill(secret); await form.getByLabel('When may Jevellan use this key?').selectOption('never'); const firstAccount = accountCreated(); await form.getByRole('button', { name: 'Add account', exact: true }).click(); expect((await firstAccount).status()).toBe(201);
  await expect(form).not.toBeVisible(); const account = claude.locator('.account').filter({ hasText: 'Browser fixture' }); await expect(account.getByText('Ready', { exact: true })).toBeVisible(); await expect(account).toContainText('Saved'); expect(await page.locator('body').innerText()).not.toContain(secret);
  await claude.getByRole('button', { name: 'Add account', exact: true }).click(); await form.getByLabel('Label', { exact: true }).fill('Login fixture'); await expect(form).toContainText("Anthropic's terms restrict third-party tools"); const secondAccount = accountCreated(); await form.getByRole('button', { name: 'Add account', exact: true }).click(); expect((await secondAccount).status()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Log in · Login fixture' })).toBeVisible(); await form.getByLabel('Authorization code').fill('fixture-approval'); await form.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(form).toContainText('Signed in as fixture@example.test'); await form.getByRole('button', { name: 'Close panel' }).click(); await expect(form).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase1-runtimes-${info.project.name}.png`, fullPage: true });
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Rigging', exact: true }).click();
  await page.getByRole('button', { name: 'Add local item' }).click(); await form.getByLabel('Name', { exact: true }).fill('Fixture skill'); await form.getByRole('textbox', { name: 'Content', exact: true }).fill('## Fixture\nRead the project instructions first.');
  const installed = page.waitForResponse((response) => new URL(response.url()).pathname === '/hub/rigging' && response.request().method() === 'POST', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Add item', exact: true }).click(); const installation = await installed; expect(installation.status()).toBe(201);
  const delivered = RiggingSaveSchema.parse(await installation.json()); expect(delivered.application.accounts.length).toBeGreaterThan(0);
  for (const account of delivered.application.accounts) { expect(account.error).toBeUndefined(); expect(account.results.find((item) => item.itemId === delivered.item.item.id)?.applied).toBe(true); }
  await expect(form).not.toBeVisible();
  await page.getByRole('button', { name: /Fixture skill/ }).click(); await form.getByRole('textbox', { name: 'Content', exact: true }).fill('## Edited fixture\nKeep the source files safe.'); await expect(form.getByRole('status')).toHaveText('Saved', { timeout: 30_000 }); await form.getByRole('button', { name: 'Preview', exact: true }).click(); await expect(form.getByRole('heading', { name: 'Edited fixture' })).toBeVisible(); await form.getByRole('button', { name: 'Close panel' }).click(); await expect(form).not.toBeVisible();
  await expect(page.getByLabel('Safety for Claude Code')).toBeDisabled(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption('claude');
  const memoryToggle = page.getByLabel('Project memory for Claude Code'); await expect(memoryToggle).toBeChecked(); await expect(memoryToggle).toBeEnabled();
  for (const enabled of [false, true]) {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/hub/rigging/builtin_project_memory' && response.request().method() === 'PUT', { timeout: 60_000 });
    await memoryToggle.setChecked(enabled); const response = await saved; expect(response.status()).toBe(200);
    const result = RiggingSaveSchema.parse(await response.json()); expect(result.item.item.runtimes.claude).toBe(enabled);
    for (const account of result.application.accounts) expect(account.error).toBeUndefined();
    await page.reload(); await expect(page.getByLabel('Project memory for Claude Code')).toBeChecked({ checked: enabled });
  }
  await page.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption('');
  await page.screenshot({ path: `docs/acceptance/screenshots/phase1-rigging-${info.project.name}.png`, fullPage: true });
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Configuration', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Revisions' })).toBeVisible(); await page.getByRole('button', { name: 'View YAML', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Current YAML' })).toBeVisible();
  const before = await page.request.get('/hub/config/export'); const yaml = (await before.text()).replace(/pauseAfterPlan: (true|false)/, (_, value) => `pauseAfterPlan: ${value === 'false'}`); await page.getByRole('button', { name: 'Import', exact: true }).click(); await page.getByLabel('YAML', { exact: true }).fill(yaml); await page.getByRole('button', { name: 'Validate and show diff' }).click(); await expect(page.getByText('/x-jevellan/guards/pauseAfterPlan', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Apply import' }).click(); await expect(page.getByRole('status').filter({ hasText: 'Configuration imported.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (info.project.name.startsWith('phone')) { await page.getByRole('button', { name: 'Open navigation' }).click(); await expect(page.getByRole('complementary', { name: 'Conversations' }).getByText('Context · Mesh journey fixture', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Close navigation', exact: true }).click(); }
  const manifest = await page.request.get('/manifest.webmanifest'); expect(manifest.headers()['content-type']).toContain('application/manifest+json'); expect(await manifest.json()).toMatchObject({ name: 'Jevellan', display: 'standalone' });
  const privateCacheEntries = await page.evaluate(async () => { await navigator.serviceWorker.ready; const stores = await caches.keys(); const requests = (await Promise.all(stores.map(async (name) => (await caches.open(name)).keys()))).flat(); return requests.filter((request) => /^\/(?:api|hub)\//.test(new URL(request.url).pathname)).length; }); expect(privateCacheEntries).toBe(0);
  expect(errors).toEqual([]);
});

test('Projects and a manual planned change render the full plan, stream, Why and verified Changes', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Conversation fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  const config = await (await page.request.get('/hub/config')).json(); config.configuration['x-jevellan'].guards.pauseAfterPlan = true;
  config.configuration['x-jevellan'].improver.memory.enabled = false;
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: config.revision, configuration: config.configuration } })).ok()).toBe(true);
  const projects = await (await page.request.get('/hub/projects')).json(); const original = projects.projects.find((entry: { project: { id: string } }) => entry.project.id === 'browser_fixture').project; const path = Object.values(original.paths)[0] as string;
  await page.goto('/settings/projects'); await page.getByRole('button', { name: 'Add project', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Manual conversation fixture'); await (await currentProjectPath(page)).fill(path); await dialog.getByLabel('Test command').fill(original.testCommand); await dialog.getByRole('button', { name: 'Save project' }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manual conversation fixture' })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const projectCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Manual conversation fixture' }) });
  await projectCard.getByRole('button', { name: 'Context', exact: true }).click(); await dialog.getByText('Current instruction files', { exact: true }).click(); await expect(dialog).toContainText('Preserve the request and its tests.'); await dialog.getByRole('button', { name: 'Close panel' }).click();
  await projectCard.getByRole('button', { name: 'Browse memory', exact: true }).click(); await dialog.getByLabel('Search memory').fill('fixture'); await dialog.getByRole('button', { name: 'Search', exact: true }).click(); await expect(dialog).toContainText('No matching notes.'); await dialog.getByRole('button', { name: 'Close panel' }).click();
  const projectSaved = page.locator('.toast.success').filter({ hasText: 'Project saved.' });
  for (const toast of await projectSaved.all()) await toast.getByRole('button', { name: 'Dismiss message', exact: true }).click().catch(() => undefined);
  await expect(projectSaved).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-projects-${info.project.name}.png`, fullPage: true });
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Manual conversation fixture' }); await page.getByPlaceholder('What should we build or fix?').fill('Change the value to two and verify it.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Change the value to two and verify it.' })).toBeVisible();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('plan'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The full fixture plan' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible();
  await expectNoStaleJump(page, page.locator('.plan-waiting'));
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-plan-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click(); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 2 · Implement' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  const implementation = page.locator('.stretch-block').filter({ has: page.getByRole('heading', { name: 'Step 2 · Implement' }) });
  await implementation.getByRole('button', { name: 'Why', exact: true }).click(); await expect(dialog).toContainText('This step was picked manually.'); await expect(dialog).toContainText('Account'); await dialog.getByRole('button', { name: 'Close panel' }).click();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Step 2 · Implement' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'The full fixture plan' })).toBeVisible();
  const settings = await openConversationSettings(page); await settings.getByRole('button', { name: 'Close this work', exact: true }).click(); await settlement(page).getByRole('button', { name: 'Keep them', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Settle kept changes', exact: true })).toBeVisible(); await expect(picker).not.toBeVisible();
  await page.reload(); await (await openConversationSettings(page)).getByRole('button', { name: 'Settle kept changes', exact: true }).click();
  await expect(settlement(page)).toContainText('The checkout stays reserved'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-settlement-${info.project.name}.png` });
  await settlement(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Work closed and published.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 30_000 }); await closeConversationSettings(page);
  await implementation.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(dialog).toContainText('+2'); await expect(dialog).toContainText('Jevellan verification'); await expect(dialog).toContainText('Passed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-changes-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Close panel' }).click(); await expect(page.locator('.conversation-row.selected')).toContainText('Done'); await expectOpaqueLiveBar(page, implementation.getByText('The value is now 2, ready for Jevellan verification.', { exact: true })); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-conversation-${info.project.name}.png`, fullPage: true });
  const id = new URL(page.url()).pathname.split('/')[2]!; const view = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(view.conversation.state).toBe('done'); expect(view.stretches).toHaveLength(2); expect(errors).toEqual([]);
  expect(view.closedWorks[0].closedAs).toBe('closed-by-you'); expect(view.settlements.map((entry: { choice: string; status: string }) => [entry.choice, entry.status])).toEqual([['keep', 'completed'], ['publish', 'completed']]);
});

test('kept checkpoints can be discarded after reload through the confirmation panel', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Discard fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('browser_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Change the value to three, then let me settle this work.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/')[2]!; const before = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(before.stretches[0].gitAfter).not.toBe(before.stretches[0].gitBefore);
  const settings = await openConversationSettings(page); const dialog = settlement(page); await settings.getByRole('button', { name: 'Close this work', exact: true }).click(); await dialog.getByRole('button', { name: 'Keep them', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Settle kept changes', exact: true })).toBeVisible(); await page.reload(); await (await openConversationSettings(page)).getByRole('button', { name: 'Settle kept changes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard…', exact: true }).click(); await expect(dialog).toContainText('A recovery ref is saved first.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-discard-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Discard checkpoints', exact: true }).click(); await expect(page.getByText(/Work discarded\. Its checkpoints are saved at/)).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByRole('button', { name: 'Settle kept changes', exact: true })).not.toBeVisible(); await closeConversationSettings(page);
  const after = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(after.settlements.at(-1)).toMatchObject({ status: 'completed', choice: 'discard', retained: false }); expect(after.settlements.at(-1).savedRef).toContain('refs/jevellan/discard/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Explain the restored value.'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(picker).toBeVisible();
  const next = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(next.conversation.work.request).toBe('Explain the restored value.'); expect(next.conversation.work.id).not.toBe(before.conversation.work.id); expect(errors).toEqual([]);
});

test('step corrections survive reload and undo launches the requested redo with visible history', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Correction fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('browser_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Change the value to three, then redo this step.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/')[2]!; const before = await (await page.request.get(`/api/conversations/${id}`)).json();
  const dialog = page.getByRole('dialog'); await page.getByRole('button', { name: 'Change step 1', exact: true }).click(); await dialog.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('max'); await dialog.getByRole('button', { name: 'Just override', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(page.getByText('corrected: effort → max', { exact: true })).toBeVisible(); await page.reload();
  await page.getByRole('button', { name: 'Change step 1', exact: true }).click(); await dialog.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reply'); await dialog.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low'); await dialog.getByRole('button', { name: 'Override and undo', exact: true }).click();
  await expect(dialog).toContainText('Anything outside the repository'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-undo-confirm-${info.project.name}.png` });
  const accounts = AccountListSchema.parse(await (await page.request.get('/hub/accounts')).json()).accounts.filter((entry) => entry.account.runtime === 'claude' && entry.account.enabled);
  expect(accounts.length).toBeGreaterThan(0);
  for (const entry of accounts) {
    const updated = await page.request.patch(`/hub/accounts/${entry.account.id}`, { data: { schema: 'update-account-v1', revision: entry.revision, label: entry.account.label, enabled: false, ceilingPct: entry.account.ceilingPct, ...(entry.account.paidUse ? { paidUse: entry.account.paidUse } : {}) } });
    expect(updated.ok(), await updated.text()).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Undo and redo', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry undo and redo', exact: true })).toBeVisible({ timeout: 30_000 });
  const blocked = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(blocked.stretches.map((step: { status: string }) => step.status)).toEqual(['undone']); expect(blocked.redos.at(-1)).toMatchObject({ status: 'blocked' });
  await page.reload(); await expect(page.getByRole('button', { name: 'Retry undo and redo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry undo and redo', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-undo-retry-${info.project.name}.png` });
  await page.getByRole('button', { name: 'Retry undo and redo', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/conversations/${id}`)).json()).redos.at(-1).retries.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Retry undo and redo', exact: true })).toBeVisible();
  const disabled = AccountListSchema.parse(await (await page.request.get('/hub/accounts')).json()).accounts.filter((entry) => accounts.some((original) => original.account.id === entry.account.id));
  for (const entry of disabled) {
    const updated = await page.request.patch(`/hub/accounts/${entry.account.id}`, { data: { schema: 'update-account-v1', revision: entry.revision, label: entry.account.label, enabled: true, ceilingPct: entry.account.ceilingPct, ...(entry.account.paidUse ? { paidUse: entry.account.paidUse } : {}) } });
    expect(updated.ok(), await updated.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Retry undo and redo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 2 · Reply' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 }); await expect(page.locator('.stretch-block.undone')).toContainText('Undone');
  await page.reload(); await expect(page.getByRole('heading', { name: 'Step 2 · Reply' })).toBeVisible();
  const after = await (await page.request.get(`/api/conversations/${id}`)).json(); expect(after.redos.at(-1)).toMatchObject({ status: 'completed', plan: { mode: 'reset', target: before.stretches[0].gitBefore } });
  expect(after.redos.at(-1).retries).toHaveLength(2); expect(after.redos.at(-1).id).toBe(blocked.redos.at(-1).id);
  expect(after.stretches.map((step: { status: string }) => step.status)).toEqual(['undone', 'completed']); expect(after.overrides.map((entry: { request: { mode: string } }) => entry.request.mode)).toEqual(['noted', 'redo']);
  expect(after.decisions.at(-1)).toMatchObject({ trigger: 'redo', action: { source: 'redo', chosen: 'reply' }, effort: { requested: 'low' } });
  await (await openConversationSettings(page)).getByRole('button', { name: 'Close this work', exact: true }).click(); await settlement(page).getByRole('button', { name: 'Keep them', exact: true }).click(); await expect(settlement(page)).not.toBeVisible();
  await closeConversationSettings(page); await expect(dialog).not.toBeVisible();
  await expect(page.locator('.conversation-meta')).toContainText('Done'); await expect(page.getByRole('button', { name: 'Cancel', exact: true })).not.toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-undo-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});

test('blocked files can be reviewed, refreshed and accepted before verified publication', async ({ page }, info) => {
  test.setTimeout(budgetMs(26.2, 120_000));
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Checkpoint recovery fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('adoption_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Exercise reviewed checkpoint recovery with a simulated read-only violation.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reply'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await serverWork('blocked step', () => expect(page.getByRole('heading', { name: 'Changes need your review' })).toBeVisible(budget(3.3))); await expect(picker).not.toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog'); await serverWork('blocked changes', () => expect(dialog).toContainText('+2', budget(3.8, 15_000))); await expect(dialog).toContainText('+Accept this new file after reviewing it.'); await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  const id = new URL(page.url()).pathname.split('/')[2]!;
  expect((await page.request.post(`/api/conversations/${id}/messages`, { data: { schema: 'conversation-message-v1', clientMessageId: `review_context_${randomUUID()}`, text: 'Keep the reviewed changes.' } })).ok()).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled(); await dialog.getByRole('button', { name: 'Refresh changes', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-adoption-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(dialog).not.toBeVisible(); await serverWork('accepted changes', () => expect(picker).toBeVisible(budget(9.4))); await expect(page.getByRole('heading', { name: 'Changes need your review' })).not.toBeVisible();
  // The accepted step ended at a blocked checkpoint, so it does not answer the request and Done is not offered (1f63214); the owner closes the work.
  await (await openConversationSettings(page)).getByRole('button', { name: 'Close this work', exact: true }).click(); await settlement(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await serverWork('publication', async () => { await expect(page.getByText('Work closed and published.', { exact: true })).toBeVisible(budget(2.8)); await expect(page.locator('.conversation-meta')).toContainText('Done', budget(2.8)); }); await closeConversationSettings(page);
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(dialog).toContainText('Passed'); await expect(dialog).toContainText('review-note.txt'); expect(errors).toEqual([]);
});

test('undo from the last closed work includes newer work and preserves both requests after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Undo across works fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('undo_following');
  const originalRequest = 'Change the value to two and publish the first work.';
  await page.getByPlaceholder('What should we build or fix?').fill(originalRequest); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); const id = new URL(page.url()).pathname.split('/')[2]!;
  const read = async () => ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('done'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 30_000 }); const closed = (await read()).closedWorks.at(-1)!;
  const newerRequest = 'Now change the value to three. Keep this newer request in the conversation.';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(newerRequest); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(picker).toBeVisible(); const following = (await read()).conversation.work!; expect(following.id).not.toBe(closed.id);
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 2 · Implement' })).toBeVisible(); await expect(picker).toBeVisible({ timeout: 30_000 });
  const dialog = page.getByRole('dialog'); await page.getByRole('button', { name: 'Change step 1', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reply'); await dialog.getByRole('button', { name: 'Override and undo', exact: true }).click();
  await expect(dialog).toContainText('This also undoes the newer open work. Its request and notes stay with the reopened work.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-undo-following-confirm-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Undo and redo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 3 · Reply' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 }); await page.reload();
  const view = await read(); expect(view.redos.at(-1)).toMatchObject({ status: 'completed', followingWorkId: following.id, plan: { mode: 'revert' } });
  expect(view.stretches.map((step) => step.status)).toEqual(['undone', 'undone', 'completed']); expect(view.conversation.work).toMatchObject({ id: closed.id, request: originalRequest });
  expect(view.closedWorks).toEqual([expect.objectContaining({ id: following.id, request: newerRequest, closedAs: 'cancelled' })]);
  await expect(page.locator('.stretch-block.undone')).toHaveCount(2); await expect(page.locator('.user-message').getByText(originalRequest, { exact: true })).toBeVisible(); await expect(page.locator('.user-message').getByText(newerRequest, { exact: true })).toBeVisible();
  await expect(page.locator('.stretch-block').filter({ has: page.getByRole('heading', { name: 'Step 3 · Reply' }) }).locator('.step-transcript')).toContainText('The plan has three steps.');
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-undo-following-${info.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('done'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 30_000 });
});

test('context merge is drafted read-only, survives reload, cancels and applies through verified publication', async ({ page }, info) => {
  test.setTimeout(budgetMs(33.7, 120_000));
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Context fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Add project', exact: true }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Create AGENTS.md if no instruction file exists')).toBeChecked(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Context fixture', exact: true }) }); await expect(card).toContainText('Context needs a decision'); await card.getByRole('button', { name: 'Context', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Keep AGENTS.md and link CLAUDE.md to it', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep CLAUDE.md and link AGENTS.md to it', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Leave both as they are', exact: true })).toBeVisible();
  const read = async () => ContextPanelSchema.parse(await (await page.request.get('/api/projects/context_fixture/context/operations')).json()); const before = await read();
  await dialog.getByRole('button', { name: 'Merge them into AGENTS.md', exact: true }).click(); await serverWork('context draft', () => expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeVisible(budget(3.9)));
  let current = await read(); expect(current.context.fingerprint).toBe(before.context.fingerprint); expect(current.operations.at(-1)).toMatchObject({ status: 'draft-ready', applied: false });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toContainText('Context change cancelled.'); expect((await read()).context.fingerprint).toBe(before.context.fingerprint);
  await dialog.getByRole('button', { name: 'Merge them into AGENTS.md', exact: true }).click(); await serverWork('context draft again', () => expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeVisible(budget(2.8)));
  await page.reload(); await card.getByRole('button', { name: 'Context', exact: true }).click(); await expect(dialog).toContainText('Shared project instructions'); await expect(dialog).toContainText('Symlink → AGENTS.md');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-context-draft-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await serverWork('context apply', () => expect(dialog).toContainText('Context change completed.', budget(11.9))); await expect(dialog).toContainText('Linked: CLAUDE.md → AGENTS.md');
  current = await read(); const record = current.operations.at(-1)!; expect(record).toMatchObject({ status: 'completed', approved: true, applied: true }); expect(record.commit).toBeTruthy(); expect(current.context.files[0].content).toBe(record.draft); expect(current.context.files[1]).toMatchObject({ kind: 'link', target: 'AGENTS.md' });
  const work = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${record.conversationId}`)).json()); expect(work.conversation).toMatchObject({ state: 'done', work: null });
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-context-linked-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Open work', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Context · Context fixture', exact: true })).toBeVisible();
  await page.goto('/settings/projects'); await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const projects = await (await page.request.get('/hub/projects')).json(); const empty = projects.projects.find((entry: { project: { id: string } }) => entry.project.id === 'create_fixture').project;
  await dialog.getByLabel('Name', { exact: true }).fill('Created instructions fixture'); await (await currentProjectPath(page)).fill(Object.values(empty.paths)[0] as string); await dialog.getByLabel('Test command', { exact: true }).fill('test -f AGENTS.md');
  await expect(dialog.getByLabel('Create AGENTS.md if no instruction file exists')).toBeChecked(); await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); await expect(dialog).not.toBeVisible();
  const createdCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Created instructions fixture', exact: true }) }); await createdCard.getByRole('button', { name: 'Context', exact: true }).click();
  await serverWork('context created', () => expect(dialog).toContainText('Context change completed.', budget(11.4))); await expect(dialog).toContainText('Linked: CLAUDE.md → AGENTS.md'); await dialog.getByText('Current instruction files', { exact: true }).click();
  await expect(dialog).toContainText('Run tests with'); await expect(dialog).toContainText('Project memory lives in .jevellan/memory'); expect(errors).toEqual([]);
});

test('conversation titles, expanded tools and outside outcomes survive updates and reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Conversation controls fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('undo_following');
  const original = 'Prepare the change before I finish the remaining work in my editor.';
  await page.getByPlaceholder('What should we build or fix?').fill(original); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); const id = new URL(page.url()).pathname.split('/')[2]!;
  const read = async () => ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  const generation = (await read()).conversation.generation; const dialog = page.getByRole('dialog'); const title = `A conversation with a long title · ${'Unbroken_title_'.repeat(11)}`;
  await page.getByLabel('Conversation menu', { exact: true }).click(); const menuBounds = await page.locator('.conversation-menu > div').evaluate((element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth }; }); expect(menuBounds.left).toBeGreaterThanOrEqual(0); expect(menuBounds.right).toBeLessThanOrEqual(menuBounds.width); await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await dialog.getByLabel('Title', { exact: true }).fill(title); await dialog.getByRole('button', { name: 'Save title', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible(); await expect(page.locator('.conversation-row.selected')).toContainText(title); expect((await read()).conversation.generation).toBe(generation);
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  const tool = page.locator('.step-transcript .cursor-tool').first(); await expect(tool).toContainText('The fixture starts with value 1.'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const edges = await tool.evaluate((element) => ['.cursor-tool-header', 'pre'].map((selector) => { const box = element.querySelector(selector)!.getBoundingClientRect(); return { left: box.left, right: box.right }; })); expect(edges[0]).toEqual(edges[1]);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-controls-title-${info.project.name}.png`, fullPage: true });
  await page.locator('.conversation-heading h1 .conversation-title').click(); await dialog.getByLabel('Title', { exact: true }).fill('Finished in my editor'); await dialog.getByRole('button', { name: 'Save title', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(tool.locator('summary')).toHaveCount(0); await expect(tool.getByText('The fixture starts with value 1.', { exact: true })).toBeVisible(); await expect(page.locator('.conversation-row.selected')).toContainText('Finished in my editor');
  await page.getByLabel('Conversation menu', { exact: true }).click(); await page.getByRole('button', { name: 'Finished outside Jevellan', exact: true }).click();
  const reason = 'I wanted to complete the last details in my editor.'; await dialog.getByLabel('What made you finish elsewhere?').fill(reason); await expect(dialog).toContainText('Optional');
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-controls-finish-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Mark finished', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect((await openConversationSettings(page)).getByRole('button', { name: 'Settle kept changes', exact: true })).toBeVisible(); await expect(picker).not.toBeVisible(); await page.reload();
  await expect(page.getByRole('heading', { name: 'Finished in my editor', exact: true })).toBeVisible(); await expect(page.locator('section.notice')).toContainText(reason);
  const finished = await read(); expect(finished.conversation).toMatchObject({ state: 'done', work: null, outcome: { kind: 'finished-elsewhere', reason } }); expect(finished.finishes[0]).toMatchObject({ status: 'completed', retained: true }); expect(finished.closedWorks[0]?.request).toBe(original);
  await expect(page.locator('.stretch-block').first()).toContainText('The value is now 2'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-controls-outcome-${info.project.name}.png`, fullPage: true });
  const settings = await openConversationSettings(page); await settings.getByRole('button', { name: 'Settle kept changes', exact: true }).click(); const settle = settlement(page);
  if (info.project.name.startsWith('desktop')) await settle.getByRole('button', { name: 'Publish', exact: true }).click();
  else { await settle.getByRole('button', { name: 'Discard…', exact: true }).click(); await settle.getByRole('button', { name: 'Discard checkpoints', exact: true }).click(); }
  await expect(settle).not.toBeVisible(); await expect(settings.getByRole('button', { name: 'Settle kept changes', exact: true })).not.toBeVisible({ timeout: 30_000 }); await closeConversationSettings(page); expect((await read()).conversation.outcome).toEqual(finished.conversation.outcome);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A fresh request after finishing elsewhere.'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(picker).toBeVisible(); expect((await read()).conversation.outcome).toBeUndefined();
  await page.getByLabel('Conversation menu', { exact: true }).click(); await page.getByRole('button', { name: 'Finished outside Jevellan', exact: true }).click(); await dialog.getByRole('button', { name: 'Mark finished', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect((await read()).conversation.outcome?.reason).toBeUndefined(); expect(errors).toEqual([]);
});
test('file and evidence links show recorded versions, source lines, Markdown, images and verification output', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Evidence fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(account.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('undo_following'); await page.getByPlaceholder('What should we build or fix?').fill('Exercise evidence navigation with two saved versions.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); const id = new URL(page.url()).pathname.split('/')[2]!;
  for (const n of [1, 2]) { await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByRole('heading', { name: `Step ${n} · Implement` })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 }); }
  const first = page.locator('.stretch-block').first(); const panel = page.getByRole('dialog').last();
  // Moving to a step's controls while Jump to latest shows (scrolled up in a short window), or with a long draft in the composer,
  // brings them above the composer, never under it or its live bar.
  await expectClearOfComposer(page, page.locator('.stretch-block').nth(1).getByRole('button', { name: /^Changes/ }).first());
  await first.locator('.step-details > summary').click();
  // A source line opens in the panel (beside the conversation on desktops), which centers the line in its own scroll box and
  // never scrolls the conversation up: that left Jump to latest showing and a step's controls under the composer.
  const finding = first.locator('.findings').getByRole('button', { name: 'src/example.ts:2', exact: true }); await finding.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const view = window as Window & { scrolledUp?: boolean }; let top = scrollY; view.scrolledUp = false;
    addEventListener('scroll', () => { if (scrollY < top - 1) view.scrolledUp = true; top = scrollY; }, { passive: true });
  });
  await finding.click(); await expect(panel).toContainText('Recorded checkpoint'); await expect(panel.locator('.selected-line')).toBeInViewport();
  expect(await page.evaluate(() => (window as Window & { scrolledUp?: boolean }).scrolledUp), 'opening a source line scrolled the conversation up').toBe(false); await expect(panel.locator('.selected-line')).toContainText('export const amount = 2;'); await expect(panel.locator('.line-number')).toHaveCount(4); await expect(panel).toContainText('<b>plain text</b>');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-evidence-source-${info.project.name}.png` });
  await panel.getByRole('button', { name: 'Open working copy', exact: true }).click(); await expect(panel).toContainText('Current working copy · not a saved step'); await expect(panel.locator('.selected-line')).toContainText('export const amount = 3;'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await first.getByRole('button', { name: 'the value', exact: true }).click(); await expect(panel.locator('.selected-line')).toContainText('2'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await first.getByRole('button', { name: 'the source', exact: true }).click(); await expect(panel.locator('.selected-line')).toContainText('amount = 2'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await first.getByRole('button', { name: 'docs/Guide with spaces.md', exact: true }).click(); await expect(panel.getByRole('heading', { name: 'Evidence guide', exact: true })).toBeVisible(); await expect(panel.locator('.markdown li')).toHaveCount(2); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-evidence-markdown-${info.project.name}.png` });
  await panel.getByRole('button', { name: 'Source line', exact: true }).click(); await expect(panel.locator('.selected-line')).toContainText('amount = 2'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await first.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(panel.getByLabel('Changed files')).toContainText('src/example.ts'); await panel.getByRole('button', { name: 'screen.png', exact: true }).last().click(); await expect(panel.locator('img')).toBeVisible(); await expect.poll(() => panel.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(96); await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // Following the end removes Jump to latest and shrinks the composer; capture after that scroll adjustment.
  await expect(page.locator('.composer .jump-latest')).toBeHidden();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-evidence-image-${info.project.name}.png` }); await panel.getByRole('button', { name: 'Close panel', exact: true }).click(); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await first.locator('.tool-file').getByRole('button', { name: 'value.txt', exact: true }).click(); await expect(panel.getByLabel('File contents')).toContainText('2'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('done'); await picker.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(picker).not.toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/conversations/${id}`)).json()).conversation.state, { timeout: 30_000 }).toBe('done');
  await first.getByRole('button', { name: 'Changes', exact: true }).click(); await panel.getByRole('button', { name: 'Read output', exact: true }).last().click(); await expect(panel.getByRole('heading', { name: 'Verification output', exact: true })).toBeVisible(); await expect(panel.locator('.evidence-output')).toBeVisible(); await panel.getByRole('button', { name: 'Close panel', exact: true }).click(); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.reload(); await expect(page.locator('.findings').first()).toContainText('The amount is declared on line two.'); expect(errors).toEqual([]);
});

test('public project memory shows its notice, note update time and read-only rendered content', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible(); await page.goto('/settings/projects');
  const notice = 'This repository is public. Memory committed here is public too.';
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Public memory fixture', exact: true }) });
  await expect(card.getByText(notice, { exact: true })).toBeVisible();
  const unknown = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Browser fixture', exact: true }) });
  await expect(unknown.locator('.public-memory-notice')).toHaveCount(0);
  await card.getByRole('button', { name: 'Edit', exact: true }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(notice, { exact: true })).toBeVisible();
  await dialog.getByLabel('Keep project memory').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-memory-settings-${info.project.name}.png` });
  const path = await currentProjectPath(page); await path.fill(`${await path.inputValue()}-changed`); await expect(dialog.locator('.public-memory-notice')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Browse memory', exact: true }).click(); await dialog.getByLabel('Search memory').fill('memorybrowserfixture'); await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const note = dialog.locator('.memory-result').filter({ hasText: 'Public memory guide' }); await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note.locator('time')).toHaveAttribute('datetime', '2026-09-20T12:00:00.000Z'); await note.click();
  await expect(dialog.getByRole('heading', { name: 'Public memory guide', exact: true }).last()).toBeVisible();
  await expect(dialog.locator('.markdown strong')).toHaveText('project knowledge'); await expect(dialog.locator('.markdown li')).toHaveCount(2);
  await expect(dialog.locator('time')).toHaveCount(2); await expect(dialog.locator('time').last()).toHaveAttribute('datetime', '2026-09-20T12:00:00.000Z');
  await expect(dialog.getByRole('textbox')).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-memory-viewer-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); await page.reload(); await expect(card.getByText(notice, { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('Why lists recalled project memory and its selection source after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Memory recall fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('memory_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Explain the memorybrowserfixture project knowledge.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reply');
  const started = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/manual'));
  await picker.getByRole('button', { name: 'Continue', exact: true }).click(); expect((await started).status()).toBe(202);
  await expect(page.getByRole('heading', { name: 'Step 1 · Reply', exact: true })).toBeVisible({ timeout: 30_000 }); await expect(picker).toBeVisible({ timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/')[2]!; const view = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  const memory = view.decisions[0]!.memory!; expect(memory.source).toBe('search-rank'); expect(memory.chosen).toContain('Guide.md');
  for (let round = 0; round < 2; round++) {
    if (round) await page.reload(); await page.getByRole('button', { name: 'Why', exact: true }).first().click(); const dialog = page.getByRole('dialog');
    const selection = dialog.getByRole('region', { name: 'Memory selection' }); await expect(selection).toContainText('Selected by search rank.');
    const chosen = selection.getByRole('list', { name: 'Chosen memory' }); for (const note of memory.chosen) await expect(chosen.getByRole('listitem').filter({ hasText: note })).toBeVisible();
    await selection.getByText(`Candidates (${memory.candidates.length})`, { exact: true }).click(); const candidates = selection.getByRole('list', { name: 'Memory candidates' });
    for (const note of memory.candidates) await expect(candidates.getByRole('listitem').filter({ hasText: note })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); if (round) await page.screenshot({ path: `docs/acceptance/screenshots/phase2-memory-why-${info.project.name}.png` });
    await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test('loose Rigging autosaves, rejects stale edits, parks bundles and restores them across reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const project = projects.projects.find((view) => view.project.id === 'browser_fixture')!.project;
  const fixtureRoot = dirname(Object.values(project.paths)[0]!); const home = join(fixtureRoot, 'user/.jevellan/homes/claude/acc_rigging_claude');
  await page.goto('/settings/rigging'); const dialog = page.getByRole('dialog');
  const pending = page.locator('.rigging-pending').filter({ hasText: 'rules/retry.md' }); await expect(pending).toBeVisible(); await pending.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(pending).toHaveCount(0);
  const loose = page.locator('.rigging-disk-row[data-state="loose"]').filter({ hasText: 'browser-local' }); const parked = page.locator('.rigging-disk-row[data-state="parked"]').filter({ hasText: 'browser-local' });
  await expect(loose).toContainText('Rigging local fixture'); await loose.getByRole('button', { name: /^browser-local/ }).click(); await expect(dialog.getByRole('textbox', { name: 'Content', exact: true })).toHaveValue(/Loose browser instructions/);
  const inventory = RiggingDiskListSchema.parse(await (await page.request.get('/api/rigging/homes')).json()); const item = inventory.items.find((entry) => entry.accountId === 'acc_rigging_claude' && entry.name === 'browser-local')!;
  const outside = await page.request.put(`/api/rigging/homes/claude/${item.accountId}/${item.id}`, { data: { schema: 'rigging-disk-write-v1', fingerprint: item.fingerprint, content: '# New outside instructions\nKeep this newer copy.\n' } }); expect(outside.status()).toBe(200);
  await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('Stale UI draft.'); await expect(dialog.locator('.save-status')).toHaveText('Not saved'); expect(readFileSync(join(home, 'skills/browser-local/SKILL.md'), 'utf8')).toContain('New outside instructions');
  await dialog.getByRole('button', { name: 'Discard draft and reload', exact: true }).click(); await expect(dialog.getByRole('textbox', { name: 'Content', exact: true })).toHaveValue(/New outside instructions/);
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname.includes('/api/rigging/homes/'));
  await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('# Edited local instructions\nPreserve the complete bundle.\n'); expect((await saved).status()).toBe(200); await expect(dialog.locator('.save-status')).toHaveText('Saved'); await dialog.getByRole('button', { name: 'Preview', exact: true }).click(); await expect(dialog.getByRole('heading', { name: 'Edited local instructions', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-rigging-local-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await loose.getByRole('button', { name: 'Park', exact: true }).click(); await expect(parked).toBeVisible(); await expect(loose).toHaveCount(0); await page.reload(); await expect(parked).toContainText('Parked');
  await parked.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-rigging-parked-${info.project.name}.png` });
  await parked.getByRole('button', { name: 'Restore locally', exact: true }).click(); await expect(loose).toBeVisible(); expect(readFileSync(join(home, 'skills/browser-local/SKILL.md'), 'utf8')).toContain('Edited local instructions'); expect(readFileSync(join(home, 'skills/browser-local/assets/example.txt'), 'utf8')).toBe('Bundled fixture stays unchanged.\n');
  const packageRow = page.locator('.rigging-disk-row').filter({ hasText: 'browser-package' }); await packageRow.getByRole('button', { name: /^browser-package/ }).click(); await expect(dialog.locator('.save-status')).toHaveText('Read-only'); await expect(dialog.getByRole('textbox')).toHaveCount(0); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption('codex'); await expect(loose).toHaveCount(0);
  const server = page.locator('.rigging-disk-row').filter({ hasText: 'fixture_tools' }); await server.getByRole('button', { name: /^fixture_tools/ }).click();
  await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('{"command":"updated-fixture-tools","args":["one"]}'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect(readFileSync(join(fixtureRoot, 'user/.jevellan/homes/codex/acc_rigging_codex/config.toml'), 'utf8')).toContain('model_reasoning_effort = "high"');
  await server.getByRole('button', { name: /^fixture_tools/ }).click(); await expect(dialog.getByRole('textbox', { name: 'Content', exact: true })).toHaveValue(/updated-fixture-tools/); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-rigging-mcp-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); expect(errors).toEqual([]);
});

test('loose Rigging becomes managed with bundled files, durable retry and runtime toggles', async ({ page }, info) => {
  // Promotion, autosave and both runtime toggles each allow up to 60 seconds for APM materialization.
  test.setTimeout(240_000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const fixtureRoot = dirname(Object.values(projects.projects.find((view) => view.project.id === 'browser_fixture')!.project.paths)[0]!);
  const accountHome = (runtime: string) => join(fixtureRoot, `user/.jevellan/homes/${runtime}/acc_rigging_${runtime}`);
  await page.goto('/settings/rigging'); const loose = page.locator('.rigging-disk-row[data-state="loose"]').filter({ hasText: 'browser-promote' }); const dialog = page.getByRole('dialog');
  await loose.getByRole('button', { name: 'Make managed', exact: true }).click(); await expect(dialog).toContainText('All 2 files'); await dialog.getByLabel('Name', { exact: true }).fill('Managed browser bundle'); await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase2-rigging-promote-${info.project.name}.png` });
  const saving = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/promote'), { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Make managed', exact: true }).click(); const response = await saving; expect(response.status()).toBe(200); const result = RiggingSaveSchema.parse(await response.json());
  expect(result.application.accounts.every((account) => !account.error)).toBe(true); expect(result.item.item.bundle?.fileCount).toBe(1); await expect(dialog).not.toBeVisible(); await expect(loose).toHaveCount(0);
  for (const runtime of ['claude', 'codex']) expect(readFileSync(join(accountHome(runtime), 'skills/browser-promote/assets/example.txt'), 'utf8')).toBe('Captured fixture stays unchanged.\n');
  const managed = page.locator('.rigging-row').filter({ has: page.getByRole('button', { name: /^Managed browser bundle/ }) }); await managed.getByRole('button', { name: /^Managed browser bundle/ }).click(); await expect(dialog).toContainText('1 bundled file is retained');
  await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('# Managed instructions\nKeep the bundled example.\n'); await expect(dialog.locator('.save-status')).toHaveText('Saved', { timeout: 60_000 });
  await page.screenshot({ path: `docs/acceptance/screenshots/phase2-rigging-managed-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  const requestId = JSON.parse(response.request().postData()!).requestId as string; const journal = join(fixtureRoot, `user/.jevellan/rigging/promotions/claude/acc_rigging_claude/${requestId}.json`); const record = JSON.parse(readFileSync(journal, 'utf8')); writeFileSync(journal, JSON.stringify({ ...record, status: 'prepared' }));
  await page.reload(); const pending = page.locator('.rigging-pending').filter({ hasText: 'Managed browser bundle' }); await expect(pending).toBeVisible();
  const retrying = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/promote'), { timeout: 60_000 });
  await pending.getByRole('button', { name: 'Retry', exact: true }).click(); const retried = await retrying; expect(retried.status()).toBe(200); expect(RiggingSaveSchema.parse(await retried.json()).item.item.content).toContain('Managed instructions'); await expect(pending).toHaveCount(0);
  expect(readFileSync(join(accountHome('claude'), 'skills/browser-promote/SKILL.md'), 'utf8')).toContain('Managed instructions');
  for (const enabled of [false, true]) {
    const toggling = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/hub/rigging/${result.item.item.id}`, { timeout: 60_000 });
    await managed.getByRole('checkbox', { name: 'Managed browser bundle for Claude Code', exact: true }).setChecked(enabled); const applied = RiggingSaveSchema.parse(await (await toggling).json()); expect(applied.application.accounts.every((account) => !account.error)).toBe(true);
    expect(existsSync(join(accountHome('claude'), 'skills/browser-promote'))).toBe(enabled); expect(readFileSync(join(accountHome('codex'), 'skills/browser-promote/assets/example.txt'), 'utf8')).toBe('Captured fixture stays unchanged.\n');
    await page.reload(); await expect(page.getByRole('checkbox', { name: 'Managed browser bundle for Claude Code', exact: true })).toBeChecked({ checked: enabled });
  }
  expect(readFileSync(join(accountHome('claude'), 'skills/browser-promote/assets/example.txt'), 'utf8')).toBe('Captured fixture stays unchanged.\n'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});

test('automatic decisions can resume from missing configuration and explain their simulated choices', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const added = await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Automatic account', kind: 'subscription', secret: `fixture-${randomUUID()}` } }); expect(added.ok()).toBe(true);
  const account = await added.json();
  const config = await (await page.request.get('/hub/config')).json(); config.configuration['x-jevellan'].guards.pauseAfterPlan = false;
  config.configuration['x-jevellan'].menu = [{ id: 'automatic_model', runtime: 'claude', model: 'claude-fable-5-1', label: 'Automatic Fable', description: 'Simulated browser model.', efforts: ['low', 'high'], enabled: true }];
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: config.revision, configuration: config.configuration } })).ok()).toBe(true);
  // The fixture provider only answers this explicit request; no live Jev or model call is claimed.
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('automatic_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Exercise automatic decisions: change the value to two.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('.manual-picker')).toBeVisible(); await expect(page.getByRole('button', { name: 'Try automatic again', exact: true })).toBeVisible();
  const conversationPath = new URL(page.url()).pathname;
  await page.goto('/settings/decisions'); await page.getByLabel('Jev key', { exact: true }).fill(`fixture-${randomUUID()}`); await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(page.getByText('Jev key saved.', { exact: true })).toBeVisible(); await expect(page.getByLabel('Jev key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click(); await expect(page.getByText('Connected to Jev.', { exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/screenshots/phase3-connection-${info.project.name}.png`, fullPage: true });
  // Disable every Claude account so the retry must offer account-specific recovery.
  const accounts = AccountListSchema.parse(await (await page.request.get('/hub/accounts')).json());
  for (const view of accounts.accounts.filter((entry) => entry.account.runtime === 'claude' && entry.account.enabled)) {
    expect((await page.request.patch(`/hub/accounts/${view.account.id}`, { data: { schema: 'update-account-v1', revision: view.revision, label: view.account.label, ceilingPct: view.account.ceilingPct, enabled: false, ...(view.account.paidUse ? { paidUse: view.account.paidUse } : {}) } })).ok()).toBe(true);
  }
  await page.goto(conversationPath); await page.getByRole('button', { name: 'Try automatic again', exact: true }).click(); await expect(page.getByRole('button', { name: 'Review Automatic account', exact: true })).toBeVisible();
  await page.screenshot({ path: `docs/acceptance/screenshots/phase3-waiting-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Review Automatic account', exact: true }).click(); const card = page.locator(`#account-${account.account.id}`); await expect(card).toBeFocused();
  await card.getByRole('button', { name: 'Enable', exact: true }).click(); await expect(card.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await page.goto(conversationPath); await page.getByRole('button', { name: 'Try automatic again', exact: true }).click();
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 60_000 });
  const step = page.locator('.stretch-block'); await expect(step).toHaveCount(1); await expect(step).toContainText('medium → high'); await expect(step).toContainText('Automatic account');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase3-automatic-${info.project.name}.png`, fullPage: true });
  await step.getByRole('button', { name: 'Why', exact: true }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Next step Jev'); await expect(dialog.getByRole('progressbar', { name: 'Implement probability', exact: true })).toHaveAttribute('value', '1');
  await expect(dialog).toContainText('Model only option'); await expect(dialog).toContainText('Effort Jev'); await expect(dialog).toContainText('nearest effort this model supports');
  await expect(dialog).toContainText('jev-browser-simulated'); await expect(dialog).toContainText('Model and effort');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.getByText('Loading corrections…', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase3-why-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Close panel' }).click(); await step.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(dialog).toContainText('Jevellan verification'); await expect(dialog).toContainText('Passed');
  await dialog.getByRole('button', { name: 'Close panel' }).click();
  const result = ConversationPublicSchema.parse(await (await page.request.get(`/api${conversationPath}`)).json()); expect(result.messages).toHaveLength(1); expect(result.decisions.map((decision) => decision.action.chosen)).toEqual(['implement', 'done']);
  await page.goto(`/settings/runtimes?account=${account.account.id}&login=1`); await expect(page.getByRole('dialog')).toContainText('Log in · Automatic account'); await page.getByRole('button', { name: 'Close panel' }).click();
  expect(errors).toEqual([]);
});

test('composer choices apply once, keep conversation pins and explain corrections after reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Composer account', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  const config = await (await page.request.get('/hub/config')).json(); config.configuration['x-jevellan'].guards.pauseAfterPlan = true;
  config.configuration['x-jevellan'].menu = [...config.configuration['x-jevellan'].menu.filter((model: { id: string }) => model.id !== 'composer_model'), { id: 'composer_model', runtime: 'claude', model: 'claude-fable-5-1', label: 'Composer Fable', description: 'Simulated browser model.', efforts: ['low', 'high'], enabled: true }];
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: config.revision, configuration: config.configuration } })).ok()).toBe(true);
  expect((await page.request.put('/hub/secrets/jev', { data: { schema: 'save-secret-v1', value: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('automatic_fixture');
  await page.getByRole('button', { name: /^Override/ }).click();
  const controls = page.getByRole('group', { name: 'Choices for the next step', exact: true });
  await controls.getByRole('combobox', { name: 'Next step', exact: true }).selectOption('plan');
  await controls.getByRole('combobox', { name: 'Model', exact: true }).selectOption('composer_model'); await controls.getByRole('button', { name: 'Keep model for this conversation', exact: true }).click();
  await controls.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low'); await controls.getByRole('button', { name: 'Keep effort for this conversation', exact: true }).click();
  await controls.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('high'); await expect(controls).toContainText('Once, then low'); await page.getByRole('dialog', { name: 'Override the next step' }).getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByPlaceholder('What should we build or fix?').fill('Exercise composer choices: explain the value.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase3-composer-start-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible({ timeout: 60_000 }); await expect(page.getByRole('heading', { name: 'Step 1 · Plan', exact: true })).toBeVisible();
  await page.reload(); await openConversationSettings(page); await expect(controls.getByRole('combobox', { name: 'Next step', exact: true })).toHaveValue(''); await expect(controls.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('composer_model'); await expect(controls.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('low');
  await closeConversationSettings(page); await page.getByRole('button', { name: 'Approve plan', exact: true }).click(); await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 60_000 });
  const steps = page.locator('.stretch-block'); await expect(steps).toHaveCount(2); await steps.nth(0).locator('.step-details > summary').click(); await steps.nth(1).locator('.step-details > summary').click(); await expect(steps.nth(0).getByRole('button', { name: 'Change effort for step 1', exact: true })).toHaveText('high'); await expect(steps.nth(1).getByRole('button', { name: 'Change effort for step 2', exact: true })).toHaveText('low');
  await centered(steps.nth(1).getByRole('button', { name: 'Why', exact: true })).click(); const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Model kept for this conversation'); await expect(dialog).toContainText('Effort kept for this conversation'); await expect(dialog.locator('.why-correction').filter({ hasText: 'in Automatic fixture,' })).toHaveCount(3); await expect(dialog).toContainText('action: Auto → plan'); await expect(dialog).toContainText('model: Auto → Composer Fable'); await expect(dialog).toContainText('effort: low → high');
  await dialog.getByRole('heading', { name: 'Corrections used', exact: true }).evaluate((element) => element.scrollIntoView({ block: 'center' })); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase3-composer-why-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Close panel' }).click();
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `docs/acceptance/screenshots/phase3-composer-kept-${info.project.name}.png`, fullPage: true });
  await openConversationSettings(page);
  await controls.getByRole('button', { name: 'Model back to Auto', exact: true }).click(); await expect(controls.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('');
  await controls.getByRole('button', { name: 'Effort back to Auto', exact: true }).click(); await expect(controls.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue('');
  await page.reload(); await openConversationSettings(page); await expect(controls.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(''); await expect(controls.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue(''); await closeConversationSettings(page);
  await page.locator('.composer textarea').fill('Exercise composer choices: explain the value.'); await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(steps).toHaveCount(4, { timeout: 60_000 }); await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 60_000 });
  const id = new URL(page.url()).pathname.split('/')[2]!; const result = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${id}`)).json());
  expect(result.conversation).toMatchObject({ once: {}, pins: {} }); expect(result.decisions.at(-2)).toMatchObject({ model: { source: 'kept' }, effort: { source: 'jev', requested: 'medium', effective: 'high' } });
  expect(result.composerOverrides).toHaveLength(6); expect(result.composerOverrides.every((record) => record.status === 'applied')).toBe(true); await expect(page.locator('.toast.error')).toHaveCount(0); expect(errors).toEqual([]);
});

test('external activity waits, retries, requires Changes review and publishes after reviewed acceptance', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'External activity account', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const project = projects.projects.find(row => row.project.id === 'activity_fixture')!.project;
  const projectPath = Object.values(project.paths)[0]!; expect(dirname(projectPath)).toContain('/jevellan-browser-');
  const journalDirectory = join(dirname(projectPath), 'user', '.claude', 'projects', 'external-fixture'); mkdirSync(journalDirectory, { recursive: true }); const journal = join(journalDirectory, 'guard-fixture.jsonl');
  writeFileSync(journal, JSON.stringify({ type: 'user', cwd: projectPath, message: { content: 'Synthetic outside work.' } }) + '\n');
  const quiet = () => { const old = new Date(Date.now() - 10 * 60_000); utimesSync(journal, old, old); };
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('activity_fixture');
  await page.getByPlaceholder('What should we build or fix?').fill('Exercise external activity guards before and during an implementation.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true }); await expect(retry).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('.stretch-block')).toHaveCount(0); await expect(page.getByText(/Another agent \(Claude Code\) is active in External activity fixture/).first()).toBeVisible();
  await retry.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-external-wait-${info.project.name}.png` });
  await page.reload(); await expect(retry).toBeEnabled(); quiet(); await retry.click();
  await expect(page.getByRole('heading', { name: 'Changes need your review', exact: true })).toBeVisible({ timeout: 45_000 }); await expect(page.locator('.stretch-block')).toHaveCount(1);
  await expect(page.getByText(/Claude Code started working in External activity fixture while this step ran/).first()).toBeVisible();
  quiet(); await page.reload(); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('+2'); await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-external-review-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(page.getByRole('heading', { name: 'Changes need your review', exact: true })).not.toBeVisible();
  // The accepted step ended at a blocked checkpoint, so it does not answer the request and Done is not offered (1f63214); the owner closes the work.
  await expect(picker).toBeVisible({ timeout: 45_000 }); await (await openConversationSettings(page)).getByRole('button', { name: 'Close this work', exact: true }).click(); await settlement(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Work closed and published.', { exact: true })).toBeVisible({ timeout: 45_000 }); await closeConversationSettings(page);
  await expect(page.locator('.conversation-meta')).toContainText('Done', { timeout: 45_000 }); await expect(page.locator('.stretch-block')).toHaveCount(1);
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await expect(dialog).toContainText('Passed'); expect(errors).toEqual([]);
});

test('context changes interrupted by outside activity require a fresh reviewed diff before publication', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const project = projects.projects.find(row => row.project.id === 'activity_context')!.project; const projectPath = Object.values(project.paths)[0]!;
  expect(dirname(projectPath)).toContain('/jevellan-browser-');
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click();
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Outside context fixture', exact: true }) }); await card.getByRole('button', { name: 'Context', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Keep AGENTS.md and link CLAUDE.md to it', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible({ timeout: 45_000 });
  const old = new Date(Date.now() - 600_000); utimesSync(join(dirname(projectPath), 'user', '.claude', 'projects', 'context-fixture', 'outside.jsonl'), old, old);
  await dialog.getByRole('button', { name: 'Review changes', exact: true }).click(); await expect(dialog.getByLabel('Current context checkout changes')).toContainText('+A synthetic outside contribution.');
  writeFileSync(join(projectPath, 'outside.txt'), 'A newer synthetic outside contribution.\n');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.locator('.toast.error').last()).toContainText('changed since your review');
  await dialog.getByRole('button', { name: 'Refresh changes', exact: true }).click(); await expect(dialog.getByLabel('Current context checkout changes')).toContainText('+A newer synthetic outside contribution.');
  // The review ends below Continue with the Open work link; show the end of the dialog.
  await dialog.locator('.modal-body').evaluate((body) => body.scrollTo(0, body.scrollHeight)); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-context-review-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(dialog.getByRole('status').filter({ hasText: 'Context change completed.' })).toHaveText('Context change completed.', { timeout: 45_000 });
  await dialog.getByRole('button', { name: 'Open work', exact: true }).click(); await expect(page.locator('.conversation-meta')).toContainText('Done'); await expect(page.locator('.stretch-block')).toHaveCount(0); expect(errors).toEqual([]);
});

const message = "Can't reach the hub (Fixture hub). This will continue when it's back.";
const unavailable = { status: 503, contentType: 'application/json', body: JSON.stringify({ schema: 'error-v1', code: 'hub-unavailable', message, retryable: true }) };

test('provider login recovers lost start and accepted-code replies inside its panel', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Recoverable login', kind: 'subscription' } })).json());
  await page.reload(); const starts: string[] = []; const codes: string[] = []; let loginId = ''; let captured: ReturnType<typeof AccountViewSchema.parse> | undefined;
  await page.route(`**/api/accounts/${account.account.id}/login`, async route => {
    starts.push(route.request().postData()!);
    if (starts.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); loginId = (await response.json()).id; await route.fulfill(unavailable); }
    else await route.continue();
  });
  await page.route('**/api/logins/*', async route => {
    if (route.request().method() === 'GET' && codes.length === 1) { await route.fulfill(unavailable); return; }
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    codes.push(route.request().postData()!);
    if (codes.length === 1) {
      const response = await route.fetch(); expect(response.ok()).toBe(true); expect((await response.json()).id).toBe(loginId);
      captured = AccountViewSchema.parse(await (await page.request.get(`/hub/accounts/${account.account.id}`)).json());
      await route.fulfill(unavailable);
    } else await route.continue();
  });
  await page.locator(`#account-${account.account.id}`).getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  const panel = page.getByRole('dialog'); await expect(panel.getByRole('heading', { name: 'Log in · Recoverable login', exact: true })).toBeVisible();
  expect(starts).toHaveLength(2); expect(starts[1]).toBe(starts[0]);
  await panel.getByLabel('Authorization code').fill('fixture-recovery-code'); await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByText(message, { exact: true })).toBeVisible(); await expect(panel.getByRole('button', { name: 'Stop waiting', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-login-wait-${info.project.name}.png` });
  await expect(panel).toContainText('Signed in as fixture@example.test'); await expect.poll(() => codes.length).toBe(2); expect(codes[1]).toBe(codes[0]);
  const after = AccountViewSchema.parse(await (await page.request.get(`/hub/accounts/${account.account.id}`)).json());
  expect(after.account.secretRef).toBe(captured?.account.secretRef); expect(after.revision).toBe(captured?.revision);
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(panel).not.toBeVisible(); expect(errors).toEqual([]);
});

test('provider login waiting can be stopped and the pending login cancelled from its panel', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const account = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Cancelled login', kind: 'subscription' } })).json());
  await page.reload(); let polls = 0; let cancels = 0; let loginId = '';
  await page.route('**/api/logins/*', route => {
    loginId = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (route.request().method() === 'GET') { polls++; return route.fulfill(unavailable); }
    if (route.request().method() === 'DELETE' && ++cancels === 1) return route.fulfill(unavailable);
    return route.continue();
  });
  await page.locator(`#account-${account.account.id}`).getByRole('button', { name: 'Log in', exact: true }).click(); const panel = page.getByRole('dialog');
  await expect(panel.getByText(message, { exact: true })).toBeVisible(); await panel.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await expect(panel.getByText(message, { exact: true })).not.toBeVisible(); const stoppedAt = polls;
  await page.waitForTimeout(2300); expect(polls).toBe(stoppedAt);
  await panel.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(panel.getByText(message, { exact: true })).toBeVisible();
  await expect(panel).not.toBeVisible(); expect(cancels).toBe(2); expect((await (await page.request.get(`/api/logins/${loginId}`)).json()).state).toBe('cancelled');
  expect(AccountViewSchema.parse(await (await page.request.get(`/hub/accounts/${account.account.id}`)).json()).account.secretRef).toBeUndefined();
});

test('hub recovery resumes sign-in and reconciles a settings save whose reply was lost', async ({ page }, info) => {
  let logins = 0;
  await page.route('**/api/auth/login', route => ++logins === 1 ? route.fulfill(unavailable) : route.continue());
  await page.goto('/settings/decisions'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible(); expect(logins).toBe(2);
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Decisions', exact: true }).click();
  const before = await (await page.request.get('/hub/config')).json(); const bodies: string[] = []; let savedRevision: number | undefined;
  await page.route('**/hub/config', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) {
      const saved = await route.fetch(); expect(saved.ok()).toBe(true); savedRevision = (await saved.json()).revision;
      await route.fulfill(unavailable);
    } else await route.continue();
  });
  const pause = page.getByLabel('Pause after a plan', { exact: true }); await pause.setChecked(!before.configuration['x-jevellan'].guards.pauseAfterPlan);
  await page.getByRole('button', { name: 'Save decisions settings' }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-settings-wait-${info.project.name}.png`, fullPage: false });
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
  const after = await (await page.request.get('/hub/config')).json(); expect(after.revision).toBe(before.revision + 1); expect(after.revision).toBe(savedRevision); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});

test('device Settings completes a member login, shows activity, invites and switches without signing in again', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  let member: { id: string; url: string } | undefined;
  await expect.poll(async () => { const roster = await (await page.request.get('/hub/devices/roster')).json(); member = roster.devices.find((row: { device: { name: string } }) => row.device.name === 'Browser member')?.device; return Boolean(member); }).toBe(true);
  const account = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Cross-device fixture' } })).json());
  await page.reload(); const card = page.locator(`#account-${account.account.id}`); const remote = card.locator('.device-grid > div').filter({ hasText: 'Browser member' });
  await expect(remote.getByRole('button', { name: 'Log in on Browser member', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Log in on Offline fixture', exact: true })).toBeDisabled();
  await remote.getByRole('button', { name: 'Log in on Browser member', exact: true }).click(); const panel = page.getByRole('dialog');
  await expect(panel).toContainText('On Browser member'); await panel.getByLabel('Callback address').fill('fixture-callback'); await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel).toContainText('Signed in as remote-fixture@example.test'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(panel).not.toBeVisible();
  await expect(remote.getByText('Ready', { exact: true })).toBeVisible();
  const saved = AccountViewSchema.parse(await (await page.request.get(`/hub/accounts/${account.account.id}`)).json()); expect(saved.statuses.filter(status => status.auth === 'ready').map(status => status.deviceId)).toEqual([member!.id]);
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Devices', exact: true }).click();
  const memberCard = page.locator('.device-card').filter({ has: page.getByRole('heading', { name: 'Browser member', exact: true }) });
  await expect(memberCard).toContainText('Online'); await expect(memberCard).toContainText('Codex active in remote-project');
  // Counts agree with their noun, and a relative time (`11 minutes ago`) never breaks across lines.
  const running = (card: string) => page.locator('.device-card').filter({ hasText: card }).locator('.device-activity > span').filter({ hasText: /running conversation/ });
  await expect(running('Browser member')).toHaveText('1 running conversation'); await expect(running('Offline fixture')).toHaveText('0 running conversations');
  expect(await page.locator('.device-card .device-activity-time').evaluateAll((times) => times.length > 0 && times.every((time) => getComputedStyle(time).whiteSpace === 'nowrap' && time.getClientRects().length === 1))).toBe(true);
  // Automatic device choice is not available yet, and its box and label read as disabled.
  const automatic = page.locator('.device-auto'); await expect(automatic.getByRole('checkbox', { name: 'Automatic device choice', exact: true })).toBeDisabled();
  expect(await automatic.evaluate((card) => {
    const box = card.querySelector('input')!; const label = card.querySelector('label')!; const probe = document.createElement('span'); probe.style.color = 'var(--ink-3)'; card.append(probe);
    const muted = getComputedStyle(probe).color; probe.remove();
    return { box: Number(getComputedStyle(box).opacity) <= 0.5, label: getComputedStyle(label).color === muted, cursor: getComputedStyle(label).cursor };
  })).toEqual({ box: true, label: true, cursor: 'default' });
  await expect(page.locator('.device-card').filter({ hasText: 'Offline fixture' }).getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The card after the device list keeps the standard card gap (it once sat flush against the last device card).
  const gaps = await page.evaluate(() => {
    const native = document.querySelector('.cursor-connections')!.getBoundingClientRect(); const automatic = document.querySelector('.device-auto')!.getBoundingClientRect();
    return { list: native.top - Math.max(...[...document.querySelectorAll('.project-list > .device-card')].map(card => card.getBoundingClientRect().bottom)), next: automatic.top - native.bottom };
  });
  expect(gaps.list).toBeGreaterThanOrEqual(12); expect(gaps.list).toBeCloseTo(gaps.next, 0);
  await page.screenshot({ path: `docs/acceptance/screenshots/phase4-devices-${info.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Add a device', exact: true }).click(); await expect(panel.locator('.verification-code strong')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{8}$/); await expect(panel.locator('.join-command')).toContainText('npx github:gongiskhan/jevellan join'); await expect(panel).toContainText('Expires'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/phase5-join-${info.project.name}.png`, fullPage: false, mask: [panel.locator('.verification-code strong'), panel.locator('.join-command span')], maskColor: '#dce2de' }); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  // From 761 to 1024 px the sidebar is 236 px wide: the device pill stays inside it, a long name ending in an ellipsis, and the pill
  // names the device in full on hover (D319).
  const viewport = page.viewportSize()!; await page.setViewportSize({ width: 900, height: viewport.height });
  const roster = DeviceRosterSchema.parse(await (await page.request.get('/hub/devices/roster')).json()); const here = roster.devices.find(row => row.device.id === roster.currentDeviceId)!.device.name;
  const pill = page.locator('.sidebar .device-switcher summary'); await expect(pill).toHaveAttribute('title', here); await expect(pill).toContainText(here);
  expect(await pill.evaluate((summary) => { const sidebar = summary.closest('.sidebar')!.getBoundingClientRect(); const box = summary.getBoundingClientRect(); return box.width > 0 && box.left >= sidebar.left && box.right <= sidebar.right - 12; })).toBe(true);
  await page.setViewportSize(viewport);
  await openDeviceSwitcher(page); await expect(page.locator('.device-switcher button').filter({ hasText: 'Offline fixture' })).toBeDisabled();
  await page.locator('.device-switcher button').filter({ hasText: 'Browser member' }).click(); await page.waitForURL(`${member!.url}/settings/devices`);
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible(); await expect(page.getByLabel('Passphrase')).not.toBeVisible(); await expect(page.locator('.device-switcher summary')).toContainText('Browser member'); expect(errors).toEqual([]);
});

test('hub recovery stops abandoned settings requests before another write', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Settings', exact: true }); await tabs.getByRole('button', { name: 'Decisions', exact: true }).click();
  const before = await (await page.request.get('/hub/config')).json(); let writes = 0;
  await page.route('**/hub/config', route => { if (route.request().method() !== 'PUT') return route.continue(); writes++; return route.fulfill(unavailable); });
  await page.getByRole('button', { name: 'Save decisions settings' }).click(); await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop waiting', exact: true }).click(); await expect(page.getByText(message, { exact: true })).not.toBeVisible(); await expect(page.getByRole('button', { name: 'Save decisions settings' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save decisions settings' }).click(); await expect(page.getByText(message, { exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Configuration', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Configuration', exact: true })).toBeVisible(); await expect(page.getByText(message, { exact: true })).not.toBeVisible();
  await page.waitForTimeout(2300); expect(writes).toBe(2); expect((await (await page.request.get('/hub/config')).json()).revision).toBe(before.revision);
});

test('hub recovery starts one conversation after admission loss and a lost creation reply', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: 'Recovery fixture', kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await page.goto('/'); const bodies: string[] = []; let conversationId: string | undefined;
  await page.route('**/api/conversations', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) await route.fulfill(unavailable);
    else if (bodies.length === 2) { const created = await route.fetch(); expect(created.ok()).toBe(true); conversationId = (await created.json()).conversation.id; await route.fulfill(unavailable); }
    else await route.continue();
  });
  const title = `Recovery ${randomUUID()}`;
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('browser_fixture'); await page.getByPlaceholder('What should we build or fix?').fill(title); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  // Two deliberate hub failures include four seconds of retry waits before creation and loading.
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
  expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1); expect(page.url()).toContain(`/conversations/${conversationId}`);
  const list = await (await page.request.get('/api/conversations')).json(); expect(list.conversations.filter((entry: { title: string }) => entry.title === title)).toHaveLength(1);
  expect((await page.request.post(`/api/conversations/${conversationId}/cancel`, { data: { schema: 'empty-request-v1' } })).ok()).toBe(true);
});

test('J8 simulated mesh journey switches, streams, corrects, logs in remotely and respects outside work', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const sourceUrl = info.project.use.baseURL!;
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  // Exercise the fixture's authentication-failure fallback even when this test runs alone.
  expect((await page.request.put('/hub/secrets/jev', { data: { schema: 'save-secret-v1', value: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await expect.poll(async () => ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()).projects.some(row => row.project.id === 'mesh_fixture')).toBe(true);
  const roster = await (await page.request.get('/hub/devices/roster')).json(); const source = roster.devices.find((row: { device: { id: string } }) => row.device.id === roster.currentDeviceId).device; const target = roster.devices.find((row: { device: { name: string } }) => row.device.name === 'Browser member').device;
  const project = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()).projects.find(row => row.project.id === 'mesh_fixture')!.project;
  const sourcePath = project.paths[source.id]!; const targetPath = project.paths[target.id]!; expect(sourcePath).not.toBe(targetPath); const root = dirname(sourcePath); expect(root).toContain('/jevellan-browser-');
  const account = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'J8 Codex account' } })).json());
  const claude = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', kind: 'subscription', label: 'J8 Claude account', secret: `fixture-${randomUUID()}` } })).json());
  expect((await page.request.post(`/api/accounts/${claude.account.id}/check`, { data: { schema: 'empty-request-v1' } })).ok()).toBe(true);
  await page.reload(); const card = page.locator(`#account-${account.account.id}`); await card.getByRole('button', { name: 'Log in on Browser member', exact: true }).click(); const panel = page.getByRole('dialog');
  await expect(panel).toContainText('On Browser member'); await panel.getByLabel('Callback address').fill('j8-simulated-approval'); await panel.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(panel).toContainText('Signed in as remote-fixture@example.test'); await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(card.locator('.device-grid > div').filter({ hasText: 'Browser member' }).getByText('Ready', { exact: true })).toBeVisible();
  const status = AccountViewSchema.parse(await (await page.request.get(`/hub/accounts/${account.account.id}`)).json()); expect(status.statuses.filter(row => row.auth === 'ready').map(row => row.deviceId)).toEqual([target.id]);
  const configuration = await (await page.request.get('/hub/config')).json(); configuration.configuration['x-jevellan'].runtimes.codex = { enabled: true };
  configuration.configuration['x-jevellan'].menu = [...configuration.configuration['x-jevellan'].menu.filter((model: { runtime: string }) => model.runtime !== 'codex'), { id: 'mesh_codex', runtime: 'codex', model: 'gpt-fixture', label: 'Mesh Codex', description: 'Simulated mesh journey provider', efforts: ['low', 'high'], enabled: true }];
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: configuration.revision, configuration: configuration.configuration } })).ok()).toBe(true);
  await openDeviceSwitcher(page); await page.locator('.device-switcher button').filter({ hasText: 'Browser member' }).click(); await page.waitForURL(`${target.url}/settings/runtimes`); await expect(page.getByLabel('Passphrase')).not.toBeVisible();
  await page.goto(`${target.url}/`); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('mesh_fixture'); await expect(page.getByRole('combobox', { name: 'Device', exact: true }).locator('option').filter({ hasText: 'Choose automatically' })).toHaveJSProperty('disabled', true);
  await page.getByPlaceholder('What should we build or fix?').fill('J8: run on device B while I steer from device A.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible({ timeout: 30_000 }); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('reply'); await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption('mesh_codex'); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.stretch-block .step-transcript')).toContainText('Working on device B', { timeout: 30_000 }); const conversationId = new URL(page.url()).pathname.split('/')[2]!;
  const local = ConversationPublicSchema.parse(await (await page.request.get(`${target.url}/api/conversations/${conversationId}`)).json()); expect(local.conversation.ownerDeviceId).toBe(target.id);
  await openDeviceSwitcher(page); await page.locator('.device-switcher button').filter({ has: page.getByText(source.name, { exact: true }) }).click(); await page.waitForURL(`${sourceUrl}/conversations/${conversationId}`);
  await expect(page.getByLabel('Passphrase')).not.toBeVisible(); await expect(page.locator('.device-switcher summary')).toContainText(source.name);
  if (info.project.name.startsWith('phone')) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Conversations' }).getByText('J8: run on device B while I steer from device A.', { exact: true })).toBeVisible();
  if (info.project.name.startsWith('phone')) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  const stream = page.locator('.stretch-block .step-transcript'); const length = (await stream.innerText()).length; await expect.poll(async () => (await stream.innerText()).length).toBeGreaterThan(length);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep the checkout unchanged; stop for this correction from device A.'); await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await expect.poll(async () => {
    const view = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${conversationId}`)).json());
    return view.stretches[0]?.status === 'interrupted' && view.handoffs.some(handoff => handoff.summary === 'Device B stopped for the correction from device A.');
  }, { timeout: 30_000 }).toBe(true);
  const corrected = ConversationPublicSchema.parse(await (await page.request.get(`/api/conversations/${conversationId}`)).json()); expect(corrected.stretches[0]?.status).toBe('interrupted'); expect(corrected.conversation.ownerDeviceId).toBe(target.id); expect(JSON.stringify(corrected.messages)).toContain('this correction from device A');
  expect(existsSync(join(root, 'user', '.jevellan', 'conversations', conversationId))).toBe(false); expect(readFileSync(join(targetPath, 'value.txt'), 'utf8')).toBe('1\n');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/J8-proxy-${info.project.name}.png`, fullPage: true });
  expect((await page.request.post(`/api/conversations/${conversationId}/cancel`, { data: { schema: 'empty-request-v1' } })).ok()).toBe(true);
  const journalDir = join(root, 'user', '.claude', 'projects', 'j8-outside'); mkdirSync(journalDir, { recursive: true }); const journal = join(journalDir, 'fixture.jsonl'); writeFileSync(journal, JSON.stringify({ type: 'user', cwd: sourcePath, message: { content: 'Simulated outside agent activity.' } }) + '\n');
  await expect.poll(async () => { const roster = await (await page.request.get('/hub/devices/roster')).json(); return roster.devices.find((row: { device: { id: string } }) => row.device.id === source.id).heartbeat?.externalSessions.some((session: { cwd: string }) => session.cwd === sourcePath); }, { timeout: 45_000 }).toBe(true);
  await page.goto('/settings/devices'); await expect(page.getByRole('main').getByText(/Claude Code active in mesh-a/)).toBeVisible();
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('mesh_fixture'); await page.getByPlaceholder('What should we build or fix?').fill('J8: implement after the outside agent is quiet.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement'); const sourceModel = configuration.configuration['x-jevellan'].menu.find((model: { runtime: string; enabled: boolean; unavailableReason?: string }) => model.runtime === 'claude' && model.enabled && !model.unavailableReason).id;
  await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(sourceModel); await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry', exact: true }); await expect(retry).toBeEnabled(); await expect(page.getByText(/Another agent \(Claude Code\) is active in Mesh journey fixture/).first()).toBeVisible(); await expect(page.locator('.stretch-block')).toHaveCount(0); expect(readFileSync(join(sourcePath, 'value.txt'), 'utf8')).toBe('1\n');
  await retry.scrollIntoViewIfNeeded(); await page.screenshot({ path: `docs/acceptance/screenshots/J8-guard-${info.project.name}.png` });
  const quiet = new Date(Date.now() - 10 * 60_000); utimesSync(journal, quiet, quiet); await retry.click(); await expect(page.locator('.stretch-block')).toHaveCount(1); await expect(picker).toBeVisible({ timeout: 45_000 }); expect(readFileSync(join(sourcePath, 'value.txt'), 'utf8')).toBe('2\n'); expect(readFileSync(join(targetPath, 'value.txt'), 'utf8')).toBe('1\n');
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('done'); await picker.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.locator('.conversation-meta')).toContainText('Done'); expect(errors).toEqual([]);
  writeFileSync(`docs/acceptance/J8-simulated-${info.project.name}.json`, JSON.stringify(J8EvidenceSchema.parse({ schema: 'j8-simulated-v1', layout: info.project.name, transport: 'live-local-http', devices: 'simulated', providers: 'simulated', selection: 'manual', separateCheckouts: true, remoteLoginReadyOnlyOnB: true, switchedWithoutSignIn: true, ownerStayedOnB: true, proxyStreamGrew: true, correctionInterruptedB: true, automaticChoiceDisabled: true, externalSessionVisible: true, writingBlockedUntilQuiet: true, writingResumedAfterQuiet: true }), null, 2) + '\n');
});

test('J11 simulated mesh journey publishes memory, recalls after pull and reviews a context merge', async ({ page }, info) => {
  // This spans two devices, real Basic Memory processes, publication and a separately verified context merge.
  test.setTimeout(budgetMs(73.8, 240_000));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const sourceUrl = info.project.use.baseURL!;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  expect((await page.request.put('/hub/secrets/jev', { data: { schema: 'save-secret-v1', value: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  await expect.poll(async () => ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()).projects.some(row => row.project.id === 'j11_context')).toBe(true);
  const roster = await (await page.request.get('/hub/devices/roster')).json(); const source = roster.devices.find((row: { device: { id: string } }) => row.device.id === roster.currentDeviceId).device; const target = roster.devices.find((row: { device: { name: string } }) => row.device.name === 'Browser member').device;
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const project = projects.projects.find(row => row.project.id === 'j11_fixture')!.project;
  const sourcePath = project.paths[source.id]!; const targetPath = project.paths[target.id]!; const root = dirname(sourcePath); expect(root).toContain('/jevellan-browser-'); expect(sourcePath).not.toBe(targetPath);
  expect(lstatSync(join(sourcePath, 'CLAUDE.md')).isSymbolicLink()).toBe(true); expect(readlinkSync(join(sourcePath, 'CLAUDE.md'))).toBe('AGENTS.md'); expect(git(sourcePath, 'status', '--porcelain')).toBe(''); expect(git(sourcePath, 'ls-files', 'CLAUDE.md')).toBe('');
  const claude = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', kind: 'subscription', label: 'J11 Claude account', secret: `fixture-${randomUUID()}` } })).json());
  expect((await page.request.post(`/api/accounts/${claude.account.id}/check`, { data: { schema: 'empty-request-v1' } })).ok()).toBe(true);
  const codex = AccountViewSchema.parse(await (await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'J11 Codex account' } })).json());
  await page.reload(); await page.locator(`#account-${codex.account.id}`).getByRole('button', { name: 'Log in on Browser member', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Callback address').fill('j11-simulated-approval'); await dialog.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(dialog).toContainText('Signed in as remote-fixture@example.test'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  const configuration = await (await page.request.get('/hub/config')).json(); configuration.configuration['x-jevellan'].runtimes.codex = { enabled: true };
  configuration.configuration['x-jevellan'].menu = [...configuration.configuration['x-jevellan'].menu.filter((model: { id: string }) => model.id !== 'j11_codex'), { id: 'j11_codex', runtime: 'codex', model: 'gpt-fixture', label: 'J11 Codex', description: 'Simulated J11 provider', efforts: ['low', 'high'], enabled: true }];
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: configuration.revision, configuration: configuration.configuration } })).ok()).toBe(true);
  const claudeModel = configuration.configuration['x-jevellan'].menu.find((model: { runtime: string; enabled: boolean; unavailableReason?: string }) => model.runtime === 'claude' && model.enabled && !model.unavailableReason).id;
  const switchTo = async (name: string, url: string) => { await openDeviceSwitcher(page); await page.locator('.device-switcher button').filter({ has: page.getByText(name, { exact: true }) }).click(); await page.waitForURL(`${url}/**`); await expect(page.getByLabel('Passphrase')).not.toBeVisible(); };
  await switchTo(target.name, target.url);
  const initial = MemorySearchSchema.parse(await (await page.request.get(`${target.url}/api/projects/j11_fixture/memory?query=existing`, { timeout: 130_000 })).json()); expect(initial.notes).toHaveLength(1);
  await switchTo(source.name, sourceUrl);
  const baseline = git(sourcePath, 'rev-parse', 'HEAD');
  await page.goto('/'); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('j11_fixture'); await page.getByPlaceholder('What should we build or fix?').fill('Remember that this project uses Vitest with globals enabled.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); const sourceId = new URL(page.url()).pathname.split('/')[2]!;
  const read = async (base: string, id: string) => ConversationPublicSchema.parse(await (await page.request.get(`${base}/api/conversations/${id}`)).json());
  const step = async (base: string, id: string, action: 'reply' | 'review' | 'done', model: string, remember = false) => {
    const before = await read(base, id); await expect(picker).toBeVisible(); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
    if (action !== 'done') await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model);
    if (action === 'reply') await picker.getByRole('checkbox', { name: 'This request explicitly asks to remember something.', exact: true }).setChecked(remember);
    const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/conversations/${id}/manual`);
    await picker.getByRole('button', { name: 'Continue', exact: true }).click(); expect((await response).status()).toBe(202);
    const title = `${action}${remember ? ' with memory' : ''}${base === sourceUrl ? '' : ' on the member'}`; const within = budget(J11_STEPS_ALONE[title]!, 45_000);
    await serverWork(title, async () => {
      if (action === 'done') await expect(page.locator('.conversation-meta')).toContainText('Done', within);
      else { await expect.poll(async () => (await read(base, id)).stretches[before.stretches.length]?.status, within).toBe('completed'); await expect(picker).toBeVisible(within); }
    });
    return read(base, id);
  };
  const remembered = await step(sourceUrl, sourceId, 'reply', claudeModel, true); const workId = remembered.conversation.work!.id;
  expect(remembered.handoffs[0]?.summary).toBe('Saved the Vitest convention in project memory.'); expect(git(sourcePath, 'rev-parse', 'HEAD')).not.toBe(baseline);
  const notes = MemorySearchSchema.parse(await (await page.request.get('/api/projects/j11_fixture/memory?query=Vitest', { timeout: 130_000 })).json()); const note = notes.notes.find(note => note.title === 'Vitest convention for mesh')!; expect(note.content).toContain('globals enabled');
  const reviewed = await step(sourceUrl, sourceId, 'review', claudeModel); expect(reviewed.conversation.work!.id).toBe(workId); expect(reviewed.stretches[1]?.runtime).toBe('claude'); expect(reviewed.handoffs[1]?.summary).toBe('Proposed global test imports without changing the checkout.');
  await expect(page.locator('.stretch-block').nth(1)).toContainText('J11 claude received project memory: Vitest convention for mesh; globals enabled.');
  const why = async (index: number, label: string) => { await centered(page.locator('.stretch-block').nth(index).getByRole('button', { name: 'Why', exact: true })).click(); const region = dialog.getByRole('region', { name: 'Memory selection' }); await expect(region).toContainText('Selected by search rank.'); await expect(region.getByRole('list', { name: 'Chosen memory' })).toContainText(note.permalink); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `docs/acceptance/screenshots/J11-mesh-${label}-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); };
  await why(1, 'claude-why'); await step(sourceUrl, sourceId, 'done', claudeModel);
  const published = git(sourcePath, 'rev-parse', 'HEAD'); expect(git(join(root, 'j11-origin.git'), 'rev-parse', 'main')).toBe(published); expect(git(sourcePath, 'status', '--porcelain')).toBe('');
  const changed = git(sourcePath, 'diff', '--name-only', '-z', baseline, published).split('\0').filter(Boolean); expect(changed.length).toBeGreaterThan(0); expect(changed.every(path => path.startsWith('.jevellan/memory/'))).toBe(true);
  const saved = MemorySearchSchema.parse(await (await page.request.get('/api/projects/j11_fixture/memory?query=Vitest', { timeout: 130_000 })).json()); expect(saved.notes.some(note => note.title === 'Global test imports for mesh')).toBe(true);
  git(targetPath, 'pull', '--ff-only'); expect(git(targetPath, 'rev-parse', 'HEAD')).toBe(published);
  await switchTo(target.name, target.url); await page.goto(`${target.url}/`); await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('j11_fixture'); await page.getByPlaceholder('What should we build or fix?').fill('Explain how to write a Vitest test for this project.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
  await serverWork('start on the member', () => expect(picker).toBeVisible(budget(1.8))); const targetId = new URL(page.url()).pathname.split('/')[2]!; const recalled = await step(target.url, targetId, 'reply', 'j11_codex'); expect(recalled.conversation.ownerDeviceId).toBe(target.id); expect(recalled.stretches[0]?.runtime).toBe('codex'); expect(recalled.decisions[0]?.memory?.chosen).toContain(note.permalink);
  await expect(page.locator('.stretch-block').first()).toContainText('J11 codex received project memory: Vitest convention for mesh; globals enabled.'); await page.reload(); await why(0, 'codex-why'); await step(target.url, targetId, 'done', 'j11_codex'); expect(git(targetPath, 'rev-parse', 'HEAD')).toBe(published); expect(git(targetPath, 'status', '--porcelain')).toBe('');
  await switchTo(source.name, sourceUrl); await page.goto('/settings/projects'); const contextCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'J11 context journey', exact: true }) }); await expect(contextCard).toContainText('Context needs a decision'); await contextCard.getByRole('button', { name: 'Context', exact: true }).click();
  const contextPath = projects.projects.find(row => row.project.id === 'j11_context')!.project.paths[source.id]!; const contextHead = git(contextPath, 'rev-parse', 'HEAD'); const contextBefore = ['AGENTS.md', 'CLAUDE.md'].map(file => readFileSync(join(contextPath, file), 'utf8'));
  await dialog.getByRole('button', { name: 'Merge them into AGENTS.md', exact: true }).click(); await serverWork('context draft', () => expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeVisible(budget(3.4))); await expect(dialog).toContainText('Shared project instructions'); await expect(dialog).toContainText('Symlink → AGENTS.md');
  expect(git(contextPath, 'rev-parse', 'HEAD')).toBe(contextHead); expect(['AGENTS.md', 'CLAUDE.md'].map(file => readFileSync(join(contextPath, file), 'utf8'))).toEqual(contextBefore); expect(git(contextPath, 'status', '--porcelain')).toBe('');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `docs/acceptance/screenshots/J11-mesh-context-draft-${info.project.name}.png` }); await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await serverWork('context apply', () => expect(dialog).toContainText('Context change completed.', budget(11.4)));
  const context = ContextPanelSchema.parse(await (await page.request.get('/api/projects/j11_context/context/operations')).json()); expect(context.operations.at(-1)).toMatchObject({ status: 'completed', approved: true, applied: true }); expect(readlinkSync(join(contextPath, 'CLAUDE.md'))).toBe('AGENTS.md'); expect(readFileSync(join(contextPath, 'AGENTS.md'), 'utf8')).toContain('Preserve the tests.'); expect(readFileSync(join(contextPath, 'AGENTS.md'), 'utf8')).toContain('Run the formatter.'); expect(git(join(root, 'j11-context-origin.git'), 'rev-parse', 'main')).toBe(git(contextPath, 'rev-parse', 'HEAD')); expect(git(contextPath, 'status', '--porcelain')).toBe(''); expect(errors).toEqual([]);
  writeFileSync(`docs/acceptance/J11-mesh-simulated-${info.project.name}.json`, JSON.stringify(J11EvidenceSchema.parse({ schema: 'j11-mesh-simulated-v1', layout: info.project.name, devices: 'simulated', providers: 'simulated', memory: 'live-basic-memory', selection: 'manual-search-rank', compatibilityLinkExcluded: true, explicitMemoryPublished: true, readOnlyProposalPreservedCheckout: true, proposalAppliedByOwner: true, alreadyOpenIndexRefreshedAfterPull: true, claudeAndCodexReceivedNote: true, whyShowsChosenMemory: true, contextDraftPreservedFiles: true, contextMergePublished: true, chosenNote: note.permalink }), null, 2) + '\n');
});

test('Settings saves wait through hub loss, reconcile lost replies and abandon a closed editor', async ({ page }, info) => {
  // This fixture has accumulated accounts; both Rigging saves deliver through real APM before losing a reply.
  test.setTimeout(420_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog'); const createdBodies: string[] = [];
  await page.route('**/hub/accounts', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    createdBodies.push(route.request().postData()!);
    if (createdBodies.length === 1) await route.fulfill(unavailable);
    else if (createdBodies.length === 2) { const saved = await route.fetch({ timeout: 60_000 }); expect(saved.status()).toBe(201); await route.fulfill(unavailable); }
    else await route.continue();
  });
  const runtime = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) }); await runtime.getByRole('button', { name: 'Add account', exact: true }).click();
  const label = 'Recoverable Settings account'; await dialog.getByLabel('Label', { exact: true }).fill(label); await dialog.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('api-key'); await dialog.getByLabel('API key', { exact: true }).fill(`fixture-${randomUUID()}`); await dialog.getByLabel('When may Jevellan use this key?').selectOption('always'); await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await page.screenshot({ path: `docs/acceptance/screenshots/phase4-settings-save-wait-${info.project.name}.png` }); await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  expect(createdBodies).toHaveLength(3); expect(new Set(createdBodies).size).toBe(1); expect(JSON.parse(createdBodies[0]!).clientRequestId).toBeTruthy();
  const accounts = AccountListSchema.parse(await (await page.request.get('/hub/accounts')).json()).accounts.filter(row => row.account.label === label); expect(accounts).toHaveLength(1); const account = accounts[0]!; const card = page.locator(`#account-${account.account.id}`);
  const loseSavedReply = async (path: string, method: string, timeout = 60_000) => {
    const bodies: string[] = [];
    const lost = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path && response.status() === 503, { timeout });
    await page.route(`${info.project.use.baseURL}${path}`, async route => { if (route.request().method() !== method) return route.continue(); bodies.push(route.request().postData()!); if (bodies.length === 1) { const saved = await route.fetch({ timeout }); expect(saved.ok()).toBe(true); await route.fulfill(unavailable); } else await route.continue(); });
    return { lost, check: () => { expect(bodies).toHaveLength(2); expect(new Set(bodies).size).toBe(1); expect(JSON.parse(bodies[0]!).clientRequestId).toBeTruthy(); } };
  };
  const edited = await loseSavedReply(`/hub/accounts/${account.account.id}`, 'PATCH'); await card.getByRole('button', { name: 'Edit', exact: true }).click(); await dialog.getByLabel('Label', { exact: true }).fill('Recovered account edit'); await dialog.getByRole('button', { name: 'Save account', exact: true }).click(); await edited.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog).not.toBeVisible({ timeout: 60_000 }); edited.check(); await expect(card).toContainText('Recovered account edit');
  const replaced = await loseSavedReply(`/hub/accounts/${account.account.id}/credential`, 'PUT'); await card.getByRole('button', { name: 'Replace key', exact: true }).click(); await dialog.getByLabel('New API key', { exact: true }).fill(`fixture-${randomUUID()}`); await dialog.getByRole('button', { name: 'Replace key', exact: true }).click(); await replaced.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog).not.toBeVisible({ timeout: 60_000 }); replaced.check();
  await page.goto('/settings/rigging'); const added = await loseSavedReply('/hub/rigging', 'POST', 180_000); await page.getByRole('button', { name: 'Add local item', exact: true }).click(); await dialog.getByLabel('Name', { exact: true }).fill('Recoverable Settings skill'); await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('Preserve the requested scope.'); await dialog.getByRole('button', { name: 'Add item', exact: true }).click(); await added.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog).not.toBeVisible({ timeout: 60_000 }); added.check();
  const items = (await (await page.request.get('/hub/rigging')).json()).items.filter((row: { item: { name: string } }) => row.item.name === 'Recoverable Settings skill'); expect(items).toHaveLength(1); const item = RiggingSaveSchema.shape.item.parse(items[0]);
  const itemPath = `/hub/rigging/${item.item.id}`; const saved = await loseSavedReply(itemPath, 'PUT', 180_000); await page.getByRole('button', { name: /Recoverable Settings skill/ }).click(); await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('Preserve the scope and verify it.'); await saved.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog.getByRole('status', { name: '', exact: true }).filter({ hasText: /^Saved/ })).toHaveText('Saved', { timeout: 60_000 }); saved.check();
  let abandoned = 0; await page.route(`${info.project.use.baseURL}${itemPath}`, route => { if (route.request().method() !== 'PUT') return route.continue(); abandoned++; return route.fulfill(unavailable); }); await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('This abandoned edit must not be sent later.'); await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(dialog).not.toBeVisible(); await page.waitForTimeout(2300); expect(abandoned).toBe(1);
  const current = (await (await page.request.get('/hub/rigging')).json()).items.find((row: { item: { id: string } }) => row.item.id === item.item.id); expect(RiggingSaveSchema.shape.item.parse(current).item.content).toBe('Preserve the scope and verify it.'); expect(errors).toEqual([]);
});

test('project, Jev, local Rigging and device Settings recover their hub boundaries', async ({ page }, info) => {
  // Promotion delivers the bundle through real APM to this accumulated fixture's account homes.
  test.setTimeout(300_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog'); const message = "Can't reach the hub (Fixture hub). This will continue when it's back.";
  const unavailable = { status: 503, contentType: 'application/json', body: JSON.stringify({ schema: 'error-v1', code: 'hub-unavailable', message, retryable: true }) };
  const interrupt = async (path: string, method: string, afterSave = true, timeout = 60_000) => {
    const bodies: string[] = []; const lost = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method && response.status() === 503, { timeout });
    await page.route(`${info.project.use.baseURL}${path}`, async route => {
      if (route.request().method() !== method) return route.continue(); bodies.push(route.request().postData()!);
      if (bodies.length === 1) { if (afterSave) expect((await route.fetch({ timeout })).ok()).toBe(true); await route.fulfill(unavailable); } else await route.continue();
    });
    return { lost, verify: () => { expect(bodies).toHaveLength(2); expect(new Set(bodies).size).toBe(1); } };
  };
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()); const root = dirname(Object.values(projects.projects.find(row => row.project.id === 'browser_fixture')!.project.paths)[0]!);
  const origin = join(root, 'settings-wait-origin.git'); const checkout = join(root, 'settings-wait-project');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(root, 'init', '--bare', '-b', 'main', origin); git(root, 'clone', origin, checkout); git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(checkout, 'AGENTS.md'), '# Settings fixture\nPreserve these instructions.\n'); git(checkout, 'add', 'AGENTS.md'); git(checkout, 'commit', '-m', 'Seed Settings fixture'); git(checkout, 'push', '-u', 'origin', 'main');
  await page.goto('/settings/projects'); const projectSave = await interrupt('/hub/projects', 'PUT'); await page.getByRole('button', { name: 'Add project', exact: true }).click(); await dialog.getByLabel('Name', { exact: true }).fill('Recoverable project'); await (await currentProjectPath(page)).fill(checkout); await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); await projectSave.lost;
  await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await page.screenshot({ path: `docs/acceptance/screenshots/phase4-project-save-wait-${info.project.name}.png` }); await expect(dialog).not.toBeVisible({ timeout: 60_000 }); projectSave.verify();
  const saved = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json()).projects.filter(row => row.project.name === 'Recoverable project'); expect(saved).toHaveLength(1);
  expect(lstatSync(join(checkout, 'CLAUDE.md')).isSymbolicLink()).toBe(true); expect(ContextPanelSchema.parse(await (await page.request.get(`/api/projects/${saved[0]!.project.id}/context/operations`)).json()).operations).toHaveLength(1);
  await page.goto('/settings/decisions'); const jev = await interrupt('/hub/secrets/jev', 'PUT'); await page.getByLabel('Jev key', { exact: true }).fill(`fixture-${randomUUID()}`); await page.getByRole('button', { name: 'Save key', exact: true }).click(); await jev.lost; await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(page.getByText('Jev key saved.', { exact: true })).toBeVisible(); jev.verify(); await expect(page.getByLabel('Jev key', { exact: true })).toHaveValue('');
  const bundle = join(root, 'user/.jevellan/homes/claude/acc_rigging_claude/skills/browser-wait'); mkdirSync(join(bundle, 'assets'), { recursive: true }); writeFileSync(join(bundle, 'SKILL.md'), '# Waiting fixture\nKeep the bundle.\n'); writeFileSync(join(bundle, 'assets/example.txt'), 'Keep this bundled file.\n');
  await page.goto('/settings/rigging'); const item = RiggingDiskListSchema.parse(await (await page.request.get('/api/rigging/homes')).json()).items.find(row => row.name === 'browser-wait')!;
  const path = `/api/rigging/homes/claude/${item.accountId}/${item.id}`; const edit = await interrupt(path, 'PUT', false); const loose = page.locator('.rigging-disk-row[data-state="loose"]').filter({ hasText: 'browser-wait' });
  await loose.getByRole('button', { name: /^browser-wait/ }).click(); await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('# Saved after waiting\nKeep the bundle.\n'); await edit.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog.locator('.subheading [role=status]')).toHaveText('Saved'); edit.verify();
  let abandoned = 0; await page.route(`${info.project.use.baseURL}${path}`, route => { if (route.request().method() !== 'PUT') return route.continue(); abandoned++; return route.fulfill(unavailable); });
  await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('An abandoned local draft.'); await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click(); await page.waitForTimeout(2300); expect(abandoned).toBe(1); expect(readFileSync(join(bundle, 'SKILL.md'), 'utf8')).toBe('# Saved after waiting\nKeep the bundle.\n'); await page.unroute(`${info.project.use.baseURL}${path}`);
  const park = await interrupt(path, 'POST'); await loose.getByRole('button', { name: 'Park', exact: true }).click(); await park.lost; await expect(page.getByText(message, { exact: true })).toBeVisible(); const parked = page.locator('.rigging-disk-row[data-state="parked"]').filter({ hasText: 'browser-wait' }); await expect(parked).toBeVisible(); park.verify();
  await parked.getByRole('button', { name: 'Restore locally', exact: true }).click(); await expect(loose).toBeVisible(); expect(readFileSync(join(bundle, 'assets/example.txt'), 'utf8')).toBe('Keep this bundled file.\n');
  let stoppedPromotions = 0; let refreshesAfterStop = 0;
  await loose.getByRole('button', { name: 'Make managed', exact: true }).click(); await dialog.getByLabel('Name', { exact: true }).fill('Recovered managed bundle');
  await page.route(`${info.project.use.baseURL}${path}/promote`, route => { stoppedPromotions++; return route.fulfill(unavailable); });
  await page.route(`${info.project.use.baseURL}/api/rigging/homes`, route => { refreshesAfterStop++; return route.fulfill(unavailable); });
  await dialog.getByRole('button', { name: 'Make managed', exact: true }).click(); await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Stop waiting', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled(); await page.waitForTimeout(2300); expect(stoppedPromotions).toBe(1); expect(refreshesAfterStop).toBe(0); await expect(dialog.getByText(message, { exact: true })).not.toBeVisible();
  await page.unroute(`${info.project.use.baseURL}${path}/promote`); await page.unroute(`${info.project.use.baseURL}/api/rigging/homes`);
  const promotion = await interrupt(`${path}/promote`, 'POST', true, 180_000); await dialog.getByRole('button', { name: 'Retry', exact: true }).click(); await promotion.lost; await expect(dialog.getByText(message, { exact: true })).toBeVisible(); await expect(dialog).not.toBeVisible({ timeout: 60_000 }); promotion.verify();
  expect((await (await page.request.get('/hub/rigging')).json()).items.filter((row: { item: { name: string } }) => row.item.name === 'Recovered managed bundle')).toHaveLength(1); expect(readFileSync(join(bundle, 'assets/example.txt'), 'utf8')).toBe('Keep this bundled file.\n');
  await page.goto('/settings/devices'); const invitation = await interrupt('/hub/devices/invitations', 'POST', false); await page.getByRole('button', { name: 'Add a device', exact: true }).click(); await invitation.lost; await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(dialog.locator('.verification-code strong')).toHaveText(/^[0-9A-HJKMNP-TV-Z]{8}$/); invitation.verify(); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  const switching = await interrupt('/api/devices/switch', 'POST', false); await openDeviceSwitcher(page); await page.locator('.device-switcher button').filter({ hasText: 'Browser member' }).click(); await switching.lost; await expect(page.getByText(message, { exact: true })).toBeVisible(); await expect(page.locator('.device-switcher summary')).toContainText('Browser member'); switching.verify(); await expect(page.getByLabel('Passphrase')).not.toBeVisible(); expect(errors).toEqual([]);
});
