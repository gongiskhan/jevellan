import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackgroundDraftResultSchema, CheckoutOwnership, Homes, ImproverStateSchema, MemoryCareReportRowSchema, ProjectRevisionRecordSchema, ProjectSchema, ProjectSuggestionRowSchema, ProjectSuggestionSchema,
  PublicationLeases, SecretRedactor, seedConfiguration, type BackgroundDraftRequest, type BackgroundDraftResult, type ImproverState, type Project,
} from '../packages/core/dist/index.js';
import { HubDatabase, ProjectImproverHub } from '../packages/mesh/dist/index.js';
import { buildJevRequest, parseJevResponse, type DecisionClient } from '../packages/decisions/dist/index.js';
import { Improver, ProjectImprover } from '../apps/daemon/dist/index.js';

// Jev and the generative drafts are scripted here (simulated); Git, the bare origin, ownership and publication are real.
let root: string; let homes: Homes; let hub: HubDatabase; let project: Project; let checkout: string; let origin: string;
let projects: ProjectImproverHub; let executor: ProjectImprover; let improver: Improver;
let drafts: BackgroundDraftRequest[]; let questions: string[]; let answer: (id: string) => number; let searches: Map<string, string[]>;
let draftContent: (request: BackgroundDraftRequest) => unknown;
const memory = '.jevellan/memory';
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } }).trim();
}
function write(path: string, content: string) { mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), content); }
function read(path: string) { return readFileSync(join(checkout, path), 'utf8'); }
const duplicate = `---\ntitle: Test Conventions\n---\nTests run with Vitest and globals are enabled.\n`;
const original = `---\ntitle: Test conventions\n---\nUse Vitest with globals enabled.\n`;
const unresolved = `---\ntitle: Deploy notes\nstatus: unresolved\n---\nDeploy with npm run deploy. See [[Missing guide]].\n\n## Merged from laptop on 2026-09-20\n\nDeploy by hand from the release branch.\n`;
const stale = `---\ntitle: Old idea about caching\n---\nWe once considered caching builds in S3.\n`;

