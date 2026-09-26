import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, ContextPanelSchema, ContextReviewSchema, ConversationIndexSchema, GitWorkspace, Homes, ProjectSchema, ProjectVisibilitySchema, stableJson, type ContextOperation, type Project } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { ProjectContext } from '../packages/memory/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { HubDatabase, HubIndexes, HubUnavailable } from '../packages/mesh/dist/index.js';
import { trialLog } from '../apps/daemon/dist/index.js';
import { createHash } from 'node:crypto';

let root: string; let path: string; let origin: string; let initial: string; let app: Application; let fake: FakeRuntime; let homes: Homes; let project: Project;
let server: Server; let base: string; let cookie: string;
const merged = '# Shared instructions\nPreserve the tests.\nRun the formatter.\n';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
async function listen() { server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
async function stop() { await app.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-context-service-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); path = join(root, 'project'); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(path, 'value.txt'), '1\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', '-u', 'origin', 'main'); initial = git(path, 'rev-parse', 'HEAD');
  fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  app = new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].runtimes.fake = { enabled: true };
  config.configuration['x-jevellan'].menu = [{ id: 'fixture-model', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model', efforts: ['high'], enabled: true }];
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.put('accounts', 'acc_fixture', AccountSchema, { schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Fixture', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0); await app.accounts.check('acc_fixture');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Context fixture', paths: { [app.device.deviceId]: path }, branchPolicy: 'main', testCommand: 'test -f value.txt', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project }); await listen();
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable context passphrase' }) });
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { await stop(); await fake.close(); rmSync(root, { recursive: true, force: true }); });
function request(route: string, method = 'GET', body?: unknown) { return fetch(`${base}${route}`, { method, headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function panel() { const response = await request('/api/projects/project/context/operations'); expect(response.status).toBe(200); return ContextPanelSchema.parse(await response.json()); }
async function save(values: Partial<Project> = {}, createContext = false) { project = { ...project, ...values }; return app.conversations.saveProject({ schema: 'project-write-v1', revision: (await app.conversations.projects()).projects[0]!.revision, project, createContext }); }
function both() { writeFileSync(join(path, 'AGENTS.md'), '# Agent instructions\nPreserve the tests.\n'); writeFileSync(join(path, 'CLAUDE.md'), '# Claude instructions\nRun the formatter.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Two instruction files'); git(path, 'push'); initial = git(path, 'rev-parse', 'HEAD'); }
async function choose(choice: string, clientRequestId = 'context_choice') {
  const before = await panel(); const input = { schema: 'context-request-v1', clientRequestId, revision: before.revision, fingerprint: before.context.fingerprint, choice };
  const response = await request('/api/projects/project/context/operations', 'POST', input); const body: unknown = await response.json(); expect(response.status, JSON.stringify(body)).toBe(202);
  const record = ContextPanelSchema.parse(body).operations.find((entry) => entry.id === clientRequestId)!; await app.conversations.wait(record.conversationId); return input;
}
async function proceed(action: string, clientRequestId = `context_${action}`) {
  const record = (await panel()).operations.at(-1)!; const input = { schema: 'context-continue-v1', clientRequestId, operationId: record.id, generation: record.generation, action };
  const response = await request('/api/projects/project/context/continue', 'POST', input); const body: unknown = await response.json(); expect(response.status, JSON.stringify(body)).toBe(202);
  await app.conversations.wait(record.conversationId); return input;
}
function draft(type: 'merge-draft' | 'answer' = 'merge-draft') {
  fake.enqueue(async ({ input }) => {
    expect(input.permissions).toBe('read-only'); expect(input.memoryWrite).toBe(false); expect(input.brief).toContain('merge-draft');
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
      schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Drafted shared instructions.', result: { type, content: merged }, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [],
    } }) }); expect(response.status, await response.text()).toBe(200); return { status: 'completed' };
  });
}
async function completed(record: ContextOperation) {
  expect(record, record.reason).toMatchObject({ status: 'completed', applied: true }); expect((await app.conversations.view(record.conversationId)).conversation).toMatchObject({ state: 'done', work: null });
  expect((await app.conversations.ownership.current(project))?.held).not.toBe(true);
}

