import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRevisionSchema, ImproverRunSchema, ImproverStateSchema, ProjectsListSchema, type Configuration } from '../../packages/core/dist/client.js';
import { seedConfiguration } from '../../packages/core/dist/index.js';

// J10 and J12 through the Settings → Improver page. Jev judgments, saved-case checks and drafts are
// simulated by scripts/test-server.mjs; Git, ownership, publication to a bare origin and Basic Memory are real.
test.describe.configure({ mode: 'serial' });
async function shot(page: Page, name: string, project: string) {
  // Transient confirmations are closed first so they don't cover the evidence.
  for (const toast of await page.locator('.toast').all()) await toast.getByRole('button').click().catch(() => undefined);
  await expect(page.locator('.toast')).toHaveCount(0);
  // Full-page captures start at the top so the sticky header sits above the content it belongs to.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `docs/acceptance/screenshots/phase6-${name}-${project}.png`, fullPage: true });
}
// Screenshots are named by layout; the improver projects run the same layouts on their own servers.
const layout = (info: TestInfo) => String(info.project.metadata.layout ?? info.project.name);
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function signIn(page: Page) {
  await page.goto('/'); await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  // Drafts need an eligible account and the judge needs a key; both run against simulated providers.
  expect((await page.request.post('/hub/accounts', { data: { schema: 'add-account-v1', runtime: 'claude', label: `Improver fixture ${randomUUID().slice(0, 8)}`, kind: 'subscription', secret: `fixture-${randomUUID()}` } })).ok()).toBe(true);
  expect((await page.request.put('/hub/secrets/jev', { data: { schema: 'save-secret-v1', value: `fixture-${randomUUID()}` } })).ok()).toBe(true);
}
async function state(page: Page) { return ImproverStateSchema.parse(await (await page.request.get('/api/improver')).json()); }
async function configuration(page: Page) { return ConfigRevisionSchema.parse(await (await page.request.get('/hub/config')).json()); }
async function openImprover(page: Page) {
  await page.goto('/settings/improver'); await expect(page.getByRole('heading', { name: 'Improver', exact: true })).toBeVisible();
  await expect(page.getByText('Loading suggestions…')).toHaveCount(0);
}
async function setJobs(page: Page, jobs: { routing: boolean; memory: boolean; context: boolean; mode?: 'apply-and-tell' | 'suggest' }) {
  const panel = page.getByRole('region', { name: 'Schedule and jobs' });
  await panel.getByRole('checkbox', { name: 'Routing suggestions', exact: true }).setChecked(jobs.routing);
  await panel.getByRole('checkbox', { name: 'Memory care', exact: true }).setChecked(jobs.memory);
  await panel.getByRole('checkbox', { name: 'Context suggestions for AGENTS.md', exact: true }).setChecked(jobs.context);
  if (jobs.mode) await panel.getByRole('combobox', { name: 'Memory care mode' }).selectOption(jobs.mode);
  const save = panel.getByRole('button', { name: 'Save schedule and jobs', exact: true });
  if (await save.isEnabled()) { await save.click(); await expect(save).toBeDisabled(); }
  const settings = (await configuration(page)).configuration['x-jevellan'].improver;
  expect({ routing: settings.routing.enabled, memory: settings.memory.enabled, context: settings.context.enabled }).toEqual({ routing: jobs.routing, memory: jobs.memory, context: jobs.context });
}
/** Presses Run now and waits until every job of that run has finished. */
async function runNow(page: Page) {
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/improver' && (value.request().postData() ?? '').includes('"run-now"'));
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  const run = ImproverRunSchema.parse(await (await response).json());
  await expect.poll(async () => {
    const jobs = (await state(page)).jobs.filter(job => job.scope.cycle.kind === 'manual' && job.scope.cycle.id === run.id);
    const expected = (run.routing ? 1 : 0) + run.projects.filter(entry => entry.projectId === 'improver_sandbox').length;
    const sandbox = jobs.filter(job => job.scope.kind === 'routing' || job.scope.projectId === 'improver_sandbox');
    return sandbox.length === expected && sandbox.every(job => job.status !== 'running');
  }, { timeout: 240_000, intervals: [1000] }).toBe(true);
  return run;
}
function card(page: Page, title: string | RegExp) { return page.locator('article.suggestion-card:not(.report-card)').filter({ has: page.getByRole('heading', { name: title, exact: typeof title === 'string' }) }); }
async function sandboxPath(page: Page) {
  const projects = ProjectsListSchema.parse(await (await page.request.get('/hub/projects')).json());
  return Object.values(projects.projects.find(row => row.project.id === 'improver_sandbox')!.project.paths)[0]!;
}
function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const a = before as Record<string, unknown>; const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => changedPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path];
}
const description = (value: Configuration, id: string) => value['x-jevellan'].menu.find(entry => entry.id === id)!.description;
const seeded = ['Prefer GPT for implement steps', 'Prefer Opus for review steps', 'Prefer Opus for review steps, revised', 'Prefer Sonnet for plan steps'];
/** Open cards from groups this journey did not seed; other tests' corrections on a shared server can form them. */
async function otherOpenCards(page: Page) { return (await state(page)).cards.filter(entry => !entry.decided && !seeded.includes(entry.title)).length; }
/**
 * Routing suggestions are checked against the saved cases, which need the standard models in the menu. Other tests
 * on a shared server may replace the menu, so the standard entries are restored (kept alongside any others) first.
 */