function careDraft(request: BackgroundDraftRequest) {
  const tasks = JSON.parse(request.files['tasks.json']!) as { merge: string[][]; reconcile: string[]; fixLinks: Array<{ note: string; target: string }> };
  const files: Array<{ path: string; content: string | null }> = [];
  for (const [keep, remove] of tasks.merge) files.push({ path: keep!, content: `${request.files[`memory/${keep}`]!}\nMerged: ${request.files[`memory/${remove}`]!.split('---\n')[2]!.trim()}\n` }, { path: remove!, content: null });
  for (const path of tasks.reconcile) files.push({ path, content: '---\ntitle: Deploy notes\n---\nDeploy with npm run deploy. See [[Test conventions]].\n\n## History\n\nDeploy by hand from the release branch.\n' });
  return { schema: 'memory-patch-draft-v1', summary: 'Merged, reconciled and fixed.', files };
}
function result(request: BackgroundDraftRequest, content: unknown): BackgroundDraftResult {
  return BackgroundDraftResultSchema.parse({ schema: 'background-draft-result-v1', runId: request.id, modelId: 'fixture_model', accountId: 'fixture_account', effort: 'high', usage: { inputTokens: 10, outputTokens: 5, costSource: 'unknown' },
    handoff: { schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'A simulated draft.', result: { type: request.resultType, ref: `blobs/${'a'.repeat(64)}` }, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] },
    content });
}
function configure(update: (settings: ReturnType<typeof seedConfiguration>['x-jevellan']['improver']) => void) {
  // The nightly schedule stays off so each test sees only its own Run now.
  const current = hub.configuration.current()!; current.configuration['x-jevellan'].improver.schedule.enabled = false; update(current.configuration['x-jevellan'].improver);
  hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' });
}
async function request(input: unknown) { const value = await improver.request({ schema: 'improver-request-v1', ...(input as object) }, 'hub'); await executor.idle(); return value; }
async function state(): Promise<ImproverState> { return ImproverStateSchema.parse(await improver.request({ schema: 'improver-request-v1', operation: 'state' }, 'hub')); }
async function runNow(id: string) { await request({ operation: 'run-now', clientRequestId: id }); await executor.tick(); await executor.idle(); }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-memory-care-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'home'), join(root, 'user'));
  hub = new HubDatabase(homes, 'hub'); hub.configuration.put(seedConfiguration(), 0, { deviceId: 'hub', source: 'install' });
  origin = join(root, 'origin.git'); git(root, ['init', '--bare', '-b', 'main', origin]);
  checkout = join(root, 'sandbox'); git(root, ['clone', origin, checkout]);
  git(checkout, ['config', 'user.name', 'Fixture']); git(checkout, ['config', 'user.email', 'fixture@example.invalid']);
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  write('AGENTS.md', '# Sandbox\n\nRun npm test.\n'); write(`${memory}/old-idea.md`, stale);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Seed'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
  write(`${memory}/test-conventions.md`, original); write(`${memory}/test-conventions-2.md`, duplicate); write(`${memory}/deploy.md`, unresolved);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Notes']); git(checkout, ['push', '-u', 'origin', 'main']);
  // A failing test command proves memory-only commits publish without a test run.
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'sandbox', name: 'Sandbox', paths: { hub: checkout }, branchPolicy: 'main', testCommand: 'false', memory: { mode: 'repo', dir: memory }, context: { state: 'linked' } });
  hub.put('projects', project.id, ProjectSchema, project, 0);
  drafts = []; questions = []; searches = new Map(); answer = id => id.startsWith('pair_') ? 0.9 : id.startsWith('stale_') ? 0.1 : 0.9; draftContent = careDraft;
  const client: DecisionClient = { async decide(input) {
    const wire = buildJevRequest(input);
    const answers = Object.fromEntries(Object.keys(wire.questions).map(id => { questions.push(id); return [id, { type: 'noul', noul: answer(id) }]; }));
    return parseJevResponse(JSON.stringify({ model: 'simulated-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } }), wire.questions);
  } };
  const draft = async (request: BackgroundDraftRequest) => { drafts.push(request); return result(request, draftContent(request)); };
  projects = new ProjectImproverHub(hub, { hubId: 'hub', devices: () => [] });
  const ownership = new CheckoutOwnership(hub, homes, 'hub');
  executor = new ProjectImprover({ deviceId: 'hub', deviceName: 'Fixture hub', homes, redactor: new SecretRedactor(), ready: Promise.resolve(),
    hub: async input => projects.request('hub', input), projects: async () => [hub.get('projects', 'sandbox', ProjectSchema)!.document], ownership, leases: new PublicationLeases(hub),
    assertOutsideIdle: async () => undefined, memory: () => ({ sync: async () => undefined, search: async query => (searches.get(query) ?? []).map(permalink => ({ permalink })) }),
    client: () => client, jevModel: async () => 'jev-fixture', draft, handoffs: () => ['Added a Vitest suite for the sum helper.'], enterOperation: () => () => undefined });
  improver = new Improver({ hub, deviceId: 'hub', ready: Promise.resolve(), evidence: 'simulated', client: () => client, draft, enterOperation: () => () => undefined,
    projects, kick: () => { void executor.tick(); } });
});
afterEach(async () => { await executor.close(); await improver.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });

test('Run now applies one published memory-care commit with a morning card, View changes and a published Undo', async () => {
  configure(settings => { settings.context.enabled = false; settings.routing.enabled = false; });
  const upstream = git(origin, ['rev-parse', 'main']);
  await runNow('first');
  expect(questions.sort()).toEqual(['pair_0', 'stale_0']); expect(drafts).toHaveLength(1);
  expect(Object.keys(drafts[0]!.files).filter(name => name.startsWith('memory/')).sort()).toEqual(['memory/deploy.md', 'memory/test-conventions-2.md', 'memory/test-conventions.md']);
  const log = git(origin, ['log', '--format=%s', `${upstream}..main`]).split('\n');
  expect(log).toEqual(['memory: nightly care (1 merged, 1 archived, 1 links)']);
  expect(git(origin, ['log', '-1', '--format=%B', 'main'])).toBe('memory: nightly care (1 merged, 1 archived, 1 links)');
  expect(git(checkout, ['status', '--porcelain'])).toBe(''); expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(origin, ['rev-parse', 'main']));
  expect(existsSync(join(checkout, memory, 'old-idea.md'))).toBe(false); expect(read(`${memory}/archive/old-idea.md`)).toBe(stale);
  expect(read(`${memory}/deploy.md`)).not.toContain('status: unresolved'); expect(read(`${memory}/deploy.md`)).toContain('[[Test conventions]]');
  const view = await state(); const report = view.reports[0]!.report;
  expect(report.counts).toEqual({ merged: 1, archived: 1, fixedLinks: 1, reconciled: 1 }); expect(report.commit).toBe(git(origin, ['rev-parse', 'main'])); expect(report.published).toBe(true);
  expect(report.patch.diff).toContain(`+++ b/${memory}/archive/old-idea.md`); expect(report.patch.diff).toContain('-status: unresolved');
  expect(report.evidence.map(note => note.permalink).sort()).toEqual(['deploy.md', 'old-idea.md', 'test-conventions-2.md', 'test-conventions.md']);
  expect(view.notice?.lines).toContain('Memory care for Sandbox: merged 1 note, archived 1, fixed 1 link.');
  expect(view.lastRuns).toEqual([expect.objectContaining({ kind: 'memory', projectId: 'sandbox', status: 'complete', result: 'Merged 1 note, archived 1, fixed 1 link, reconciled 1', commit: report.commit })]);
  expect(view.jobs.find(job => job.scope.kind === 'memory')?.status).toBe('complete');
  expect((await projects.log(view.jobs[0]!.id))?.entries.map(entry => entry.stage)).toEqual(['started', 'synchronized', 'collected', 'judged', 'drafted', 'published', 'complete']);
  // The quiet line is shown once.
  await request({ operation: 'notice-seen', id: view.notice!.id }); expect((await state()).notice).toBeNull();

  const undo = MemoryCareReportRowSchema.parse(await request({ operation: 'report', reportId: report.id, input: { schema: 'memory-care-report-action-v1', clientRequestId: 'undo', revision: view.reports[0]!.revision, kind: 'undo' } }));
  expect(undo.report.status).toBe('undoing'); await executor.idle();
  const undone = (await state()).reports[0]!.report;
  expect(undone).toMatchObject({ status: 'undone', error: null }); expect(undone.undoCommit).toBe(git(origin, ['rev-parse', 'main']));
  expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('Revert "memory: nightly care (1 merged, 1 archived, 1 links)"');
  expect(read(`${memory}/old-idea.md`)).toBe(stale); expect(read(`${memory}/test-conventions-2.md`)).toBe(duplicate); expect(read(`${memory}/deploy.md`)).toBe(unresolved);
  expect(git(checkout, ['status', '--porcelain'])).toBe(''); expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: false });
}, 60_000);