test.each(['project', 'context'] as const)('project save resumes after a lost %s result and daemon restart with one context operation', async boundary => {
  const original = (await app.state.projects.get(project.id))!;
  const input = { schema: 'project-write-v1', clientRequestId: 'project_save_lost', revision: original.revision, project: { ...original.project, name: 'Saved during outage' }, createContext: true };
  if (boundary === 'project') {
    const put = app.state.projects.put.bind(app.state.projects);
    vi.spyOn(app.state.projects, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw new HubUnavailable('Fixture hub'); });
  } else {
    const configure = app.conversations.configureContext.bind(app.conversations);
    vi.spyOn(app.conversations, 'configureContext').mockImplementationOnce(async (...args) => { await configure(...args); throw new HubUnavailable('Fixture hub'); });
  }
  const lost = await request('/hub/projects', 'PUT', input); expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  for (const operation of app.conversations.options.contexts.list()) await app.conversations.wait(operation.conversationId);
  await stop(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
  const replay = await request('/hub/projects', 'PUT', input); expect(replay.status, await replay.clone().text()).toBe(200);
  const operations = app.conversations.options.contexts.list(); expect(operations).toHaveLength(1); await app.conversations.wait(operations[0]!.conversationId);
  await completed(app.conversations.options.contexts.get(operations[0]!.id)!);
  const head = git(path, 'rev-parse', 'HEAD'); expect(head).not.toBe(initial);
  expect(lstatSync(join(path, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  expect((await request('/hub/projects', 'PUT', input)).status).toBe(200);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(app.conversations.options.contexts.list()).toHaveLength(1);
  expect((await app.state.projects.get(project.id))!.project.name).toBe('Saved during outage');
}, 60_000);

test('a replayed project save preserves newer settings and does not start its superseded context request', async () => {
  const original = (await app.state.projects.get(project.id))!;
  const input = { schema: 'project-write-v1', clientRequestId: 'project_superseded', revision: original.revision, project: original.project, createContext: true };
  const put = app.state.projects.put.bind(app.state.projects);
  vi.spyOn(app.state.projects, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw new HubUnavailable('Fixture hub'); });
  await expect(app.conversations.saveProject(input)).rejects.toBeInstanceOf(HubUnavailable);
  const saved = (await app.state.projects.get(project.id))!;
  const latest = await app.state.projects.put({ ...saved.project, name: 'Later project settings' }, saved.revision);
  expect(await app.conversations.saveProject(input)).toEqual(latest); expect(app.conversations.options.contexts.list()).toHaveLength(0); expect(existsSync(join(path, 'AGENTS.md'))).toBe(false);
  await expect(app.conversations.saveProject({ ...input, createContext: false })).rejects.toMatchObject({ status: 409 });
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test('choosing context after outside file changes records the operation before a shared-state write can lose its reply', async () => {
  both(); const put = app.state.projects.context.bind(app.state.projects);
  vi.spyOn(app.state.projects, 'context').mockImplementationOnce(async (...args) => {
    await put(...args); throw new HubUnavailable('Fixture hub');
  });
  const before = await panel(); const input = { schema: 'context-request-v1', clientRequestId: 'context_outside_observed', revision: before.revision, fingerprint: before.context.fingerprint, choice: 'keep-agents' };
  let chosen = await request('/api/projects/project/context/operations', 'POST', input);
  if (chosen.status === 503) chosen = await request('/api/projects/project/context/operations', 'POST', input);
  expect(chosen.status, await chosen.clone().text()).toBe(202);
  const record = app.conversations.options.contexts.get(input.clientRequestId)!; expect(record).toBeTruthy();
  await vi.waitFor(async () => expect(JSON.stringify(await app.conversations.view(record.conversationId))).toContain("Can't reach the hub"), { timeout: 5000 });
  app.conversations.hubWaits.reachable(); await app.conversations.wait(record.conversationId);
  await completed(app.conversations.options.contexts.get(input.clientRequestId)!);
  expect(lstatSync(join(path, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  const head = git(path, 'rev-parse', 'HEAD'); expect((await request('/api/projects/project/context/operations', 'POST', input)).status).toBe(202); expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
}, 60_000);

test('instruction changes while account eligibility is loading prevent a stale merge request from starting', async () => {
  both(); const before = await panel(); let entered!: () => void; let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const list = app.accounts.list.bind(app.accounts);
  vi.spyOn(app.accounts, 'list').mockImplementationOnce(async () => { const accounts = await list(); entered(); await gate; return accounts; });
  const pending = app.conversations.configureContext(project.id, { schema: 'context-request-v1', clientRequestId: 'stale_merge', revision: before.revision, fingerprint: before.context.fingerprint, choice: 'merge' });
  const rejected = expect(pending).rejects.toThrow('changed'); await enteredPromise;
  writeFileSync(join(path, 'CLAUDE.md'), 'A newer instruction.\n'); release(); await rejected;
  expect((await panel()).operations).toHaveLength(0); expect(fake.starts).toHaveLength(0); expect(readFileSync(join(path, 'CLAUDE.md'), 'utf8')).toBe('A newer instruction.\n');
});

test('repository visibility requires authentication and reads only the selected project without starting work', async () => {
  const before = { refs: git(path, 'show-ref'), status: git(path, 'status', '--porcelain') };
  expect((await fetch(`${base}/api/projects/project/visibility`)).status).toBe(401);
  const response = await request('/api/projects/project/visibility'); expect(response.status).toBe(200);
  expect(ProjectVisibilitySchema.parse(await response.json())).toMatchObject({ schema: 'project-visibility-v1', projectId: project.id, deviceId: app.device.deviceId, visibility: 'PUBLIC' });
  expect((await request('/api/projects/missing/visibility')).status).toBe(404);
  expect({ refs: git(path, 'show-ref'), status: git(path, 'status', '--porcelain') }).toEqual(before); expect(fake.starts).toHaveLength(0);
});

test('Create AGENTS.md on project save checkpoints, independently verifies and publishes; a repeated request does not apply twice', async () => {
  await save({}, true); const record = (await panel()).operations[0]!; await app.conversations.wait(record.conversationId); await completed((await panel()).operations[0]!);
  expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toContain('Run tests with `test -f value.txt`'); expect(readlinkSync(join(path, 'CLAUDE.md'))).toBe('AGENTS.md');
  const head = git(path, 'rev-parse', 'HEAD'); expect(head).not.toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(head); expect(git(path, 'ls-files')).not.toContain('CLAUDE.md'); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(app.conversations.ledger(record.conversationId).events().some((event) => event.type === 'verification')).toBe(true);
  // The context conversation is marked as Jevellan's own work, so the trial log leaves it out.
  expect((await app.conversations.list()).conversations.find((entry) => entry.id === record.conversationId)?.origin).toBe('context-operation');
  expect((await request('/api/projects/project/context/operations', 'POST', record.request)).status).toBe(202); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(fake.starts).toHaveLength(0);
}, 60_000);

test.each(['keep-agents', 'keep-claude', 'leave'])('%s preserves the selected instructions and publishes only real tracked changes', async (choice) => {
  both(); await save(); expect((await app.conversations.projects()).projects[0]!.project.context.state).toBe('needs-decision'); const refs = git(path, 'show-ref'); await choose(choice);
  const record = (await panel()).operations.at(-1)!; await completed(record);
  if (choice === 'leave') { expect(git(path, 'show-ref')).toBe(refs); expect((await panel()).context.state).toBe('left-as-is'); expect(lstatSync(join(path, 'CLAUDE.md')).isFile()).toBe(true); }
  else { const primary = choice === 'keep-agents' ? 'AGENTS.md' : 'CLAUDE.md'; const secondary = choice === 'keep-agents' ? 'CLAUDE.md' : 'AGENTS.md'; expect(readlinkSync(join(path, secondary))).toBe(primary); expect(git(origin, 'rev-parse', 'main')).toBe(record.commit); expect(git(path, 'status', '--porcelain')).toBe(''); }
  expect(fake.starts).toHaveLength(0);
}, 60_000);

test('merge stays read-only until Apply, survives restart, and applies the exact inspected draft once', async () => {
  both(); const refs = git(path, 'show-ref'); const originalProject = await app.state.projects.get(project.id); draft(); const requestBody = await choose('merge'); let record = (await panel()).operations.at(-1)!;
  expect(record, record.reason).toMatchObject({ status: 'draft-ready', draft: merged, applied: false }); expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(await app.state.projects.get(project.id)).toEqual(originalProject);
  expect((await request('/api/projects/project/context/operations', 'POST', requestBody)).status).toBe(202); expect(fake.starts).toHaveLength(1);
  expect((await request('/api/projects/project/context/continue', 'POST', { schema: 'context-continue-v1', clientRequestId: 'wrong_retry', operationId: record.id, generation: record.generation, action: 'retry' })).status).toBe(409);
  expect((await request(`/api/conversations/${record.conversationId}/manual`, 'POST', { schema: 'manual-step-v1', generation: record.generation, action: 'done' })).status).toBe(409);
  await stop(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
  record = (await panel()).operations.at(-1)!; expect(record.status).toBe('draft-ready'); expect(fake.starts).toHaveLength(1); expect(git(path, 'show-ref')).toBe(refs);
  const apply = await proceed('apply'); record = (await panel()).operations.at(-1)!; await completed(record); expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe(merged); expect(readlinkSync(join(path, 'CLAUDE.md'))).toBe('AGENTS.md');
  expect(git(origin, 'rev-parse', 'main')).toBe(record.commit); expect((await request('/api/projects/project/context/continue', 'POST', apply)).status).toBe(202); expect(git(path, 'rev-parse', 'HEAD')).toBe(record.commit); expect(fake.starts).toHaveLength(1);
  const changes = await app.conversations.changes(record.conversationId, 1); expect(changes.diff).toContain('+Run the formatter.'); expect(changes.verifications.some((receipt) => receipt.passed && receipt.commit === record.commit)).toBe(true);
}, 60_000);

test('an applied merge has a checkpoint receipt so published undo restores both original files', async () => {
  both(); const agents = readFileSync(join(path, 'AGENTS.md'), 'utf8'); const claude = readFileSync(join(path, 'CLAUDE.md'), 'utf8'); draft(); await choose('merge'); await proceed('apply');
  const record = (await panel()).operations.at(-1)!; await completed(record); draft();
  const response = await request(`/api/conversations/${record.conversationId}/correct`, 'POST', { schema: 'correct-step-v1', clientRequestId: 'undo_context', generation: (await app.conversations.view(record.conversationId)).conversation.generation, stretch: 1, mode: 'redo', choices: { effort: 'max' } });
  expect(response.status, await response.text()).toBe(202); await app.conversations.wait(record.conversationId);
  expect((await app.conversations.view(record.conversationId)).redos.at(-1)).toMatchObject({ status: 'completed', plan: { mode: 'revert' } });
  expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe(agents); expect(lstatSync(join(path, 'CLAUDE.md')).isFile()).toBe(true); expect(readFileSync(join(path, 'CLAUDE.md'), 'utf8')).toBe(claude); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('retrying an invalid draft records the successful drafting step and still waits for Apply', async () => {
  both(); const originalProject = await app.state.projects.get(project.id); draft('answer'); await choose('merge'); expect((await panel()).operations.at(-1)).toMatchObject({ status: 'blocked', applied: false });
  draft(); await proceed('retry'); const record = (await panel()).operations.at(-1)!; expect(record).toMatchObject({ status: 'draft-ready', approved: false, draftStretch: 2 }); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  expect(await app.state.projects.get(project.id)).toEqual(originalProject);
  await proceed('apply'); await completed((await panel()).operations.at(-1)!); const ledger = app.conversations.ledger(record.conversationId);
  const receipt = ledger.events().filter((event) => event.type === 'git').map((event) => ledger.data(event)).find((data) => typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'context');
  expect(receipt).toMatchObject({ stretch: 2 }); expect((await app.conversations.changes(record.conversationId, 2)).diff).toContain('+Run the formatter.');
}, 60_000);

test.each(['file', 'settings'])('a newer %s invalidates a draft without overwriting it or keeping checkout ownership', async (change) => {
  both(); draft(); await choose('merge');
  if (change === 'file') writeFileSync(join(path, 'CLAUDE.md'), 'New outside instruction.\n'); else await save({ name: 'Renamed project' });
  await proceed('apply'); const record = (await panel()).operations.at(-1)!; expect(record).toMatchObject({ status: 'blocked', applied: false }); expect(record.reason).toContain('changed');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(lstatSync(join(path, 'CLAUDE.md')).isFile()).toBe(true); if (change === 'file') expect(readFileSync(join(path, 'CLAUDE.md'), 'utf8')).toBe('New outside instruction.\n');
  expect((await app.conversations.ownership.current(project))?.held).not.toBe(true); await proceed('cancel'); expect((await panel()).operations.at(-1)!.status).toBe('cancelled');
}, 60_000);

test('Cancel from Settings or the conversation leaves both files and permits a later fresh choice', async () => {
  both(); const refs = git(path, 'show-ref'); draft(); await choose('merge'); await proceed('cancel'); expect((await panel()).operations.at(-1)!.status).toBe('cancelled');
  draft(); await choose('merge', 'second_merge'); const record = (await panel()).operations.at(-1)!; await app.conversations.cancel(record.conversationId);
  expect((await panel()).operations.at(-1)!.status).toBe('cancelled'); await choose('leave', 'leave_after_cancel'); expect((await panel()).context.state).toBe('left-as-is'); expect(git(path, 'show-ref')).toBe(refs); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('verification failure keeps ownership and Retry publishes the existing checkpoint without reapplying the files', async () => {
  both(); await save({ testCommand: 'test -f ../permit-publication' }); await choose('keep-agents'); const before = (await panel()).operations.at(-1)!;
  expect(before).toMatchObject({ status: 'blocked', applied: true }); expect(before.commit).toBe(git(path, 'rev-parse', 'HEAD')); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect((await app.conversations.ownership.current(project))?.held).toBe(true);
  writeFileSync(join(root, 'permit-publication'), 'allowed'); await proceed('retry'); const after = (await panel()).operations.at(-1)!; await completed(after); expect(after.commit).toBe(before.commit); expect(git(origin, 'rev-parse', 'main')).toBe(before.commit); expect(fake.starts).toHaveLength(0);
}, 60_000);

test('another work owns the checkout: no files change until ownership is released and Retry is chosen', async () => {
  const owner = { conversationId: 'other', workId: 'other_work', conversationTitle: 'Other work' }; await app.conversations.ownership.acquire(project, owner); await choose('create');
  expect((await panel()).operations[0]).toMatchObject({ status: 'blocked', applied: false }); expect(existsSync(join(path, 'AGENTS.md'))).toBe(false); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  await app.conversations.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' }); await proceed('retry'); await completed((await panel()).operations[0]!);
}, 60_000);

test('external projects reject tracked replacement and merge before any model or Git mutation', async () => {
  both(); await save({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } }); const refs = git(path, 'show-ref'); const view = await panel();
  for (const choice of ['keep-agents', 'keep-claude', 'merge']) expect((await request('/api/projects/project/context/operations', 'POST', { schema: 'context-request-v1', clientRequestId: choice, revision: view.revision, fingerprint: view.context.fingerprint, choice })).status).toBe(409);
  expect((await panel()).operations).toHaveLength(0); await choose('leave'); expect(git(path, 'show-ref')).toBe(refs); expect(fake.starts).toHaveLength(0);
}, 60_000);

test('external context creation stays locally excluded and keeps existing dirty files unchanged', async () => {
  await save({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } }); writeFileSync(join(path, 'value.txt'), 'Outside change.'); const refs = git(path, 'show-ref'); await choose('create'); await completed((await panel()).operations[0]!);
  expect(readlinkSync(join(path, 'CLAUDE.md'))).toBe('AGENTS.md'); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('Outside change.'); expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toBe('M value.txt'); expect(git(path, 'check-ignore', 'AGENTS.md', 'CLAUDE.md')).toBe('AGENTS.md\nCLAUDE.md');
}, 60_000);

test('adding a project with one existing instruction file creates only its excluded compatibility link', async () => {
  writeFileSync(join(path, 'AGENTS.md'), '# Existing instructions\n'); git(path, 'add', 'AGENTS.md'); git(path, 'commit', '-m', 'Instructions'); git(path, 'push'); const refs = git(path, 'show-ref'); writeFileSync(join(path, 'value.txt'), 'Outside change.');
  await save(); const record = (await panel()).operations[0]!; await app.conversations.wait(record.conversationId); await completed((await panel()).operations[0]!);
  expect(git(path, 'show-ref')).toBe(refs); expect(readlinkSync(join(path, 'CLAUDE.md'))).toBe('AGENTS.md'); expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe('# Existing instructions\n'); expect(git(path, 'status', '--porcelain')).toBe('M value.txt');
}, 60_000);

test('outside finish cancels an unapplied context draft and restart repairs a missing cancellation projection', async () => {
  both(); const refs = git(path, 'show-ref'); draft(); await choose('merge'); const record = (await panel()).operations.at(-1)!;
  expect(record.status).toBe('draft-ready'); const generation = (await app.conversations.view(record.conversationId)).conversation.generation;
  const response = await request(`/api/conversations/${record.conversationId}/finish-outside`, 'POST', { schema: 'finish-outside-v1', clientRequestId: 'outside_context', generation, reason: 'I updated the instructions elsewhere.' }); expect(response.status).toBe(200);
  expect((await panel()).operations.at(-1)?.status).toBe('cancelled'); expect(git(path, 'show-ref')).toBe(refs);
  // Keep the durable conversation result but simulate losing its context projection.
  app.conversations.options.contexts.put(record);
  expect((await request('/api/projects/project/context/continue', 'POST', { schema: 'context-continue-v1', clientRequestId: 'late_apply', operationId: record.id, generation: record.generation, action: 'apply' })).status).toBe(409);
  await stop(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
  expect((await panel()).operations.at(-1)?.status).toBe('cancelled'); expect((await app.conversations.view(record.conversationId)).conversation.outcome?.reason).toBe('I updated the instructions elsewhere.'); expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toBe(''); expect(fake.starts).toHaveLength(1);
}, 60_000);

function outsideContextActivity() {
  const directory = join(homes.userHome, '.claude', 'projects', 'synthetic'); mkdirSync(directory, { recursive: true }); const journal = join(directory, 'outside.jsonl');
  writeFileSync(journal, JSON.stringify({ type: 'user', cwd: path }) + '\n'); return journal;
}
function quietContextActivity(journal: string) { const old = new Date(Date.now() - 600_000); utimesSync(journal, old, old); }

test('outside activity blocks context creation before files change and quiet Retry completes it', async () => {
  const journal = outsideContextActivity(); await choose('create'); const record = (await panel()).operations.at(-1)!;
  expect(record).toMatchObject({ status: 'blocked', applied: false }); expect(record.reason).toContain('Another agent'); expect(existsSync(join(path, 'AGENTS.md'))).toBe(false); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  quietContextActivity(journal); await proceed('retry'); await completed((await panel()).operations.at(-1)!); expect(fake.starts).toHaveLength(0);
}, 60_000);

test.each(['open', 'lost-result', 'kept'])('outside activity during context application requires exact review and recovers its work: %s', async mode => {
  const lostResult = mode === 'lost-result';
  const ensure = ProjectContext.prototype.ensure; let journal = '';
  vi.spyOn(ProjectContext.prototype, 'ensure').mockImplementationOnce(async function (this: ProjectContext, create) {
    const result = await ensure.call(this, create); journal = outsideContextActivity(); writeFileSync(join(path, 'outside.txt'), 'Outside contribution.\n'); return result;
  });
  await choose('create'); let record = (await panel()).operations.at(-1)!;
  expect(record).toMatchObject({ status: 'blocked', applied: true }); expect(record.activityReason).toContain('Review'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); quietContextActivity(journal);
  const retry = { schema: 'context-continue-v1', clientRequestId: 'unchecked_retry', operationId: record.id, generation: record.generation, action: 'retry' };
  expect((await request('/api/projects/project/context/continue', 'POST', retry)).status).toBe(409);
  expect((await request(`/api/conversations/${record.conversationId}/manual`, 'POST', { schema: 'manual-step-v1', generation: record.generation, action: 'implement', modelId: 'fixture-model', remember: false })).status).toBe(409);
  if (mode === 'kept') {
    const response = await request(`/api/conversations/${record.conversationId}/settle`, 'POST', { schema: 'settle-work-v1', clientRequestId: 'keep_context', workId: record.workId, generation: record.generation, choice: 'keep' }); expect(response.status).toBe(202); await app.conversations.wait(record.conversationId);
    expect((await app.conversations.view(record.conversationId)).conversation.work).toBeNull();
  }
  const reviewRoute = `/api/projects/project/context/review?operation=${record.id}`;
  let review = ContextReviewSchema.parse(await (await request(reviewRoute)).json()); expect(review.diff).toContain('+Outside contribution.'); expect(review.diff).toContain('AGENTS.md');
  writeFileSync(join(path, 'outside.txt'), 'Newer outside contribution.\n');
  const accept = (fingerprint: string, clientRequestId: string) => request('/api/projects/project/context/continue', 'POST', { schema: 'context-continue-v1', clientRequestId, operationId: record.id, generation: review.generation, fingerprint, action: 'accept-changes' });
  expect((await accept(review.fingerprint, 'stale_accept')).status).toBe(409); review = ContextReviewSchema.parse(await (await request(reviewRoute)).json());
  await expect(save({ name: 'Reconfigured context fixture' })).rejects.toThrow('This project is in use.');
  if (lostResult) {
    const apply = GitWorkspace.prototype.applyCheckpoint;
    vi.spyOn(GitWorkspace.prototype, 'applyCheckpoint').mockImplementationOnce(async function (this: GitWorkspace, ...args) { await apply.apply(this, args); throw new Error('Fixture lost checkpoint result.'); });
  }
  expect((await accept(review.fingerprint, 'context_accept')).status).toBe(202); await app.conversations.wait(record.conversationId); record = (await panel()).operations.at(-1)!;
  if (lostResult) {
    expect(record.status).toBe('blocked'); expect(record.checkpointPlan?.after).toBe(git(path, 'rev-parse', 'HEAD')); const accepted = git(path, 'rev-parse', 'HEAD');
    await stop(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
    await proceed('retry', 'recover_context_accept'); record = (await panel()).operations.at(-1)!; expect(record.commit).toBe(accepted);
  }
  await completed(record); expect(git(origin, 'show', 'main:outside.txt')).toBe('Newer outside contribution.'); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); expect(fake.starts).toHaveLength(0);
}, 90_000);

test('upgrading a home whose context conversation index was published before origin existed records origin as a new event and keeps index flushes working', async () => {
  await save({}, true); const record = (await panel()).operations[0]!; await app.conversations.wait(record.conversationId); await completed((await panel()).operations[0]!);
  await app.conversations.list(); await stop();
  // Rewrite this home into the pre-upgrade shape: no origin in the ledger, projections or the published index.
  const legacy = (text: string) => text.replaceAll(',"origin":"context-operation"', '').replaceAll('"origin":"context-operation",', '');
  const files = (directory: string): string[] => readdirSync(directory).flatMap((name) => statSync(join(directory, name)).isDirectory() ? files(join(directory, name)) : [join(directory, name)]);
  for (const file of files(homes.at('conversations', record.conversationId))) if (/\.(?:jsonl?|json)$/.test(file)) writeFileSync(file, legacy(readFileSync(file, 'utf8')));
  const hub = new HubDatabase(homes, 'hub');
  try {
    const row = hub.get('conversations', record.conversationId, ConversationIndexSchema)!; const document = { ...row.document }; delete document.origin;
    hub.put('conversations', record.conversationId, ConversationIndexSchema, document, row.revision);
    const key = createHash('sha256').update(`conversations\0${record.conversationId}`).digest('hex'); const cursor = hub.db.prepare("SELECT revision, document FROM documents WHERE namespace='index-cursors' AND id=?").get(key)!;
    hub.db.prepare("UPDATE documents SET document=? WHERE namespace='index-cursors' AND id=?").run(JSON.stringify({ ...JSON.parse(String(cursor.document)), digest: createHash('sha256').update(stableJson(document)).digest('hex') }), key);
  } finally { hub.close(); }
  const events = () => app.conversations.ledger(record.conversationId).events();
  app = new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
  await app.conversations.wait(record.conversationId);
  const upgraded = events(); expect(upgraded.filter((event) => (event.data as { schema?: string }).schema === 'conversation-origin-v1')).toHaveLength(1);
  const listed = (await app.conversations.list()).conversations.find((entry) => entry.id === record.conversationId)!;
  expect(listed.origin).toBe('context-operation'); expect((await app.conversations.view(record.conversationId)).conversation.updatedAt).toBe(listed.updatedAt);
  expect(trialLog(new HubIndexes(app.hub, app.device.deviceId).conversations()).weeks).toEqual([]);
  await stop(); app = new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready; await listen();
  expect(events()).toHaveLength(upgraded.length); await app.conversations.wait(record.conversationId);
}, 90_000);