async function standardMenu(page: Page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await configuration(page); const menu = current.configuration['x-jevellan'].menu;
    const missing = seedConfiguration()['x-jevellan'].menu.filter(entry => !menu.some(model => model.id === entry.id));
    if (!missing.length) return;
    const next = structuredClone(current.configuration); next['x-jevellan'].menu = [...menu, ...missing];
    const saved = await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: current.revision, configuration: next } });
    if (saved.ok()) return;
    expect(saved.status(), 'Only a concurrent settings change may refuse this save.').toBe(409);
  }
  throw new Error('The standard model menu could not be restored.');
}
async function expectBadge(page: Page, own: number) {
  const pending = own + await otherOpenCards(page);
  await expect(page.getByLabel(`${pending} pending suggestions`, { exact: true })).toHaveText(String(pending));
  await expect(page.getByRole('heading', { name: `Waiting for you (${pending})`, exact: true })).toBeVisible();
}

test('J10: routing suggestions show the badge, apply and undo one field, change in plain words and stay dismissed', async ({ page }, info) => {
  test.setTimeout(600_000);
  await signIn(page); await standardMenu(page); await openImprover(page); await setJobs(page, { routing: true, memory: false, context: false });
  await runNow(page);
  const implement = card(page, 'Prefer GPT for implement steps'); const review = card(page, 'Prefer Opus for review steps');
  await expect(implement).toBeVisible(); await expect(review).toBeVisible();
  // The badge counts every open suggestion: the two seeded groups, plus any a concurrent test's corrections formed.
  await expectBadge(page, 2);
  await expect(implement).toContainText('Based on 3 corrections (0 with undo)'); await expect(implement).toContainText('Checked against 24 saved cases');
  await expect(implement).toContainText('Simulated judge responses.'); await expect(implement.getByLabel('Suggested change')).toContainText('Preferred for implement steps.');
  await shot(page, 'j10-suggestions', layout(info));

  // Apply edits exactly one field as a new configuration revision.
  const before = await configuration(page); const original = description(before.configuration, 'codex-gpt');
  await implement.getByRole('button', { name: 'Apply', exact: true }).click();
  const applied = card(page, 'Prefer GPT for implement steps'); await expect(applied.getByText('Applied.', { exact: true })).toBeVisible();
  const after = await configuration(page); expect(after.revision).toBe(before.revision + 1); expect(after.changedBy.source).toBe('improver');
  const index = before.configuration['x-jevellan'].menu.findIndex(entry => entry.id === 'codex-gpt');
  expect(changedPaths(before.configuration, after.configuration)).toEqual([`/x-jevellan/menu/${index}/description`]);
  expect(description(after.configuration, 'codex-gpt')).toBe(`${original} Preferred for implement steps.`);
  // An unrelated edit made within the Undo window survives the Undo.
  const edited = structuredClone(after.configuration); edited['x-jevellan'].effortGuide.low = 'Quick, obvious work only.';
  expect((await page.request.put('/hub/config', { data: { schema: 'config-write-v1', revision: after.revision, configuration: edited } })).ok()).toBe(true);
  await applied.getByRole('button', { name: /^Undo/ }).click();
  await expect(card(page, 'Prefer GPT for implement steps').getByText('Undone', { exact: true })).toBeVisible();
  const undone = (await configuration(page)).configuration;
  expect(description(undone, 'codex-gpt')).toBe(original); expect(undone['x-jevellan'].effortGuide.low).toBe('Quick, obvious work only.');
  await shot(page, 'j10-undo', layout(info));

  // Change it in plain words, then apply the revised diff.
  await review.getByRole('button', { name: 'Change it', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the suggestion' });
  await dialog.getByLabel('Or say what you want instead').fill('Only for reviews of the improver fixture.');
  await dialog.getByRole('button', { name: 'Revise the suggestion', exact: true }).click();
  const revised = dialog.getByRole('region', { name: 'Revised suggestion' });
  await expect(revised).toContainText('Only for reviews of the improver fixture.', { timeout: 120_000 }); await expect(revised).toContainText('Checked against 24 saved cases');
  await shot(page, 'j10-change-it', layout(info));
  const opus = description((await configuration(page)).configuration, 'claude-opus');
  await dialog.getByRole('button', { name: 'Apply this', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(card(page, 'Prefer Opus for review steps, revised').getByText('Applied.', { exact: true })).toBeVisible();
  expect(description((await configuration(page)).configuration, 'claude-opus')).toBe(`${opus} Only for reviews of the improver fixture.`);
  expect((await state(page)).suggestions.find(row => row.suggestion.draft.title === 'Prefer Opus for review steps, revised')?.suggestion.outcomes.at(-1)?.kind).toBe('applied-after-change');

  // A third group, dismissed with a reason, does not come back on the next run.
  const control = new URL(page.url()); control.port = String(Number(control.port) + 200); control.pathname = '/improver/third-group';
  expect((await fetch(control, { method: 'POST' })).status).toBe(204);
  await runNow(page); const plan = card(page, 'Prefer Sonnet for plan steps'); await expect(plan).toBeVisible();
  await expectBadge(page, 1);
  await plan.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const dismiss = page.getByRole('dialog', { name: 'Dismiss suggestion' }); await dismiss.getByLabel('Why not? (optional)').fill('Plans stay on Fable.');
  await dismiss.getByRole('button', { name: 'Dismiss suggestion', exact: true }).click();
  await expect(card(page, 'Prefer Sonnet for plan steps')).toContainText('“Plans stay on Fable.”'); await expect(card(page, 'Prefer Sonnet for plan steps')).toContainText('Dismissed');
  const again = await runNow(page); await page.reload();
  const after2 = await state(page);
  expect(after2.jobs.find(job => job.scope.kind === 'routing' && job.scope.cycle.kind === 'manual' && job.scope.cycle.id === again.id)?.status).toBe('complete');
  expect(after2.suggestions.filter(row => row.suggestion.draft.title === 'Prefer Sonnet for plan steps')).toHaveLength(1);
  expect(after2.cards.filter(entry => !entry.decided && seeded.includes(entry.title))).toEqual([]);
  if (!after2.cards.some(entry => !entry.decided)) await expect(page.getByText('No suggestions right now.', { exact: true })).toBeVisible();
  await shot(page, 'j10-dismissed', layout(info));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('J12: memory care applies and tells, shows and undoes its commit, suggests only on request, refuses stale patches and proposes an AGENTS.md rule', async ({ page }, info) => {
  test.setTimeout(900_000);
  await signIn(page); await openImprover(page); await setJobs(page, { routing: false, memory: true, context: true, mode: 'apply-and-tell' });
  const path = await sandboxPath(page); const origin = git(path, 'remote', 'get-url', 'origin'); const start = git(origin, 'rev-parse', 'main');
  await runNow(page);

  // Run now: exactly one memory-care commit, published, and a morning card with the counts.
  expect(git(origin, 'log', '--format=%s', `${start}..main`)).toBe('memory: nightly care (1 merged, 1 archived, 1 links)');
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'show', 'HEAD:.jevellan/memory/archive/old-caching-idea.md')).toContain('caching builds in S3');
  const report = page.getByRole('article', { name: 'Memory care for Improver sandbox', exact: true });
  await expect(report.getByRole('heading', { name: 'Memory care for Improver sandbox: merged 1 note, archived 1, fixed 1 link.' })).toBeVisible();
  if (layout(info).startsWith('desktop')) await expect(page.locator('.improver-notice')).toContainText('Memory care for Improver sandbox: merged 1 note, archived 1, fixed 1 link.');
  await expect(page.getByRole('region', { name: 'Last runs' })).toContainText('Merged 1 note, archived 1, fixed 1 link, reconciled 1');

  // The same run proposes the working rule stated by three notes, as a card that is never applied by itself.
  const rule = card(page, 'Run the tests before pushing'); await expect(rule).toBeVisible();
  await expect(rule).toContainText('AGENTS.md'); await expect(rule.getByLabel('Suggested change')).toContainText('+- Run the tests before every push.');
  await rule.locator('summary').click(); await expect(rule.getByRole('button', { name: 'Run tests before pushing', exact: true })).toBeVisible();
  expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe('# Improver sandbox\n\nRun npm test.\n');
  await shot(page, 'j12-morning-card', layout(info));

  await report.getByRole('button', { name: 'View changes', exact: true }).click();
  const changes = report.getByLabel('Memory care changes'); await expect(changes).toContainText('+++ b/.jevellan/memory/archive/old-caching-idea.md'); await expect(changes).toContainText('-status: unresolved');
  await shot(page, 'j12-view-changes', layout(info));
  const applied = git(origin, 'rev-parse', 'main');
  await report.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(report.getByText('Undone', { exact: true })).toBeVisible({ timeout: 120_000 });
  expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('Revert "memory: nightly care (1 merged, 1 archived, 1 links)"'); expect(git(origin, 'rev-parse', 'main^')).toBe(applied);
  expect(readFileSync(join(path, '.jevellan/memory/old-caching-idea.md'), 'utf8')).toContain('caching builds in S3');

  // Suggest only: a card, and the checkout stays untouched until Apply.
  await setJobs(page, { routing: false, memory: true, context: true, mode: 'suggest' });
  const head = git(origin, 'rev-parse', 'main'); await runNow(page);
  const suggestion = card(page, 'Suggested memory care for Improver sandbox'); await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText('This change merged 1 note'); await expect(suggestion).toContainText('Waiting for you');
  expect(git(origin, 'rev-parse', 'main')).toBe(head); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(git(path, 'status', '--porcelain')).toBe('');
  await shot(page, 'j12-suggest-only', layout(info));

  // A note changes elsewhere; Apply refuses the stale patch and recomputes it from the newer text.
  const other = mkdtempSync(join(tmpdir(), 'jevellan-improver-other-'));
  try {
    git(tmpdir(), 'clone', origin, other);
    writeFileSync(join(other, '.jevellan/memory/test-conventions.md'), '---\ntitle: Test conventions\n---\nUse Vitest with globals enabled and run it in CI.\n');
    git(other, 'commit', '-am', 'Newer note from another device'); git(other, 'push');
  } finally { rmSync(other, { recursive: true, force: true }); }
  const upstream = git(origin, 'rev-parse', 'main');
  await suggestion.getByRole('button', { name: 'Apply', exact: true }).click();
  const recomputed = card(page, 'Suggested memory care for Improver sandbox');
  await expect(recomputed).toContainText('The files changed since this suggestion was made, so it was recomputed. Review it again.', { timeout: 180_000 });
  await expect(recomputed.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  expect(git(origin, 'rev-parse', 'main')).toBe(upstream); expect(readFileSync(join(path, '.jevellan/memory/test-conventions.md'), 'utf8')).toContain('run it in CI');
  await expect(recomputed.getByLabel('Suggested change')).toContainText('run it in CI');
  await shot(page, 'j12-recomputed', layout(info));
  await recomputed.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(card(page, 'Suggested memory care for Improver sandbox').getByText('Applied.', { exact: true })).toBeVisible({ timeout: 180_000 });
  expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('memory: nightly care (1 merged, 0 archived, 1 links)');
  expect(git(path, 'show', 'HEAD:.jevellan/memory/test-conventions-2.md')).toContain('run it in CI');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