test('Suggest only leaves the checkout untouched until Apply, then commits, publishes and can Undo within 30 seconds', async () => {
  configure(settings => { settings.context.enabled = false; settings.routing.enabled = false; settings.memory.mode = 'suggest'; });
  const head = git(origin, ['rev-parse', 'main']); await runNow('suggest');
  let view = await state(); expect(view.reports).toEqual([]); expect(view.pending).toBe(1);
  const row = view.projectSuggestions[0]!;
  expect(row.suggestion).toMatchObject({ kind: 'memory-care', status: 'pending', counts: { merged: 1, archived: 1, fixedLinks: 1, reconciled: 1 } });
  expect(row.suggestion.patch.diff).toContain(`+++ b/${memory}/archive/old-idea.md`); expect(view.notice?.lines).toEqual(['1 new suggestion from the improver']);
  expect(view.cards).toEqual([expect.objectContaining({ kind: 'memory-care', id: row.suggestion.id, revision: row.revision, status: 'pending', decided: false, projectName: 'Sandbox',
    counts: { merged: 1, archived: 1, fixedLinks: 1, reconciled: 1 }, actions: { apply: true, undo: false, dismiss: true, change: true }, requests: { action: 'project-suggestion-action-v1', revision: 'project-revision-request-v1' } })]);
  expect(view.cards[0]!.evidence).toMatchObject({ kind: 'notes', notes: expect.arrayContaining([expect.objectContaining({ permalink: 'old-idea.md' })]) });
  expect(view.cards[0]!.change).toMatchObject({ kind: 'patch', diff: row.suggestion.patch.diff });
  expect(git(origin, ['rev-parse', 'main'])).toBe(head); expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head); expect(git(checkout, ['status', '--porcelain'])).toBe('');
  expect(read(`${memory}/old-idea.md`)).toBe(stale);
  // A second run does not duplicate the waiting suggestion or draft again.
  await runNow('suggest_again'); expect((await state()).projectSuggestions).toHaveLength(1); expect(drafts).toHaveLength(1);

  const applying = ProjectSuggestionRowSchema.parse(await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply', revision: row.revision, previewId: null } }));
  expect(applying.suggestion.status).toBe('applying'); await executor.idle();
  view = await state(); const applied = view.projectSuggestions[0]!;
  expect(applied.suggestion).toMatchObject({ status: 'applied', applied: { published: true } }); expect(applied.suggestion.outcomes.at(-1)?.kind).toBe('applied');
  expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('memory: nightly care (1 merged, 1 archived, 1 links)');
  expect(Date.parse(applied.suggestion.applied!.undoUntil) - Date.parse(applied.suggestion.applied!.at)).toBe(30_000); expect(view.pending).toBe(0);
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'undo', clientRequestId: 'undo', revision: applied.revision } });
  const undone = (await state()).projectSuggestions[0]!.suggestion;
  expect(undone.status).toBe('undone'); expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('Revert "memory: nightly care (1 merged, 1 archived, 1 links)"');
  expect(read(`${memory}/old-idea.md`)).toBe(stale);
}, 60_000);

test('Apply refuses a stale patch after a note changed and recomputes it instead of overwriting the newer text', async () => {
  configure(settings => { settings.context.enabled = false; settings.routing.enabled = false; settings.memory.mode = 'suggest'; });
  await runNow('stale'); const row = (await state()).projectSuggestions[0]!;
  const newer = `---\ntitle: Test conventions\n---\nUse Vitest with globals enabled and run it in CI.\n`;
  const other = join(root, 'other'); git(root, ['clone', origin, other]); writeFileSync(join(other, memory, 'test-conventions.md'), newer);
  git(other, ['commit', '-am', 'Newer note']); git(other, ['push']); const upstream = git(origin, ['rev-parse', 'main']);
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply_stale', revision: row.revision, previewId: null } });
  const recomputed = (await state()).projectSuggestions[0]!;
  expect(recomputed.suggestion.status).toBe('pending'); expect(recomputed.revision).toBeGreaterThan(row.revision);
  expect(recomputed.suggestion.error).toContain('recomputed'); expect(recomputed.suggestion.outcomes).toEqual([]);
  expect(git(origin, ['rev-parse', 'main'])).toBe(upstream); expect(read(`${memory}/test-conventions.md`)).toBe(newer);
  const before = recomputed.suggestion.patch.files.find(file => file.path === `${memory}/test-conventions.md`);
  expect(before?.beforeText).toBe(newer); expect(drafts).toHaveLength(2);
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply_current', revision: recomputed.revision, previewId: null } });
  expect((await state()).projectSuggestions[0]!.suggestion.status).toBe('applied'); expect(existsSync(join(checkout, memory, 'test-conventions.md'))).toBe(false);
  expect(read(`${memory}/test-conventions-2.md`)).toContain('run it in CI');
}, 60_000);

test('an owned checkout is skipped and reported; the claim is not retried for the same run', async () => {
  configure(settings => { settings.context.enabled = false; settings.routing.enabled = false; });
  const ownership = new CheckoutOwnership(hub, homes, 'hub'); await ownership.acquire(project, { conversationId: 'conversation', conversationTitle: 'Add a feature', workId: 'work' });
  const head = git(origin, ['rev-parse', 'main']); await runNow('owned');
  const view = await state();
  expect(view.lastRuns[0]).toMatchObject({ kind: 'memory', status: 'skipped', result: 'skipped: Sandbox is in use' });
  expect(drafts).toEqual([]); expect(questions).toEqual([]); expect(git(origin, ['rev-parse', 'main'])).toBe(head);
  await executor.tick(); await executor.idle(); expect((await state()).jobs.filter(job => job.scope.kind === 'memory')).toHaveLength(1);
});

test('three notes stating the same working rule produce an AGENTS.md suggestion that is never auto-applied; Change it and Apply publish it after verification', async () => {
  configure(settings => { settings.memory.enabled = false; settings.routing.enabled = false; });
  const saved = hub.get('projects', 'sandbox', ProjectSchema)!; hub.put('projects', 'sandbox', ProjectSchema, { ...saved.document, testCommand: 'test -f AGENTS.md' }, saved.revision);
  const rules = { 'push-tests.md': 'Run tests before pushing', 'ci-green.md': 'Always run the tests before a push', 'pre-push.md': 'Tests must pass before pushing' };
  for (const [name, title] of Object.entries(rules)) write(`${memory}/${name}`, `---\ntitle: ${title}\n---\n${title}.\n`);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Rules']); git(checkout, ['push']);
  for (const title of Object.values(rules)) searches.set((title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' OR '), Object.keys(rules));
  draftContent = request => ({ schema: 'context-draft-v1', title: 'Run the tests before pushing', reason: 'Three notes state this rule.', after: `${request.files['instructions.md']}\n## Working rules\n\n- Run the tests before every push.\n` });
  const head = git(origin, ['rev-parse', 'main']); await runNow('context');
  let view = await state(); const row = view.projectSuggestions[0]!;
  expect(questions.filter(id => id.startsWith('rule_'))).toHaveLength(1);
  expect(row.suggestion).toMatchObject({ kind: 'context', status: 'pending', counts: null, title: 'Run the tests before pushing' });
  expect(row.suggestion.evidence.map(note => note.permalink).sort()).toEqual(['ci-green.md', 'pre-push.md', 'push-tests.md']);
  expect(row.suggestion.patch.files.map(file => file.path)).toEqual(['AGENTS.md']); expect(row.suggestion.patch.diff).toContain('+- Run the tests before every push.');
  expect(git(origin, ['rev-parse', 'main'])).toBe(head); expect(read('AGENTS.md')).toBe('# Sandbox\n\nRun npm test.\n');

  const after = '# Sandbox\n\nRun npm test.\n\n## Working rules\n\n- Run `npm test` before every push.\n';
  const revise = { operation: 'revise', input: { schema: 'project-revision-request-v1', kind: 'text', clientRequestId: 'edit', suggestionId: row.suggestion.id, revision: row.revision, files: [{ path: 'AGENTS.md', after }] } };
  const preview = ProjectRevisionRecordSchema.parse(await request(revise)); expect(preview.status).toBe('complete'); expect(preview.preview!.patch.diff).toContain('+- Run `npm test` before every push.');
  expect(await request(revise)).toEqual(preview); expect(read('AGENTS.md')).toBe('# Sandbox\n\nRun npm test.\n');
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply_context', revision: row.revision, previewId: preview.preview!.id } });
  view = await state(); const applied = view.projectSuggestions[0]!.suggestion;
  expect(applied).toMatchObject({ status: 'applied', applied: { published: true } }); expect(applied.outcomes.at(-1)?.kind).toBe('applied-after-change');
  expect(read('AGENTS.md')).toBe(after); expect(git(origin, ['log', '-1', '--format=%s', 'main'])).toBe('context: Run the tests before pushing');
  // Dismissed or decided rules are not suggested again while their notes are unchanged.
  await runNow('context_again'); expect((await state()).projectSuggestions).toHaveLength(1); expect(drafts).toHaveLength(1);
}, 60_000);

test('dismissing a context suggestion records the reason and suppresses the same unchanged notes', async () => {
  configure(settings => { settings.memory.enabled = false; settings.routing.enabled = false; });
  const rules = { 'a.md': 'Keep commits small', 'b.md': 'Commits stay small', 'c.md': 'Prefer small commits' };
  for (const [name, title] of Object.entries(rules)) write(`${memory}/${name}`, `---\ntitle: ${title}\n---\n${title}.\n`);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Rules']); git(checkout, ['push']);
  for (const title of Object.values(rules)) searches.set((title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' OR '), Object.keys(rules));
  draftContent = request => ({ schema: 'context-draft-v1', title: 'Keep commits small', reason: 'Three notes.', after: `${request.files['instructions.md']}\n- Keep commits small.\n` });
  await runNow('dismiss'); const row = (await state()).projectSuggestions[0]!;
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'dismiss', clientRequestId: 'dismiss', revision: row.revision, reason: 'Already in the README.' } });
  const dismissed = (await state()).projectSuggestions[0]!.suggestion;
  expect(dismissed.status).toBe('dismissed'); expect(dismissed.outcomes.at(-1)).toMatchObject({ kind: 'dismissed', reason: 'Already in the README.' });
  await runNow('dismiss_again'); expect((await state()).projectSuggestions).toHaveLength(1); expect(drafts).toHaveLength(1);
});

test('a checkout left owned by a stopped improver process is restored, its unpublished commit saved and discarded, and ownership released', async () => {
  configure(settings => { settings.memory.enabled = false; settings.context.enabled = false; settings.routing.enabled = false; });
  let dead = 4_194_000; for (;;) { try { process.kill(dead, 0); dead--; } catch { break; } }
  const owner = { conversationId: 'improver_crashed', conversationTitle: 'Memory care', workId: 'improver_crashed' };
  await new CheckoutOwnership(hub, homes, 'hub', dead).acquire(project, owner);
  const head = git(origin, ['rev-parse', 'main']);
  write(`${memory}/test-conventions.md`, 'Half-applied.\n'); git(checkout, ['commit', '-am', 'memory: nightly care (interrupted)']); const interrupted = git(checkout, ['rev-parse', 'HEAD']);
  await executor.tick(); await executor.idle();
  expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head); expect(read(`${memory}/test-conventions.md`)).toBe(original); expect(git(checkout, ['status', '--porcelain'])).toBe('');
  expect(git(checkout, ['rev-parse', 'refs/jevellan/discard/improver_crashed/3'])).toBe(interrupted); expect(git(origin, ['rev-parse', 'main'])).toBe(head);
  expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: false });
});

test('a conversation that owns the checkout is never recovered by the improver', async () => {
  configure(settings => { settings.memory.enabled = false; settings.context.enabled = false; settings.routing.enabled = false; });
  let dead = 4_194_000; for (;;) { try { process.kill(dead, 0); dead--; } catch { break; } }
  await new CheckoutOwnership(hub, homes, 'hub', dead).acquire(project, { conversationId: 'conversation', conversationTitle: 'Add a feature', workId: 'work' });
  await executor.tick(); await executor.idle();
  expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: true, conversationId: 'conversation' });
});

test('plain-language Change it on a project suggestion runs one read-only draft and returns a checked preview without applying it', async () => {
  configure(settings => { settings.memory.enabled = false; settings.routing.enabled = false; });
  const rules = { 'a.md': 'Keep commits small', 'b.md': 'Commits stay small', 'c.md': 'Prefer small commits' };
  for (const [name, title] of Object.entries(rules)) write(`${memory}/${name}`, `---\ntitle: ${title}\n---\n${title}.\n`);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Rules']); git(checkout, ['push']);
  for (const title of Object.values(rules)) searches.set((title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' OR '), Object.keys(rules));
  draftContent = request => ({ schema: 'context-draft-v1', title: 'Keep commits small', reason: 'Three notes.', after: `${request.files['instructions.md']}\n- Keep commits small.\n` });
  await runNow('instruction'); const row = (await state()).projectSuggestions[0]!;
  draftContent = request => {
    expect(request.files['instruction.txt']).toBe('Say it applies to documentation commits too.'); expect(request.files['proposed/AGENTS.md']).toContain('- Keep commits small.');
    return { schema: 'project-revision-draft-v1', title: 'Keep every commit small', reason: 'Three notes; includes documentation.', files: [{ path: 'AGENTS.md', after: `${request.files['before/AGENTS.md']}\n- Keep every commit small, including documentation.\n` }] };
  };
  const started = ProjectRevisionRecordSchema.parse(await request({ operation: 'revise', input: { schema: 'project-revision-request-v1', kind: 'instruction', clientRequestId: 'words', suggestionId: row.suggestion.id, revision: row.revision, instruction: 'Say it applies to documentation commits too.' } }));
  expect(started.status).toBe('running'); await improver.waitRevision(started.id);
  const revision = ProjectRevisionRecordSchema.parse(await request({ operation: 'revision', id: started.id }));
  expect(revision).toMatchObject({ status: 'complete', preview: { source: 'instruction', title: 'Keep every commit small' } }); expect(revision.preview!.patch.diff).toContain('+- Keep every commit small, including documentation.');
  expect(drafts).toHaveLength(2); expect(drafts[1]!.resultType).toBe('suggestion'); expect(read('AGENTS.md')).toBe('# Sandbox\n\nRun npm test.\n');
  expect((await state()).projectSuggestions[0]!.suggestion.status).toBe('pending');
  expect((await state()).projectRevisions.map(record => record.id)).toEqual([started.id]);
});

/** Seeds three notes stating one rule and runs the context job, returning its pending card. */
async function contextSuggestion(id: string) {
  configure(settings => { settings.memory.enabled = false; settings.routing.enabled = false; });
  const rules = { 'push-tests.md': 'Run tests before pushing', 'ci-green.md': 'Always run the tests before a push', 'pre-push.md': 'Tests must pass before pushing' };
  for (const [name, title] of Object.entries(rules)) write(`${memory}/${name}`, `---\ntitle: ${title}\n---\n${title}.\n`);
  git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Rules']); git(checkout, ['push']);
  for (const title of Object.values(rules)) searches.set((title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' OR '), Object.keys(rules));
  draftContent = request => ({ schema: 'context-draft-v1', title: 'Run the tests before pushing', reason: 'Three notes state this rule.', after: `${request.files['instructions.md']}\n- Run the tests before every push.\n` });
  await runNow(id); return (await state()).projectSuggestions[0]!;
}
async function apply(row: { revision: number; suggestion: { id: string } }, id: string) {
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'apply', clientRequestId: id, revision: row.revision, previewId: null } });
  return (await state()).projectSuggestions.find(entry => entry.suggestion.id === row.suggestion.id)!;
}

test('an instruction change that Git ignores is applied without a commit, and Undo restores the text without reverting anyone else\'s commit', async () => {
  // AGENTS.md links to a CLAUDE.md that the repository ignores, so the edit leaves nothing to commit.
  git(checkout, ['rm', '-q', 'AGENTS.md']); write('CLAUDE.md', '# Sandbox\n\nRun npm test.\n'); write('.gitignore', 'CLAUDE.md\n');
  symlinkSync('CLAUDE.md', join(checkout, 'AGENTS.md')); git(checkout, ['add', '-A']); git(checkout, ['commit', '-m', 'Ignored instructions']); git(checkout, ['push']);
  const row = await contextSuggestion('ignored'); expect(row.suggestion.patch.files.map(file => file.path)).toEqual(['CLAUDE.md']);
  const head = git(origin, ['rev-parse', 'main']);
  const applied = await apply(row, 'apply_ignored');
  expect(applied.suggestion).toMatchObject({ status: 'applied', applied: { commit: null, published: false } }); expect(applied.suggestion.outcomes.at(-1)?.commit).toBeNull();
  expect(read('CLAUDE.md')).toContain('- Run the tests before every push.'); expect(git(origin, ['rev-parse', 'main'])).toBe(head); expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'undo', clientRequestId: 'undo_ignored', revision: applied.revision } });
  const undone = (await state()).projectSuggestions[0]!.suggestion;
  expect(undone.status).toBe('undone'); expect(read('CLAUDE.md')).toBe('# Sandbox\n\nRun npm test.\n');
  expect(git(origin, ['rev-parse', 'main'])).toBe(head); expect(git(origin, ['log', '--format=%s', '-3', 'main'])).not.toContain('Revert');
  expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: false });
}, 90_000);

test('Undo refuses a recorded commit that the improver did not create and publishes nothing', async () => {
  const saved = hub.get('projects', 'sandbox', ProjectSchema)!; hub.put('projects', 'sandbox', ProjectSchema, { ...saved.document, testCommand: 'test -f AGENTS.md' }, saved.revision);
  const row = await contextSuggestion('foreign'); const applied = await apply(row, 'apply_foreign'); expect(applied.suggestion.status).toBe('applied');
  const foreign = git(origin, ['rev-parse', 'main^']); const head = git(origin, ['rev-parse', 'main']);
  // A record from before this check could point at someone else's commit, such as the notes commit before it.
  const stored = hub.get('project-suggestions', row.suggestion.id, ProjectSuggestionSchema)!;
  hub.put('project-suggestions', row.suggestion.id, ProjectSuggestionSchema, { ...stored.document, applied: { ...stored.document.applied!, commit: foreign } }, stored.revision);
  const current = (await state()).projectSuggestions[0]!;
  await request({ operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'project-suggestion-action-v1', kind: 'undo', clientRequestId: 'undo_foreign', revision: current.revision } });
  const after = (await state()).projectSuggestions[0]!.suggestion;
  expect(after.status).toBe('applied'); expect(after.error).toContain('not a change this suggestion made');
  expect(git(origin, ['rev-parse', 'main'])).toBe(head); expect(git(checkout, ['status', '--porcelain'])).toBe('');
  expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: false });
}, 90_000);

test('a publication blocked after rebasing onto newer upstream work discards only the improver commit and releases the checkout', async () => {
  const row = await contextSuggestion('blocked');
  // The first test run pushes unrelated upstream work (as another device would during the done-gate); the run after the rebase then fails.
  const other = join(root, 'other'); git(root, ['clone', origin, other]); writeFileSync(join(other, 'upstream.txt'), 'Someone else\'s work.\n'); git(other, ['add', '-A']); git(other, ['commit', '-m', 'Upstream work']);
  const marker = join(root, 'pushed');
  const current = hub.get('projects', 'sandbox', ProjectSchema)!;
  hub.put('projects', 'sandbox', ProjectSchema, { ...current.document, testCommand: `if [ ! -f '${marker}' ]; then git -C '${other}' push -q origin main && touch '${marker}'; fi; test ! -f upstream.txt` }, current.revision);
  const result = await apply(row, 'apply_blocked');
  const upstream = git(other, ['rev-parse', 'HEAD']);
  expect(result.suggestion.status).toBe('pending'); expect(result.suggestion.error).toBeTruthy();
  expect(git(origin, ['rev-parse', 'main'])).toBe(upstream); expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(upstream); expect(git(checkout, ['status', '--porcelain'])).toBe('');
  expect(read('AGENTS.md')).toBe('# Sandbox\n\nRun npm test.\n'); expect(read('upstream.txt')).toBe('Someone else\'s work.\n');
  expect(git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/jevellan/discard/'])).not.toBe('');
  expect(await new CheckoutOwnership(hub, homes, 'hub').current(project)).toMatchObject({ held: false });
}, 120_000);
