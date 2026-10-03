import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, CheckpointAdoptionSchema, CheckpointReceiptSchema, DecisionRecordSchema, HandoffSchema, ConversationChangesSchema, ConversationFileSchema, ConversationEventSchema, ConversationPublicSchema, GitWorkspace, Homes, OverrideRecordSchema, ProjectSchema, RedoOperationSchema, StretchSchema, WorkSettlementSchema, groupAlive, spawnGroup, terminateGroup, type Action, type Project } from '../packages/core/dist/index.js';
import { ConversationWork, RESTART_NOTICE } from '../packages/conversations/dist/index.js';
import { DecisionIndexSchema, decisionIndex } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { FakeRuntime, type FakeStep, type StretchInput } from '../packages/runtime-contract/dist/index.js';
import { LifecycleGate, lifecycleActivity } from '../packages/core/dist/index.js';

let root: string; let homes: Homes; let app: Application; let fake: FakeRuntime; let project: Project;
let server: Server; let base: string; let cookie: string; let origin: string; let path: string; let initial: string;
const streams: AbortController[] = [];
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-manual-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); path = join(root, 'project'); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(path, 'value.txt'), '1\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', '-u', 'origin', 'main'); initial = git(path, 'rev-parse', 'HEAD');
  fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true; // Simulated model contract; no live runtime claim.
  app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  const revision = app.hub.configuration.current()!; revision.configuration['x-jevellan'].runtimes.fake = { enabled: true };
  revision.configuration['x-jevellan'].menu = [{ id: 'fixture-model', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model', efforts: ['high'], enabled: true }];
  app.hub.configuration.put(revision.configuration, revision.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.put('accounts', 'acc_fixture', AccountSchema, { schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Fixture', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await app.accounts.check('acc_fixture');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { [app.device.deviceId]: path }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project });
  server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'disposable fixture passphrase' }) });
  expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  await app.close(); await fake.close();
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  rmSync(root, { recursive: true, force: true });
});
function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${route}`, { method, headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(id = 'conversation', message = 'Change the value to two with evidence.') {
  const response = await request('/api/conversations', 'POST', { schema: 'start-conversation-v1', id, projectId: project.id, title: id, message, clientMessageId: `first_${id}` });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(201); return ConversationPublicSchema.parse(value);
}
async function choose(action: Exclude<Action, 'integrate'>, id = 'conversation') {
  const response = await request(`/api/conversations/${id}/manual`, 'POST', { schema: 'manual-step-v1', generation: (await app.conversations.view(id)).conversation.generation, action, modelId: 'fixture-model', effort: 'high' });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(202); return ConversationPublicSchema.parse(value);
}
async function handoff(input: StretchInput, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
    schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Completed the fixture step.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], ...extra,
  } }) });
  expect(response.status, await response.text()).toBe(200);
}
async function captureHook(input: StretchInput, event: string) {
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'memory-capture', event }) });
  expect(response.status).toBe(200); return response.json() as Promise<unknown>;
}
async function integrate(input: StretchInput, command: 'start' | 'continue' | 'skip') {
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_integrate', arguments: { schema: 'integration-command-v1', command } }) });
  const result: unknown = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result;
}
const implement: FakeStep = async ({ input, emit }) => {
  writeFileSync(join(input.cwd, 'value.txt'), '2\n'); emit({ type: 'text', delta: 'Changed the value.' });
  emit({ type: 'rate-limit', fiveHourPct: 12, weeklyPct: 8 }); emit({ type: 'usage', inputTokens: 20, outputTokens: 10, costUsd: 0.01 });
  await handoff(input, { changedFiles: ['value.txt'], testsRun: { command: 'agent claimed a pass', passed: true, summary: 'Informative only.' } }); return { status: 'completed' };
};
async function changeProject(values: Partial<Project>) { project = { ...project, ...values }; const revision = (await app.conversations.projects()).projects[0]!.revision; await app.conversations.saveProject({ schema: 'project-write-v1', revision, project }); }
async function settle(choice: 'publish' | 'keep' | 'discard', clientRequestId = `settle_${choice}`) {
  const view = (await app.conversations.view('conversation'));
  const input = { schema: 'settle-work-v1', clientRequestId, workId: (view.conversation.work ?? view.closedWorks.at(-1))!.id, generation: view.conversation.generation, choice };
  const response = await request('/api/conversations/conversation/settle', 'POST', input);
  expect(response.status, await response.text()).toBe(202); await app.conversations.wait('conversation'); return input;
}

async function correct(stretch: number, mode: 'noted' | 'redo', choices: Record<string, string>, clientRequestId = `correct_${stretch}_${mode}`) {
  const input = { schema: 'correct-step-v1', clientRequestId, generation: (await app.conversations.view('conversation')).conversation.generation, stretch, mode, choices };
  const response = await request('/api/conversations/conversation/correct', 'POST', input);
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(202); return input;
}
async function restartApplication() {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await app.close();
  app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function blockedFiles(memory = false) {
  await create(); fake.enqueue(async ({ input }) => {
    writeFileSync(join(path, 'value.txt'), '2\n'); writeFileSync(join(path, 'new.txt'), 'Review this addition.\n');
    await handoff(input, memory ? { findings: [{ claim: 'memory: Accepted working rule', pointer: 'new.txt' }] } : {}); return { status: 'completed' };
  });
  await choose('reply'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.state).toBe('blocked'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}

test('installation maintenance waits through preparation and a running stretch, then prevents another step', async () => {
  await create(); const installer = new LifecycleGate(homes), started = deferred(), finish = deferred();
  let release: (() => void) | null = null;
  try {
    fake.enqueue(async ({ input }) => { started.resolve(); await finish.promise; await handoff(input); return { status: 'completed' }; });
    await choose('reply');
    expect(installer.tryMaintenance()).toBeNull();
    expect(lifecycleActivity(homes)).toContainEqual({ kind: 'conversation', id: 'conversation', title: 'conversation' });
    await started.promise; expect(installer.tryMaintenance()).toBeNull(); finish.resolve(); await app.conversations.wait('conversation');
    release = installer.tryMaintenance(); expect(release).toBeTypeOf('function');
    const response = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: (await app.conversations.view('conversation')).conversation.generation, action: 'reply', modelId: 'fixture-model', effort: 'high' });
    expect(response.status).toBe(503); expect((await app.conversations.view('conversation')).stretches).toHaveLength(1);
  } finally { finish.resolve(); await app.conversations.wait('conversation'); release?.(); installer.close(); }
}, 30_000);
async function adoptionReview(clientRequestId = 'adopt_review') {
  const response = await request('/api/conversations/conversation/changes/1'); expect(response.status).toBe(200);
  const changes = ConversationChangesSchema.parse(await response.json()); expect(changes.recovery?.fingerprint, changes.recovery?.reason).toBeTruthy();
  const view = (await app.conversations.view('conversation'));
  return { changes, input: { schema: 'adopt-changes-v1', clientRequestId, workId: (view.conversation.work ?? view.closedWorks.at(-1))!.id, stretch: 1, generation: changes.recovery!.generation, fingerprint: changes.recovery!.fingerprint! } };
}
async function acceptFiles(input: unknown) {
  const response = await request('/api/conversations/conversation/adopt-changes', 'POST', input); expect(response.status, await response.text()).toBe(202);
  await app.conversations.wait('conversation'); return (await app.conversations.view('conversation'));
}
test('reviewed changes become one local checkpoint, capture deferred memory and publish only through verification', async () => {
  await blockedFiles(true); const before = (await app.conversations.view('conversation')); const originalHandoff = before.handoffs[0];
  const review = await adoptionReview(); expect(review.changes.uncommitted).toContain('+2'); expect(review.changes.uncommitted).toContain('+Review this addition.');
  const accepted = await acceptFiles(review.input); expect(accepted.checkpointBlocks).toEqual([]); expect(accepted.conversation.work!.baseCommit).toBe(initial);
  expect(accepted.handoffs[0]).toEqual(originalHandoff); expect(accepted.stretches[0]!.status).toBe('failed'); expect(accepted.conversation.state).toBe('waiting-for-you');
  expect(git(path, 'status', '--porcelain')).toBe(''); const head = git(path, 'rev-parse', 'HEAD'); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(git(path, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('.jevellan/memory/');
  await acceptFiles(review.input); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(fake.starts).toHaveLength(1);
  expect((await request('/api/conversations/conversation/adopt-changes', 'POST', { ...review.input, stretch: 2 })).status).toBe(409);
  // The failed step never answered the request; a completed reply must answer it before Done is available.
  expect((await app.conversations.view('conversation')).allowed).not.toContain('done');
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await choose('reply'); await app.conversations.wait('conversation'); expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
  await choose('done'); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).conversation.state).toBe('done'); expect(git(origin, 'rev-parse', 'main')).toBe(head);
  const receipts = (await app.conversations.changes('conversation', 1)).verifications; expect(receipts.some((entry) => entry.passed && entry.commit === head)).toBe(true);
}, 60_000);
test('changed files and a newer message invalidate the reviewed acceptance without creating a commit', async () => {
  await blockedFiles(); const old = await adoptionReview('old_review'); writeFileSync(join(path, 'late.txt'), 'Not in the original review.');
  const rejected = await acceptFiles(old.input); expect(rejected.checkpointBlocks).toHaveLength(1); expect(rejected.pause?.reason).toContain('changed since you reviewed'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  const fresh = await adoptionReview('fresh_review'); expect(fresh.changes.uncommitted).toContain('Not in the original review.');
  await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'new_context', text: 'Keep every reviewed file.' });
  expect((await request('/api/conversations/conversation/adopt-changes', 'POST', fresh.input)).status).toBe(409); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  const newest = await adoptionReview('newest_review'); expect((await acceptFiles(newest.input)).checkpointBlocks).toEqual([]); expect(git(path, 'show', 'HEAD:late.txt')).toBe('Not in the original review.');
}, 60_000);
test('accepting edited memory refreshes an already-open search index before the next read-only step', async () => {
  mkdirSync(join(path, '.jevellan/memory'), { recursive: true }); const note = join(path, '.jevellan/memory/rule.md');
  writeFileSync(note, '# Working rule\n\nThe old rule uses granite.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Initial memory'); git(path, 'push'); initial = git(path, 'rev-parse', 'HEAD');
  const memory = app.memory.project(project, app.device.deviceId, () => { throw new Error('Search cannot write project files.'); }); const signal = new AbortController().signal;
  expect((await memory.search('granite', signal)).notes).toHaveLength(1);
  await create('conversation', 'Explain this project’s azurite working rule.');
  fake.enqueue(async ({ input }) => { writeFileSync(note, '# Working rule\n\nThe accepted rule uses azurite.\n'); await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await app.conversations.wait('conversation'); const review = await adoptionReview(); expect(review.changes.uncommitted).toContain('+The accepted rule uses azurite.');
  expect((await acceptFiles(review.input)).checkpointBlocks).toEqual([]);
  expect((await memory.search('azurite', signal)).notes.map((entry) => entry.content).join('\n')).toContain('The accepted rule uses azurite.');
  fake.enqueue(async ({ input }) => { expect(input.brief).toContain('The accepted rule uses azurite.'); await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).stretches.at(-1)?.status).toBe('completed');
}, 60_000);
test('accepting files cannot legitimize an unrecorded commit or skip an unresolved undo', async () => {
  await blockedFiles(); const review = await adoptionReview(); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside commit'); const outside = git(path, 'rev-parse', 'HEAD');
  const changes = await app.conversations.changes('conversation', 1); expect(changes.recovery?.fingerprint).toBeUndefined(); expect(changes.recovery?.reason).toContain('changed git history');
  expect((await acceptFiles(review.input)).checkpointBlocks).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(outside);
  app.conversations.ledger('conversation').append({ type: 'git', data: RedoOperationSchema.parse({ schema: 'redo-operation-v1', id: 'pending_undo', workId: review.input.workId, generation: review.input.generation, fromStretch: 1, status: 'blocked', needsReconciliation: true }) });
  expect((await request('/api/conversations/conversation/adopt-changes', 'POST', { ...review.input, clientRequestId: 'try_again' })).status).toBe(409);
}, 60_000);
test.each(['prepared', 'applied', 'applied-with-new-files'])('restart recovers a %s acceptance without another commit or runtime launch', async (state) => {
  await blockedFiles(); const review = await adoptionReview('lost_response'); const view = (await app.conversations.view('conversation'));
  const workspace = new GitWorkspace(project, app.device.deviceId, app.conversations.ownership, { conversationId: 'conversation', conversationTitle: view.conversation.title, workId: review.input.workId });
  await app.conversations.ownership.acquire(project, workspace.owner);
  const plan = await workspace.planCheckpoint(review.input.clientRequestId, await workspace.snapshot(), await workspace.workingTreeDigest(), () => undefined);
  app.conversations.ledger('conversation').append({ type: 'git', data: CheckpointAdoptionSchema.parse({ schema: 'checkpoint-adoption-v1', request: review.input, blocks: view.checkpointBlocks.map((entry) => entry.eventId), status: 'prepared', plan }) });
  if (state !== 'prepared') await workspace.applyCheckpoint(plan, () => undefined);
  if (state === 'applied-with-new-files') writeFileSync(join(path, 'later.txt'), 'Preserve this later file.');
  await restartApplication(); const recovered = (await app.conversations.view('conversation'));
  expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(state === 'prepared' ? initial : plan.after);
  expect(recovered.checkpointBlocks).toHaveLength(state === 'applied' ? 0 : 1);
  if (state !== 'applied') {
    const fresh = await adoptionReview('after_restart'); expect((await acceptFiles(fresh.input)).checkpointBlocks).toEqual([]);
    if (state === 'applied-with-new-files') expect(git(path, 'show', 'HEAD:later.txt')).toBe('Preserve this later file.');
  }
  const head = git(path, 'rev-parse', 'HEAD'); await restartApplication(); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect((await app.conversations.view('conversation')).checkpointBlocks).toEqual([]);
}, 60_000);
test('accepted checkpoints remain undoable with the failed step that produced the files', async () => {
  await blockedFiles(); await acceptFiles((await adoptionReview()).input);
  fake.enqueue(async ({ input }) => { expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(existsSync(join(path, 'new.txt'))).toBe(false); await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply', effort: 'low' }); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).redos.at(-1)?.status).toBe('completed'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}, 60_000);
test('reviewed acceptance respects another work’s checkout ownership', async () => {
  await blockedFiles(); const review = await adoptionReview();
  await app.conversations.ownership.acquire(project, { conversationId: 'other', conversationTitle: 'Other work', workId: 'other_work' });
  const view = await acceptFiles(review.input); expect(view.checkpointBlocks).toHaveLength(1); expect(view.pause?.reason).toContain('in use by');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'diff', '--cached')).toBe('');
}, 60_000);
test('external-policy review acknowledges changes without accepting Git checkpoints', async () => {
  await changeProject({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } }); await blockedFiles();
  const changes = await app.conversations.changes('conversation', 1); expect(changes.recovery).toMatchObject({ mode: 'acknowledge', fingerprint: expect.any(String) });
  const refs = git(path, 'for-each-ref'); const status = git(path, 'status', '--porcelain');
  const view = (await app.conversations.view('conversation'));
  const rejected = await acceptFiles({ schema: 'adopt-changes-v1', clientRequestId: 'external_acceptance', workId: view.conversation.work!.id, stretch: 1, generation: view.conversation.generation, fingerprint: '0'.repeat(64) });
  expect(rejected.checkpointBlocks).toHaveLength(1); expect(rejected.pause?.reason).toContain('changed since you reviewed');
  const accepted = await acceptFiles((await adoptionReview('external_acknowledgement')).input); expect(accepted.checkpointBlocks).toEqual([]);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'diff', '--cached')).toBe(''); expect(git(path, 'for-each-ref', 'refs/jevellan/checkpoints')).toBe('');
  expect(git(path, 'for-each-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toBe(status); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(readFileSync(join(path, 'new.txt'), 'utf8')).toBe('Review this addition.\n'); expect(fake.starts).toHaveLength(1);
}, 60_000);
test('cancelled work can accept kept files and later publish without opening another request', async () => {
  await blockedFiles(); await app.conversations.cancel('conversation'); const closed = (await app.conversations.view('conversation')).closedWorks.at(-1)!;
  expect((await acceptFiles((await adoptionReview()).input)).conversation.work).toBeNull();
  const recovered = (await app.conversations.view('conversation')).closedWorks.at(-1)!; expect(recovered).toMatchObject({ id: closed.id, request: closed.request, closedAs: 'cancelled', baseCommit: initial });
  await settle('publish'); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); expect((await app.conversations.view('conversation')).conversation.work).toBeNull();
}, 60_000);
async function retryRedo(clientRequestId = 'retry_redo') {
  const view = (await app.conversations.view('conversation')); const input = { schema: 'retry-redo-v1', clientRequestId, id: view.redos.at(-1)!.id, generation: view.conversation.generation };
  const response = await request('/api/conversations/conversation/retry-redo', 'POST', input); const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(202); await app.conversations.wait('conversation'); return input;
}

test('read-only lifecycle capture is queued during the stretch and published only after an owned memory checkpoint', async () => {
  await changeProject({ testCommand: 'exit 1' }); await create('conversation', 'Review the project.');
  fake.enqueue(async ({ input }) => {
    for (const event of ['PreCompact', 'Stop', 'SessionEnd']) expect(await captureHook(input, event)).toMatchObject({ result: { queued: true } });
    expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
    await handoff(input); return { status: 'completed' };
  });
  await choose('review'); await app.conversations.wait('conversation');
  const work = app.conversations.ledger('conversation');
  expect(work.events().filter((event) => event.type === 'memory-queued')).toHaveLength(1);
  expect(git(path, 'log', '-1', '--format=%s')).toBe('memory: Capture 1 project note');
  const names = git(path, 'diff', '--name-only', '-z', initial, 'HEAD').split('\0').filter(Boolean); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^\.jevellan\/memory\//);
  expect(readFileSync(join(path, names[0]!), 'utf8')).toContain('## Structural checkpoint');
  await choose('done'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.state).toBe('done'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
  expect(git(path, 'status', '--porcelain')).toBe('');
}, 60_000);

test('answer-only replies with capture hooks enabled finish without git or memory changes', async () => {
  await create('conversation', 'What does value.txt contain?');
  fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: 'It contains one.' }); await handoff(input);
    expect(await captureHook(input, 'Stop')).toMatchObject({ result: { queued: false, reason: 'answer-only' } });
    return { status: 'completed' };
  });
  await choose('reply'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.state).toBe('done'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'memory-queued')).toEqual([]);
}, 30_000);

test.each(['reset', 'revert'] as const)('startup reconciles a completed %s without its result receipt; Retry preserves the correction and launches only once', async (mode) => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  if (mode === 'revert') { await choose('done'); await app.conversations.wait('conversation'); }
  const apply = GitWorkspace.prototype.applyUndo;
  const lost = vi.spyOn(GitWorkspace.prototype, 'applyUndo').mockImplementation(async function (this: GitWorkspace, ...args) { await apply.apply(this, args); throw new Error('Simulated lost Git result'); });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); lost.mockRestore();
  const before = (await app.conversations.view('conversation')); const record = before.redos.at(-1)!; expect(record.result).toBeUndefined(); expect(record.plan?.mode).toBe(mode);
  expect(before.stretches[0]!.status).toBe('completed'); const head = git(path, 'rev-parse', 'HEAD'); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n');
  if (mode === 'reset') { await app.conversations.cancel('conversation'); expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true }); }
  const refs = git(path, 'show-ref'); await restartApplication(); const recovered = (await app.conversations.view('conversation'));
  expect(recovered.stretches[0]!.status).toBe('undone'); expect(recovered.redos.at(-1)).toMatchObject({ id: record.id, status: 'blocked', result: { after: head } });
  expect(git(path, 'show-ref')).toBe(refs); expect(fake.starts).toHaveLength(1);
  if (mode === 'reset') expect(recovered.conversation).toMatchObject({ state: 'cancelled', work: null });
  fake.enqueue(async ({ input }) => { expect(git(path, 'rev-parse', 'HEAD')).toBe(head); await handoff(input); return { status: 'completed' }; });
  const retry = await retryRedo(); const after = (await app.conversations.view('conversation'));
  expect(after.redos.at(-1), JSON.stringify(after.redos)).toMatchObject({ id: record.id, status: 'completed', retries: [retry] }); expect(fake.starts).toHaveLength(2);
  expect(after.overrides).toHaveLength(1); expect(after.decisions.at(-1)).toMatchObject({ redoOf: record.id, trigger: 'redo' });
  expect((await request('/api/conversations/conversation/retry-redo', 'POST', retry)).status).toBe(202); expect(fake.starts).toHaveLength(2);
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'undo')).toHaveLength(1);
  if (mode === 'revert') expect(git(origin, 'rev-parse', 'main')).toBe(head);
}, 60_000);

test('retry before Git mutation accepts resolved dirty state and rejects stale or reused requests', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  writeFileSync(join(path, 'outside.txt'), 'Kept until explicitly removed.'); await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  const blocked = (await app.conversations.view('conversation')); expect(blocked.redos.at(-1)?.status).toBe('blocked'); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toContain('Kept');
  const stale = { schema: 'retry-redo-v1', id: blocked.redos.at(-1)!.id, generation: blocked.conversation.generation - 1, clientRequestId: 'stale_retry' };
  expect((await request('/api/conversations/conversation/retry-redo', 'POST', stale)).status).toBe(409);
  rmSync(join(path, 'outside.txt')); fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  const input = await retryRedo(); expect((await app.conversations.view('conversation')).redos.at(-1)?.status).toBe('completed');
  expect((await request('/api/conversations/conversation/retry-redo', 'POST', { ...input, id: 'another' })).status).toBe(409); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('a missing final operation receipt cannot cause a completed redo to run twice after restart', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const ledger = app.conversations.ledger('conversation'); const append = ledger.append.bind(ledger); let lost = false;
  const fault = vi.spyOn(ledger, 'append').mockImplementation((input) => {
    const value = RedoOperationSchema.safeParse(input.data);
    if (!lost && value.success && value.data.status === 'completed') { lost = true; throw new Error('Simulated missing final operation receipt'); }
    return append(input);
  });
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); fault.mockRestore();
  expect(lost).toBe(true); expect((await app.conversations.view('conversation')).redos.at(-1)?.status).toBe('blocked'); expect(fake.starts).toHaveLength(2);
  await restartApplication(); expect((await app.conversations.view('conversation')).redos.at(-1)?.status).toBe('completed'); await retryRedo(); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('retry preserves newer outside commits and waits for explicit reconciliation before launching', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const unavailable = vi.spyOn(app.accounts, 'resolve').mockRejectedValueOnce(new Error('Account temporarily unavailable'));
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); unavailable.mockRestore();
  expect((await app.conversations.view('conversation')).redos.at(-1)?.result?.after).toBe(initial);
  writeFileSync(join(path, 'outside.txt'), 'Preserve newer work.'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside work'); const newer = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await retryRedo('outside_retry');
  expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ status: 'blocked', needsReconciliation: true }); expect(fake.starts).toHaveLength(1);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(newer); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Preserve newer work.');
  for (const action of ['reply', 'done']) {
    const refused = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: (await app.conversations.view('conversation')).conversation.generation, action, modelId: 'fixture-model', effort: 'high' });
    expect(refused.status).toBe(409); expect(await refused.text()).toContain('interrupted undo needs reconciliation');
  }
  expect(fake.starts).toHaveLength(1); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  // Simulate the user saving the outside work separately and restoring the expected checkout.
  git(path, 'update-ref', 'refs/fixture/outside', newer); git(path, 'reset', '--hard', initial);
  await retryRedo('reconciled_retry'); expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ status: 'completed', needsReconciliation: false });
  expect(fake.starts).toHaveLength(2); expect(git(path, 'show', 'refs/fixture/outside:outside.txt')).toBe('Preserve newer work.');
}, 60_000);

test('Just override preserves the running process and original decision, bumps generation once and indexes no request text', async () => {
  await create('conversation', 'Private user message must not appear in the correction index.');
  const started = deferred(); const finish = deferred();
  fake.enqueue(async ({ input }) => { started.resolve(); await finish.promise; await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await started.promise;
  const before = (await app.conversations.view('conversation')); const native = fake.runs[0]!.native;
  const input = await correct(1, 'noted', { effort: 'max' });
  const after = (await app.conversations.view('conversation')); expect(after.conversation.generation).toBe(before.conversation.generation + 1);
  expect(after.conversation.state).toBe('running'); expect(groupAlive(native.pgid)).toBe(true); expect(fake.starts).toHaveLength(1);
  expect(after.overrides).toMatchObject([{ changes: [{ field: 'effort', from: 'high', to: 'max' }], request: { mode: 'noted' }, context: 'reply in Fixture, small change, no risky areas recorded' }]);
  expect(after.decisions).toEqual(before.decisions); expect(after.stretches[0]!.effortRequested).toBe('high');
  const indexed = app.hub.list('overrides', OverrideRecordSchema).map((row) => row.document); expect(indexed).toEqual(after.overrides); expect(JSON.stringify(indexed)).not.toContain('Private user message');
  expect((await request('/api/conversations/conversation/correct', 'POST', input)).status).toBe(202); expect((await app.conversations.view('conversation')).conversation.generation).toBe(after.conversation.generation);
  expect((await request('/api/conversations/conversation/correct', 'POST', { ...input, choices: { effort: 'low' } })).status).toBe(409);
  finish.resolve(); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).stretches[0]?.status).toBe('completed');
}, 60_000);

test('redo stops the running step, saves code and memory, resets the selected range and launches the chosen step once', async () => {
  await create();
  fake.enqueue(async (turn) => { mkdirSync(join(path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(path, '.jevellan/memory/rule.md'), '# Undo this note\n'); return implement(turn); });
  await choose('implement'); await app.conversations.wait('conversation');
  const first = (await app.conversations.view('conversation')); const originalWork = first.conversation.work!;
  const started = deferred();
  fake.enqueue(async ({ signal }) => { writeFileSync(join(path, 'value.txt'), '3\n'); started.resolve(); await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' }; });
  await choose('implement'); await started.promise; const native = fake.runs[1]!.native;
  fake.enqueue(async ({ input }) => { expect(groupAlive(native.pgid)).toBe(false); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(existsSync(join(path, '.jevellan/memory/rule.md'))).toBe(false); await handoff(input, { summary: 'Redo using the selected reply.' }); return { status: 'completed' }; });
  const input = await correct(1, 'redo', { action: 'reply', effort: 'max' }); await app.conversations.wait('conversation');
  const after = (await app.conversations.view('conversation'));
  expect(after.redos.at(-1)?.status, JSON.stringify(after.redos)).toBe('completed'); expect(after.stretches.map((step) => step.status)).toEqual(['undone', 'undone', 'completed']);
  expect(after.conversation.work).toMatchObject({ id: originalWork.id, request: originalWork.request, baseCommit: originalWork.baseCommit, counters: { stretches: 1 } });
  expect(after.decisions.at(-1)).toMatchObject({ trigger: 'redo', action: { source: 'redo', chosen: 'reply' }, effort: { source: 'redo', requested: 'max', effective: 'high' } });
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(git(path, 'show', 'refs/jevellan/undo/conversation/1:value.txt')).toBe('3'); expect(git(path, 'show', 'refs/jevellan/undo/conversation/1:.jevellan/memory/rule.md')).toBe('# Undo this note');
  expect((await request('/api/conversations/conversation/correct', 'POST', input)).status).toBe(202); expect(fake.starts).toHaveLength(3);
  expect(after.handoffs[0]).toEqual(first.handoffs[0]); expect(after.conversation.generation).toBe(input.generation + 2);
// Includes the real 30-second late-handoff window plus cold memory startup and Git.
}, 120_000);

test('published last work reopens, reverts only its checkpoints after a clean rebase and publishes before redo', async () => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const original = (await app.conversations.view('conversation')).stretches[0]!.gitAfter!;
  const other = join(root, 'other'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'upstream.txt'), 'Preserve this.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Other work'); git(other, 'push');
  await choose('done'); await app.conversations.wait('conversation'); const closed = (await app.conversations.view('conversation')).closedWorks[0]!;
  const published = git(path, 'rev-parse', 'HEAD'); expect(published).not.toBe(original);
  fake.enqueue(async ({ input }) => { expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('Preserve this.\n'); await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); const view = (await app.conversations.view('conversation'));
  expect(view.redos.at(-1), JSON.stringify(view.redos)).toMatchObject({ status: 'completed', plan: { mode: 'revert', sourceTip: published, commits: [published] } });
  expect(view.closedWorks).toHaveLength(0); expect(view.conversation.work!.id).toBe(closed.id); expect(git(path, 'log', '-1', '--format=%s')).toMatch(/^Revert /);
  expect(view.stretches.map((step) => step.status)).toEqual(['undone', 'completed']);
}, 60_000);

test.each(['pending', 'checkpointed', 'running'] as const)('undo reopens the last closed work while newer work is %s, preserving both requests', async (state) => {
  await changeProject({ testCommand: 'test -f value.txt' }); const opened = await create();
  fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  const original = (await app.conversations.view('conversation')).closedWorks[0]!;
  const other = join(root, 'other'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'upstream.txt'), 'Independent upstream work.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Upstream between works'); git(other, 'push');
  const newerRequest = 'Make the newer change to three.\nPreserve this complete request.';
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'newer', text: newerRequest })).status).toBe(200);
  if (state !== 'running') expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'newer_note', text: 'Keep the independent upstream file.' })).status).toBe(200);
  const following = (await app.conversations.view('conversation')).conversation.work!; const started = deferred(); let pgid: number | undefined;
  if (state !== 'pending') {
    fake.enqueue(async ({ input, signal }) => {
      writeFileSync(join(path, 'value.txt'), '3\n'); mkdirSync(join(path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(path, '.jevellan/memory/newer.md'), '# Undo newer memory\n');
      started.resolve();
      if (state === 'running') { await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' }; }
      await handoff(input); return { status: 'completed' };
    });
    await choose('implement'); await started.promise;
    if (state === 'running') {
      pgid = fake.runs[1]!.native.pgid;
      expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'newer_note', text: 'Keep the independent upstream file.', kind: 'note' })).status).toBe(200);
    }
    else await app.conversations.wait('conversation');
  }
  const redo: FakeStep = async ({ input }) => {
    if (pgid) expect(groupAlive(pgid)).toBe(false);
    expect(input.brief).toContain(opened.conversation.work!.request); expect(input.brief).toContain(newerRequest); expect(input.brief).toContain('Keep the independent upstream file.');
    expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('Independent upstream work.\n');
    expect(existsSync(join(path, '.jevellan/memory/newer.md'))).toBe(false); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
    await handoff(input); return { status: 'completed' };
  };
  const apply = GitWorkspace.prototype.applyUndo;
  const interrupted = state === 'checkpointed' ? vi.spyOn(GitWorkspace.prototype, 'applyUndo').mockImplementationOnce(async function (this: GitWorkspace, ...args) {
    await apply.apply(this, args); throw new Error('Simulated interruption after applying undo');
  }) : undefined;
  if (!interrupted) fake.enqueue(redo);
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); interrupted?.mockRestore();
  if (interrupted) {
    const beforeRestart = (await app.conversations.view('conversation')); expect(beforeRestart.redos.at(-1)).toMatchObject({ status: 'blocked', followingWorkId: following.id }); expect(beforeRestart.conversation.work?.id).toBe(following.id);
    await restartApplication(); const recovered = (await app.conversations.view('conversation')); expect(recovered.conversation.work?.id).toBe(original.id); expect(recovered.stretches.every((step) => step.status === 'undone')).toBe(true);
    fake.enqueue(redo); await retryRedo('resume_across_works');
  }
  const view = (await app.conversations.view('conversation')); expect(view.redos.at(-1), JSON.stringify(view.redos)).toMatchObject({ status: 'completed', followingWorkId: following.id });
  expect(view.conversation.work).toMatchObject({ id: original.id, request: original.request, counters: { stretches: 1 } });
  expect(view.closedWorks).toEqual([expect.objectContaining({ id: following.id, request: newerRequest, closedAs: 'cancelled' })]);
  expect(view.stretches.map((step) => step.status)).toEqual(state === 'pending' ? ['undone', 'completed'] : ['undone', 'undone', 'completed']);
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true, workId: original.id });
  expect(fake.starts).toHaveLength(state === 'pending' ? 2 : 3);
}, 120_000);

test('a second published undo reverses only surviving checkpoints across the earlier undo and retains upstream work', async () => {
  await changeProject({ testCommand: 'test -f value.txt' }); const opened = await create();
  fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation');
  const other = join(root, 'other'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'upstream.txt'), 'Preserve the upstream addition.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Other work'); git(other, 'push');
  await choose('done'); await app.conversations.wait('conversation');
  const publishedFirstStep = git(path, 'rev-parse', 'HEAD^');
  git(other, 'pull', '--ff-only'); writeFileSync(join(other, 'later-upstream.txt'), 'Preserve work arriving during undo.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Later upstream work'); git(other, 'push');
  fake.enqueue(async ({ input }) => {
    expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
    writeFileSync(join(path, 'value.txt'), '4\n'); await handoff(input); return { status: 'completed' };
  });
  await correct(2, 'redo', { effort: 'low' }); await app.conversations.wait('conversation');
  const firstUndo = (await app.conversations.view('conversation')); expect(firstUndo.redos.at(-1)?.status).toBe('completed');
  expect(firstUndo.stretches[2]!.gitBefore).not.toBe(firstUndo.redos.at(-1)!.result!.after);
  await choose('done'); await app.conversations.wait('conversation');
  const before = (await app.conversations.view('conversation')); const published = git(origin, 'rev-parse', 'main');
  fake.enqueue(async ({ input }) => {
    expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('Preserve the upstream addition.\n'); expect(readFileSync(join(path, 'later-upstream.txt'), 'utf8')).toBe('Preserve work arriving during undo.\n');
    expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); await handoff(input); return { status: 'completed' };
  });
  const interrupted = vi.spyOn(GitWorkspace.prototype, 'applyUndo').mockRejectedValueOnce(new Error('Simulated interruption before applying prepared ranges'));
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); interrupted.mockRestore();
  const pending = (await app.conversations.view('conversation')); expect(pending.redos.at(-1)).toMatchObject({ status: 'blocked' }); expect(pending.redos.at(-1)!.plan!.ranges).toHaveLength(2);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(published); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('4\n'); expect(fake.starts).toHaveLength(3);
  await retryRedo('retry_recorded_ranges');
  const after = (await app.conversations.view('conversation')); const operation = after.redos.at(-1)!;
  expect(operation, JSON.stringify(operation)).toMatchObject({ status: 'completed', plan: { mode: 'revert', commits: [before.stretches[2]!.gitAfter, publishedFirstStep] } });
  expect(operation.plan!.ranges).toHaveLength(2); expect(git(path, 'rev-list', '--count', `${published}..HEAD`)).toBe('2');
  expect(after.stretches.map((step) => step.status)).toEqual(['undone', 'undone', 'undone', 'completed']);
  expect(after.conversation.work!.id).toBe(opened.conversation.work!.id); expect(fake.starts).toHaveLength(4);
  expect(git(origin, 'show', 'main:value.txt')).toBe('1'); expect(git(path, 'rev-parse', 'refs/jevellan/undo/conversation/1')).toBe(published);
}, 90_000);

test('undo refuses an unexplained gap between otherwise valid checkpoint receipts', async () => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  writeFileSync(join(path, 'outside.txt'), 'Keep unrecorded work.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside work between steps');
  // Restore history produced before writing admission rejected this gap. The
  // current owner must still refuse undo; no second provider step is launched.
  const ledger = app.conversations.ledger('conversation'); const work = new ConversationWork(ledger); const view = work.load(); const first = view.stretches[0]!; const outside = git(path, 'rev-parse', 'HEAD');
  ledger.append({ type: 'decision', data: DecisionRecordSchema.parse({ ...app.conversations.decisions('conversation')[0], id: 'legacy_gap', n: 2, outcome: { stretch: 2, status: 'completed', handoffStatus: 'done' } }) });
  const restored = { ...first, n: 2, decisionId: 'legacy_gap', status: 'running' as const, startedAt: new Date().toISOString(), gitBefore: outside }; delete restored.endedAt; delete restored.native; delete restored.gitAfter;
  work.start(StretchSchema.parse(restored), view.conversation.generation);
  writeFileSync(join(path, 'value.txt'), '3\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Legacy second checkpoint'); const before = git(path, 'rev-parse', 'HEAD');
  ledger.append({ type: 'git', stretch: 2, data: CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId: first.workId, stretch: 2, kind: 'stretch', before: outside, after: before }) });
  ledger.acceptHandoff(HandoffSchema.parse({ ...view.handoffs[0], stretch: 2 })); work.finish(2, { status: 'completed', usage: first.usage, gitAfter: before }, true);
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); const after = (await app.conversations.view('conversation'));
  expect(after.redos.at(-1)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('unrecorded boundary') });
  expect(after.stretches.map((step) => step.status)).toEqual(['completed', 'completed']); expect(fake.starts).toHaveLength(1);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(before); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Keep unrecorded work.\n'); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test('dirty checkout blocks redo without marking history undone or losing files', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const before = git(path, 'rev-parse', 'HEAD');
  writeFileSync(join(path, 'outside.txt'), 'Keep this.'); await correct(1, 'redo', { effort: 'low' }); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ status: 'blocked' }); expect((await app.conversations.view('conversation')).stretches[0]!.status).toBe('completed');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(before); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Keep this.'); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('restart records unfinished undo as blocked, repairs the override index and never starts a runtime', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await correct(1, 'noted', { effort: 'low' });
  const ledger = app.conversations.ledger('conversation'); const view = (await app.conversations.view('conversation'));
  ledger.append({ type: 'git', data: RedoOperationSchema.parse({ schema: 'redo-operation-v1', id: 'unfinished', workId: view.conversation.work!.id, status: 'requested', fromStretch: 1, generation: view.conversation.generation }) });
  await app.close(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ id: 'unfinished', status: 'blocked' }); expect((await app.conversations.view('conversation')).pause?.reason).toContain('restarted');
  expect(app.hub.list('overrides', OverrideRecordSchema)).toHaveLength(1); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('a durable Git result repairs missing undo history after restart without resetting or launching twice', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const ledger = app.conversations.ledger('conversation'); const originalAppend = ledger.append.bind(ledger); let lost = false;
  const failure = vi.spyOn(ledger, 'append').mockImplementation((input) => { if (input.type === 'undo' && !lost) { lost = true; throw new Error('Simulated missing undo receipt'); } return originalAppend(input); });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation'); failure.mockRestore();
  expect(lost).toBe(true); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect((await app.conversations.view('conversation')).stretches[0]!.status).toBe('completed');
  const result = (await app.conversations.view('conversation')).redos.at(-1)!; expect(result.result?.after).toBe(initial);
  await app.close(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  expect((await app.conversations.view('conversation')).stretches[0]!.status).toBe('undone'); expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'undo')).toHaveLength(1);
  await app.close(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'undo')).toHaveLength(1); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('external-policy redo rebuilds history while retaining repository content and all Git refs', async () => {
  await changeProject({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const refs = git(path, 'show-ref');
  fake.enqueue(async ({ input }) => { expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ status: 'completed' }); expect((await app.conversations.view('conversation')).stretches.map((step) => step.status)).toEqual(['undone', 'completed']);
  expect(git(path, 'show-ref')).toBe(refs); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
}, 60_000);

test('separately queued memory checkpoints belong to the selected step and disappear with its undo', async () => {
  mkdirSync(join(path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(path, '.jevellan/memory/retained.md'), '# Retained rule\n\nKeep the stable base note.\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Existing memory'); git(path, 'push'); initial = git(path, 'rev-parse', 'HEAD');
  await create(); fake.enqueue(async ({ input }) => { await handoff(input, { findings: [{ claim: 'memory: Undo fixture rule', pointer: 'value.txt:1' }] }); return { status: 'completed' }; });
  await choose('review'); await app.conversations.wait('conversation'); const before = (await app.conversations.view('conversation'));
  expect(before.stretches[0]!.status).toBe('completed'); expect(git(path, 'log', '-1', '--format=%s')).toMatch(/^memory: Capture/);
  const checkpoint = git(path, 'rev-parse', 'HEAD'); expect(checkpoint).not.toBe(initial);
  fake.enqueue(async ({ input }) => { expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).redos.at(-1), JSON.stringify((await app.conversations.view('conversation')).redos)).toMatchObject({ status: 'completed', plan: { sourceTip: checkpoint, target: initial } });
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'rev-parse', 'refs/jevellan/undo/conversation/1')).toBe(checkpoint);
  const memory = (await app.conversations.memory(project.id));
  expect((await memory.search('Undo', new AbortController().signal)).notes).toHaveLength(0); expect((await memory.search('Retained', new AbortController().signal)).notes).toHaveLength(1);
}, 60_000);

test('closing with Keep reserves checkpoints; Discard saves code and memory before resetting and releases the checkout', async () => {
  await create(); fake.enqueue(async (turn) => {
    mkdirSync(join(path, '.jevellan/memory'), { recursive: true }); writeFileSync(join(path, '.jevellan/memory/rule.md'), '# Durable rule\n'); return implement(turn);
  });
  await choose('implement'); await app.conversations.wait('conversation'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  const originalWork = (await app.conversations.view('conversation')).conversation.work!.id;
  const kept = await settle('keep');
  expect((await app.conversations.view('conversation')).closedWorks).toMatchObject([{ id: originalWork, closedAs: 'closed-by-you' }]);
  expect((await app.conversations.view('conversation')).settlements.at(-1)).toMatchObject({ status: 'completed', retained: true });
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true, workId: originalWork });
  expect((await request('/api/conversations/conversation/settle', 'POST', kept)).status).toBe(202);
  expect((await app.conversations.view('conversation')).settlements).toHaveLength(1);
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'next_request', text: 'Start new work.' })).status).toBe(409);
  expect((await app.conversations.view('conversation')).conversation.work).toBeNull();
  await create('second'); await choose('implement', 'second'); await app.conversations.wait('second'); expect(fake.starts).toHaveLength(1);
  await settle('discard'); const settled = (await app.conversations.view('conversation')).settlements.at(-1)!;
  expect(settled).toMatchObject({ status: 'completed', retained: false }); expect(settled.savedRef).toMatch(/^refs\/jevellan\/discard\/conversation\//);
  expect(git(path, 'rev-parse', settled.savedRef!)).toBe(checkpoint); expect(git(path, 'show', `${settled.savedRef}:.jevellan/memory/rule.md`)).toBe('# Durable rule');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(existsSync(join(path, '.jevellan/memory/rule.md'))).toBe(false);
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false });
  fake.enqueue(implement); await choose('implement', 'second'); await app.conversations.wait('second'); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('closing Publish verifies and publishes while preserving closed-by-you and idempotent request receipts', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const input = await settle('publish'); const view = (await app.conversations.view('conversation'));
  expect(view.closedWorks).toMatchObject([{ closedAs: 'closed-by-you' }]); expect(view.settlements.at(-1)).toMatchObject({ status: 'completed', choice: 'publish' });
  expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false });
  const ledger = app.conversations.ledger('conversation'); const count = ledger.events().length;
  expect((await request('/api/conversations/conversation/settle', 'POST', input)).status).toBe(202); expect(ledger.events()).toHaveLength(count);
  expect((await request('/api/conversations/conversation/settle', 'POST', { ...input, choice: 'discard' })).status).toBe(409);
  expect(ledger.events().filter((event) => event.type === 'verification').map((event) => ledger.data(event))).toMatchObject([{ passed: true, commit: git(path, 'rev-parse', 'HEAD') }]);
}, 60_000);

test('cancelled work can publish later without losing its request, counters or cancelled outcome', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const before = (await app.conversations.view('conversation')).conversation.work!;
  await app.conversations.cancel('conversation'); expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true });
  await settle('publish'); const view = (await app.conversations.view('conversation'));
  expect(view.conversation).toMatchObject({ state: 'cancelled', work: null }); expect(view.closedWorks).toHaveLength(1);
  expect(view.closedWorks[0]).toMatchObject({ id: before.id, request: before.request, counters: before.counters, closedAs: 'cancelled' });
  expect(view.settlements.at(-1)).toMatchObject({ status: 'completed', choice: 'publish' }); expect(fake.starts).toHaveLength(1);
  expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
}, 60_000);

test('failed closing verification keeps work open and owned, and cancelling then retrying preserves its closed outcome', async () => {
  await create(); fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation'); await settle('publish');
  expect((await app.conversations.view('conversation')).conversation.work).not.toBeNull(); expect((await app.conversations.view('conversation')).settlements.at(-1)).toMatchObject({ status: 'blocked' });
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true }); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  await app.conversations.cancel('conversation'); await settle('publish', 'retry_publish');
  expect((await app.conversations.view('conversation')).conversation).toMatchObject({ state: 'cancelled', work: null }); expect((await app.conversations.view('conversation')).closedWorks).toHaveLength(1);
  await settle('discard'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}, 60_000);

test('Discard refuses dirty files and already-published checkpoints without changing their contents or releasing ownership', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  writeFileSync(join(path, 'uncommitted.txt'), 'Keep this\n'); await settle('discard');
  expect((await app.conversations.view('conversation')).settlements.at(-1)?.reason).toContain('Uncommitted'); expect(readFileSync(join(path, 'uncommitted.txt'), 'utf8')).toBe('Keep this\n');
  rmSync(join(path, 'uncommitted.txt')); git(path, 'push'); await settle('discard', 'discard_published');
  expect((await app.conversations.view('conversation')).settlements.at(-1)?.reason).toContain('already published'); expect(git(path, 'rev-parse', 'HEAD')).toBe(checkpoint);
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true });
}, 60_000);

test('external work closes with files kept and no git mutation; Publish and Discard are refused', async () => {
  await changeProject({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const view = (await app.conversations.view('conversation')); const refs = git(path, 'show-ref'); const status = git(path, 'status', '--porcelain');
  for (const choice of ['publish', 'discard']) expect((await request('/api/conversations/conversation/settle', 'POST', { schema: 'settle-work-v1', clientRequestId: `external_${choice}`, workId: view.conversation.work!.id, generation: view.conversation.generation, choice })).status).toBe(409);
  await settle('keep'); expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toBe(status); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false }); expect((await app.conversations.view('conversation')).settlements.at(-1)).toMatchObject({ status: 'completed', retained: false });
}, 60_000);

test('a message during discard invalidates the settlement before reset and a concurrent choice cannot launch', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  const fetching = deferred(); const release = deferred(); const original = GitWorkspace.prototype.fetch;
  vi.spyOn(GitWorkspace.prototype, 'fetch').mockImplementation(async function (this: GitWorkspace) { fetching.resolve(); await release.promise; return original.call(this); });
  const current = (await app.conversations.view('conversation'));
  const response = await request('/api/conversations/conversation/settle', 'POST', { schema: 'settle-work-v1', clientRequestId: 'discard_pending', workId: current.conversation.work!.id, generation: current.conversation.generation, choice: 'discard' }); expect(response.status).toBe(202);
  await fetching.promise;
  const choice = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: current.conversation.generation, action: 'implement', modelId: 'fixture-model', effort: 'high' }); expect(choice.status).toBe(409);
  await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'correction', text: 'Keep these changes instead.' }); release.resolve(); await app.conversations.wait('conversation');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(checkpoint); expect((await app.conversations.view('conversation')).settlements.at(-1)).toMatchObject({ status: 'blocked' }); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('restart after a saved discard leaves recovery evidence and launches nothing; a fresh settlement releases the reservation', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  await settle('keep'); const before = (await app.conversations.view('conversation')); const target = before.closedWorks[0]!;
  const ledger = app.conversations.ledger('conversation');
  const event = ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse({ schema: 'work-settlement-v1', id: 'crashed', workId: target.id, choice: 'discard', status: 'requested', closedAs: 'closed-by-you', reclose: true, before: git(path, 'rev-parse', 'HEAD') }) });
  const workspace = new GitWorkspace(project, app.device.deviceId, app.conversations.ownership, { conversationId: 'conversation', conversationTitle: 'conversation', workId: target.id });
  const saved = await workspace.discard(initial, await workspace.head(), event.id, () => undefined, (savedRef) => {
    ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse({ ...WorkSettlementSchema.parse(ledger.data(event)), savedRef }) });
  });
  await app.close(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
  const recovered = (await app.conversations.view('conversation')); expect(recovered.settlements.at(-1)).toMatchObject({ id: 'crashed', status: 'blocked', savedRef: saved }); expect(fake.starts).toHaveLength(1); expect(git(path, 'show', `${saved}:value.txt`)).toBe('2');
  await app.conversations.settle('conversation', { schema: 'settle-work-v1', clientRequestId: 'after_restart', workId: target.id, generation: recovered.conversation.generation, choice: 'discard' }); await app.conversations.wait('conversation');
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false }); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test('delayed account reporting cannot stall a running runtime or erase its completed local outcome', async () => {
  await create(); const reporting = deferred(); const release = deferred();
  vi.spyOn(app.accounts, 'recordUsage').mockImplementation(async () => { reporting.resolve(); await release.promise; throw new Error('Fixture hub unavailable.'); });
  fake.enqueue(async ({ input, emit }) => { emit({ type: 'rate-limit', fiveHourPct: 12 }); await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await reporting.promise;
  try {
    await vi.waitFor(async () => expect((await app.conversations.view('conversation')).stretches[0]?.status).toBe('completed'), { timeout: 5000 });
    expect((await app.conversations.view('conversation')).decisions[0]?.outcome).toMatchObject({ status: 'completed', handoffStatus: 'done' });
  } finally { release.resolve(); await app.conversations.wait('conversation'); }
  expect((await app.conversations.view('conversation')).stretches[0]?.status).toBe('completed');
  expect((await app.conversations.view('conversation')).conversation.state).toBe('blocked'); expect(fake.starts).toHaveLength(1);
});

test('an unavailable account authority prevents a new stretch before it is recorded as running', async () => {
  await create(); vi.spyOn(app.accounts, 'markUsed').mockRejectedValue(new Error('Fixture hub unavailable.'));
  await choose('reply'); await app.conversations.wait('conversation');
  const view = (await app.conversations.view('conversation')); expect(view.stretches).toHaveLength(0); expect(view.decisions).toHaveLength(0);
  expect(view.conversation.state).toBe('blocked'); expect(fake.starts).toHaveLength(0);
});

test('delayed index delivery cannot stall streamed work or erase its completed local outcome', async () => {
  await create(); await app.conversations.indexes.flush();
  const reached = deferred(); const release = deferred(); const indexes = app.conversations.options.indexes; const publish = indexes.publish.bind(indexes);
  vi.spyOn(indexes, 'publish').mockImplementation(async input => { reached.resolve(); await release.promise; return publish(input); });
  fake.enqueue(async ({ input, emit }) => { emit({ type: 'text', delta: 'Continued while index delivery waited.' }); await handoff(input); return { status: 'completed' }; });
  try {
    await choose('reply'); await reached.promise;
    await vi.waitFor(async () => expect((await app.conversations.view('conversation')).stretches[0]?.status).toBe('completed'), { timeout: 20_000 });
    expect((await app.conversations.view('conversation')).handoffs).toHaveLength(1); expect(fake.starts).toHaveLength(1);
  } finally { release.resolve(); }
  await app.conversations.wait('conversation'); expect(app.hub.list('decisions', DecisionIndexSchema)[0]!.document.outcome?.status).toBe('completed');
}, 60_000);

test('restart rebuilds unavailable indexes from owner history without relaunching a step', async () => {
  await create(); await app.conversations.indexes.flush();
  vi.spyOn(app.conversations.options.indexes, 'publish').mockRejectedValue(new Error('Fixture unavailable index authority'));
  fake.enqueue(async ({ input, emit }) => { emit({ type: 'text', delta: 'Stored locally during the outage.' }); await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await expect(app.conversations.wait('conversation')).rejects.toThrow('unavailable index authority');
  expect((await app.conversations.view('conversation')).stretches[0]!.status).toBe('completed'); expect(app.hub.list('decisions', DecisionIndexSchema)).toHaveLength(0);
  const before = (await app.conversations.view('conversation')).decisions;
  await restartApplication(); await app.conversations.list();
  expect(app.hub.list('decisions', DecisionIndexSchema).map(row => row.document)).toEqual(before.map(decisionIndex));
  expect((await app.conversations.view('conversation')).decisions).toEqual(before); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('manual HTTP loop checkpoints locally, independently verifies and publishes before closing work', async () => {
  await create(); fake.enqueue(implement); expect((await choose('implement')).busy).toBe(true); await app.conversations.wait('conversation');
  const checkpoint = git(path, 'rev-parse', 'HEAD'); const view = (await app.conversations.view('conversation'));
  expect(view.conversation.state).toBe('waiting-for-you'); expect(view.stretches[0]).toMatchObject({ status: 'completed', gitBefore: initial, gitAfter: checkpoint });
  expect(checkpoint).not.toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(git(path, 'status', '--porcelain')).toBe('');
  expect((await app.accounts.status('acc_fixture')).usage).toMatchObject({ fiveHourPct: 12, weeklyPct: 8, source: 'stream' });
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true });
  await choose('done'); await app.conversations.wait('conversation');
  const finished = (await app.conversations.view('conversation')); expect(finished.conversation).toMatchObject({ state: 'done', work: null });
  expect(git(origin, 'rev-parse', 'main')).toBe(checkpoint); expect(git(path, 'log', '-1', '--format=%B')).toBe('implement: Completed the fixture step.');
  const ledger = app.conversations.ledger('conversation'); const receipts = ledger.events().filter((event) => event.type === 'verification').map((event) => ledger.data(event));
  expect(receipts).toHaveLength(1); expect(receipts[0]).toMatchObject({ passed: true, treeClean: true, commit: checkpoint, command: project.testCommand });
  expect(finished.decisions.map((decision) => decision.action.chosen)).toEqual(['implement', 'done']);
  expect(app.hub.list('decisions', DecisionIndexSchema).map((row) => row.document).sort((a, b) => a.id.localeCompare(b.id))).toEqual(finished.decisions.map(decisionIndex).sort((a, b) => a.id.localeCompare(b.id)));
  expect(existsSync(homes.at('conversations', 'conversation', 'decisions', '0002.json'))).toBe(true);
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false });
}, 60_000);

test('answer-only work and a later request keep separate objectives; replay and duplicate messages launch nothing', async () => {
  await create('conversation', 'Explain value.txt'); await create('conversation', 'Explain value.txt');
  fake.enqueue(async ({ input, emit }) => { emit({ type: 'text', delta: 'It contains one.' }); await handoff(input, { summary: 'It contains one.' }); return { status: 'completed' }; });
  await choose('reply'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'status', '--porcelain')).toBe('');
  const previous = (await app.conversations.view('conversation')).closedWorks[0]!.id;
  const message = { schema: 'conversation-message-v1', clientMessageId: 'next', text: 'Now do something different.' };
  await request('/api/conversations/conversation/messages', 'POST', message); await request('/api/conversations/conversation/messages', 'POST', message);
  const view = ConversationPublicSchema.parse(await (await request('/api/conversations/conversation')).json());
  expect(view.conversation.work).toMatchObject({ request: message.text, counters: { stretches: 0 } }); expect(view.conversation.work!.id).not.toBe(previous);
  expect(view.messages).toHaveLength(2); expect(view.summary.objective).toBe(message.text); expect(fake.starts).toHaveLength(1);
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'notice').map((event) => app.conversations.ledger('conversation').data(event))).not.toContainEqual(expect.objectContaining({ kind: 'closing' }));
}, 60_000);

test('a correction during credential resolution discards the pending choice before any runtime starts', async () => {
  await create(); const resolving = deferred(); const release = deferred(); const actual = app.accounts.resolve.bind(app.accounts);
  vi.spyOn(app.accounts, 'resolve').mockImplementation(async (id) => { resolving.resolve(); await release.promise; return actual(id); });
  await choose('implement'); await resolving.promise;
  await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'correction', text: 'Use three instead.' });
  release.resolve(); await app.conversations.wait('conversation'); expect(fake.starts).toHaveLength(0);
  expect((await app.conversations.view('conversation')).decisionWait).toMatchObject({ kind: 'jev-unavailable', text: 'Jev is unavailable (no key configured). Pick the next step:' }); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
});

test('undo across a published boundary preserves upstream work inserted before a later rewritten checkpoint', async () => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create();
  fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  const first = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; });
  await correct(2, 'redo', { action: 'implement' }); await app.conversations.wait('conversation');
  const other = join(root, 'other'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'upstream.txt'), 'Preserve the independent upstream checkpoint.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Independent upstream work'); git(other, 'push');
  await choose('done'); await app.conversations.wait('conversation'); const last = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  const view = (await app.conversations.view('conversation')); expect(view.redos.at(-1), JSON.stringify(view.redos)).toMatchObject({ status: 'completed' });
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n');
  expect(existsSync(join(path, 'upstream.txt'))).toBe(true);
  expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('Preserve the independent upstream checkpoint.\n');
  expect(view.redos.at(-1)!.plan!.commits).toEqual([last, first]);
  expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
}, 90_000);

test('checkout ownership blocks a second conversation while the first has clean unpublished checkpoints', async () => {
  await create(); await create('second'); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  expect(git(path, 'status', '--porcelain')).toBe(''); await choose('implement', 'second'); await app.conversations.wait('second');
  expect(fake.starts).toHaveLength(1); expect((await app.conversations.view('second')).pause?.reason).toContain('in use');
  expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test('notes do not interrupt, corrections repair the current step, and the next brief retains both verbatim', async () => {
  await create(); const started = deferred(); let interrupted = false;
  fake.enqueue(async ({ signal, emit }) => {
    emit({ type: 'text', delta: 'Working on the request.' }); started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { interrupted = true; resolve(); }, { once: true })); return { status: 'interrupted' };
  }, async ({ input }) => { expect(input.permissions).toBe('read-only'); await handoff(input, { status: 'partial', summary: 'Stopped for the correction.' }); return { status: 'completed' }; });
  await choose('implement'); await started.promise;
  const note = 'Preserve the existing public signature.'; const correction = 'Change only the numeric value.';
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'note', text: note, kind: 'note' })).status).toBe(200); expect(interrupted).toBe(false);
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'correction', text: correction })).status).toBe(200);
  await app.conversations.wait('conversation'); expect(interrupted).toBe(true);
  const view = (await app.conversations.view('conversation')); expect(view.stretches[0]!.status).toBe('interrupted'); expect(view.handoffs[0]!.status).toBe('partial'); expect(view.conversation.work!.counters.noProgress).toBe(0);
  fake.enqueue(async (turn) => { expect(turn.input.brief).toContain(note); expect(turn.input.brief).toContain(correction); return implement(turn); });
  await choose('implement'); await app.conversations.wait('conversation'); expect(fake.starts).toHaveLength(2);
  expect((await app.conversations.view('conversation')).stretches[1]!.status).toBe('completed');
}, 60_000);

test('plan approval, a blocked implementation and a continuation preserve the request, full plan, constraints and work base', async () => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.pauseAfterPlan = true;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  const requestText = 'Plan the change and preserve compatibility.'; const fullPlan = '# Complete plan\n1. Change the value.\n2. Verify the final checkpoint.\n3. Publish only after verification.';
  await create('conversation', requestText);
  fake.enqueue(async ({ input }) => { await handoff(input, { summary: 'A plan with three required steps.', result: { type: 'plan', content: fullPlan }, findings: [{ claim: 'constraint: Keep compatibility.', pointer: 'value.txt' }], proposedNext: 'implement' }); return { status: 'completed' }; });
  await choose('plan'); await app.conversations.wait('conversation'); const planned = (await app.conversations.view('conversation'));
  expect(planned.pause?.reason).toContain('full plan'); const ref = planned.conversation.work!.latestPlanRef!;
  expect((await request('/api/conversations/conversation/approve-plan', 'POST', { schema: 'plan-approval-v1', generation: planned.conversation.generation, ref })).status).toBe(200);
  fake.enqueue(async ({ input }) => {
    expect(input.brief).toContain(fullPlan); expect(input.brief).toContain(requestText); expect(input.brief).toContain('constraint: Keep compatibility.');
    writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input, { status: 'blocked', summary: 'Change is checkpointed; need clarification.', blockers: ['Confirm the final scope.'] }); return { status: 'completed' };
  });
  await choose('implement'); await app.conversations.wait('conversation'); const blocked = (await app.conversations.view('conversation'));
  expect(blocked.conversation.state).toBe('blocked'); expect(blocked.conversation.work!.baseCommit).toBe(initial);
  await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'continue', text: 'Continue with that scope.' });
  fake.enqueue(async (turn) => { expect(turn.input.brief).toContain(fullPlan); expect(turn.input.brief).toContain(requestText); expect(turn.input.brief).toContain('Continue with that scope.'); return implement(turn); });
  await choose('implement'); await app.conversations.wait('conversation'); const continued = (await app.conversations.view('conversation'));
  expect(continued.conversation.work).toMatchObject({ id: planned.conversation.work!.id, baseCommit: initial, request: requestText, counters: { stretches: 3 } });
  await choose('done'); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).conversation.state).toBe('done'); expect(git(origin, 'rev-parse', 'main')).not.toBe(initial);
}, 60_000);

test('an agent-reported pass cannot close work when daemon verification fails on the final checkpoint', async () => {
  await create(); fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), 'wrong\n'); await handoff(input, { testsRun: { command: 'old agent test', passed: true, summary: 'A stale claim.' } }); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.work!.counters.testFailures).toBe(1); expect((await app.conversations.view('conversation')).pause?.reason).toContain('Verification failed');
  expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test('manual selection cannot bypass a guard; a reply grants one allowance on the same work exactly once', async () => {
  const config = app.hub.configuration.current()!; config.configuration['x-jevellan'].guards.maxStretchesPerWork = 1;
  app.hub.configuration.put(config.configuration, config.revision, { deviceId: app.device.deviceId, source: 'ui' });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const stopped = (await app.conversations.view('conversation'));
  expect(stopped.pause?.guard).toBeDefined();
  const refused = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: stopped.conversation.generation, action: 'reply', modelId: 'fixture-model', effort: 'high' }); expect(refused.status).toBe(409); expect(fake.starts).toHaveLength(1);
  const message = { schema: 'conversation-message-v1', clientMessageId: 'grant', text: 'Continue for one more step.' };
  await request('/api/conversations/conversation/messages', 'POST', message); await request('/api/conversations/conversation/messages', 'POST', message);
  const continued = (await app.conversations.view('conversation')); expect(continued.conversation.work).toMatchObject({ id: stopped.conversation.work!.id, baseCommit: initial, allowance: { stretches: 2 } }); expect(continued.conversation.work!.allowance.grants).toHaveLength(1);
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await choose('reply'); await app.conversations.wait('conversation'); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('memory captured by a read-only reply publishes without running a failing code test', async () => {
  const opened = await create('conversation', 'Record the fixture convention in project memory.');
  fake.enqueue(async ({ input }) => {
    expect(input.permissions).toBe('read-only');
    await handoff(input, { findings: [{ claim: 'memory: Fixture convention', pointer: 'value.txt:1' }] }); return { status: 'completed' };
  });
  await choose('reply'); await app.conversations.wait('conversation'); const checkpoint = git(path, 'rev-parse', 'HEAD'); expect(checkpoint).not.toBe(initial);
  await choose('done'); await app.conversations.wait('conversation'); const finished = (await app.conversations.view('conversation'));
  expect(finished.conversation.state, finished.pause?.reason).toBe('done'); expect(finished.closedWorks[0]!.id).toBe(opened.conversation.work!.id);
  expect(git(origin, 'rev-parse', 'main')).toBe(checkpoint); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n');
  const ledger = app.conversations.ledger('conversation'); expect(ledger.events().filter((event) => event.type === 'verification')).toEqual([]);
  expect(ledger.events().filter((event) => event.type === 'publication').map((event) => ledger.data(event))).toEqual([expect.objectContaining({ status: 'published', commit: checkpoint, verificationExemption: 'memory-only' })]);
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false });
}, 60_000);

test('automatic note merging refreshes recall and undo restores the upstream version without reverting its changes', async () => {
  const note = '.jevellan/memory/convention.md'; mkdirSync(join(path, '.jevellan/memory'), { recursive: true });
  writeFileSync(join(path, note), '---\ntitle: Convention\npermalink: convention\n---\nBase convention.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed memory'); git(path, 'push'); initial = git(path, 'rev-parse', 'HEAD');
  await create('conversation', 'Update the convention note.'); fake.enqueue(async ({ input }) => {
    expect(input.brief).toContain('Base convention.');
    writeFileSync(join(input.cwd, note), '---\ntitle: Convention\npermalink: convention\n---\nLocal convention.\n');
    await handoff(input, { changedFiles: [note] }); return { status: 'completed' };
  });
  await choose('implement'); await app.conversations.wait('conversation');
  const other = join(root, 'other'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(other, note), '---\ntitle: Convention\npermalink: convention\n---\nUpstream quartz convention.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Update upstream convention'); git(other, 'push');
  await choose('done'); await app.conversations.wait('conversation'); const finished = (await app.conversations.view('conversation'));
  expect(finished.conversation.state, finished.pause?.reason).toBe('done'); expect(finished.stretches).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
  const memory = app.memory.project(project, app.device.deviceId, () => undefined); const signal = new AbortController().signal;
  expect((await memory.search('quartz', signal)).notes).toEqual([expect.objectContaining({ permalink: 'convention', unresolved: true })]);
  const saved = await memory.read('convention', signal); expect(saved.content).toContain('Local convention.'); expect(saved.content).toContain('Upstream quartz convention.'); expect(saved.unresolved).toBe(true);
  const committed = readFileSync(join(path, note), 'utf8'); const head = git(path, 'rev-parse', 'HEAD');
  await create('recall', 'Explain the quartz convention.'); fake.enqueue(async ({ input }) => {
    expect(input.brief).toContain('(conflicting versions, unresolved)'); expect(input.brief).toContain('Upstream quartz convention.'); await handoff(input); return { status: 'completed' };
  });
  await choose('reply', 'recall'); await app.conversations.wait('recall'); expect((await app.conversations.view('recall')).stretches[0]?.status).toBe('completed');
  expect(fake.starts).toHaveLength(2); expect(readFileSync(join(path, note), 'utf8')).toBe(committed); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(git(path, 'status', '--porcelain')).toBe('');
  const upstreamNote = readFileSync(join(other, note), 'utf8'); git(other, 'pull', '--ff-only');
  writeFileSync(join(other, '.jevellan/memory/late.md'), '---\ntitle: Later convention\npermalink: later-convention\n---\nThe upstream pearl convention arrived before undo publication.\n');
  git(other, 'add', '-A'); git(other, 'commit', '-m', 'Later upstream memory'); git(other, 'push');
  fake.enqueue(async ({ input }) => {
    expect(readFileSync(join(path, note), 'utf8')).toBe(upstreamNote);
    expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD'));
    const restored = await memory.read('convention', signal); expect(restored.content).toContain('Upstream quartz convention.'); expect(restored.content).not.toContain('Local convention.'); expect(restored.unresolved).toBe(false);
    expect((await memory.search('pearl', signal)).notes).toContainEqual(expect.objectContaining({ permalink: 'later-convention' }));
    await handoff(input); return { status: 'completed' };
  });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  const undone = (await app.conversations.view('conversation'));
  expect(undone.redos.at(-1), JSON.stringify(undone.redos)).toMatchObject({ status: 'completed', plan: { mode: 'revert', commits: [head] } });
  expect(undone.stretches.map((entry) => entry.status)).toEqual(['undone', 'completed']);
  expect(app.conversations.ledger('conversation').events().filter((event) => event.type === 'verification')).toHaveLength(0);
  expect(git(path, 'status', '--porcelain')).toBe('');
}, 90_000);

test.each([1, 2])('conflict integration publishes verified code and memory, and undo from step %i preserves upstream intent', async (fromStretch) => {
  await changeProject({ testCommand: 'test "$(cat value.txt)" -ge 2' });
  const opened = await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const checkpoint = git(path, 'rev-parse', 'HEAD'); const other = join(root, 'upstream'); git(root, 'clone', origin, other);
  git(other, 'config', 'user.name', 'Other fixture'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'value.txt'), '3\n'); writeFileSync(join(other, 'upstream.txt'), 'Keep upstream work.\n');
  git(other, 'add', '-A'); git(other, 'commit', '-m', 'Change the same value upstream'); git(other, 'push', 'origin', 'main');
  fake.enqueue(async ({ input }) => {
    expect(input.action).toBe('integrate'); expect(input.permissions).toBe('write'); expect(input.brief).toContain(opened.conversation.work!.request);
    expect(await integrate(input, 'start')).toMatchObject({ result: { status: 'conflict', conflicts: ['value.txt'] } });
    writeFileSync(join(path, 'value.txt'), '5\n'); expect(await integrate(input, 'continue')).toMatchObject({ result: { status: 'clean', conflicts: [] } });
    await handoff(input, { findings: [{ claim: 'memory: Integration keeps both contributions', pointer: 'value.txt:1' }] }); return { status: 'completed' };
  });
  await choose('done'); await app.conversations.wait('conversation');
  const finished = (await app.conversations.view('conversation')); const head = git(path, 'rev-parse', 'HEAD');
  expect(finished.conversation.state, finished.pause?.reason).toBe('done');
  expect(finished.stretches.map((entry) => [entry.action, entry.status])).toEqual([['implement', 'completed'], ['integrate', 'completed']]);
  expect(finished.closedWorks[0]).toMatchObject({ id: opened.conversation.work!.id, request: opened.conversation.work!.request, baseCommit: initial });
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(origin, 'rev-parse', 'main')).toBe(head);
  expect(git(origin, 'show', 'main:value.txt')).toBe('5'); expect(git(origin, 'show', 'main:upstream.txt')).toBe('Keep upstream work.');
  const notes = git(origin, 'ls-tree', '-r', '--name-only', 'main', '.jevellan/memory').split('\n').filter(Boolean); expect(notes).toHaveLength(1);
  expect(git(origin, 'show', `main:${notes[0]}`)).toContain('Integration keeps both contributions'); expect(git(path, 'log', '-1', '--format=%s')).toMatch(/^memory: Capture/);
  expect(git(path, 'rev-parse', 'refs/jevellan/pre-integration/conversation/2')).toBe(checkpoint);
  const ledger = app.conversations.ledger('conversation');
  const receipts = ledger.events().filter((event) => event.type === 'verification').map((event) => ledger.data(event));
  expect(receipts).toContainEqual(expect.objectContaining({ commit: checkpoint, trigger: 'done-gate', passed: true }));
  expect(receipts).toContainEqual(expect.objectContaining({ commit: head, trigger: 'publication', passed: true, treeClean: true, headStable: true }));
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: false });
  fake.enqueue(async ({ input }) => {
    expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe(fromStretch === 1 ? '3\n' : '5\n');
    expect(readFileSync(join(path, 'upstream.txt'), 'utf8')).toBe('Keep upstream work.\n');
    expect(git(path, 'ls-tree', '-r', '--name-only', 'HEAD', '.jevellan/memory')).toBe('');
    expect(git(origin, 'rev-parse', 'main')).toBe(git(path, 'rev-parse', 'HEAD')); await handoff(input); return { status: 'completed' };
  });
  await correct(fromStretch, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  const corrected = (await app.conversations.view('conversation')); expect(corrected.redos.at(-1), JSON.stringify(corrected.redos)).toMatchObject({ status: 'completed', plan: { mode: 'revert' } });
  expect(corrected.redos.at(-1)!.plan!.commits).toHaveLength(fromStretch === 1 ? 2 : 1);
  expect(corrected.stretches.map((entry) => entry.status)).toEqual([fromStretch === 1 ? 'undone' : 'completed', 'undone', 'completed']);
}, 90_000);

test('a direct agent commit fails its step and remains barred from subsequent done publication', async () => {
  await create(); fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Unexpected agent commit'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).stretches[0]?.status).toBe('failed');
  const refused = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: (await app.conversations.view('conversation')).conversation.generation, action: 'done' });
  expect(refused.status).toBe(409); expect(await refused.text()).toContain('publication are blocked'); expect(fake.starts).toHaveLength(1);
  expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect((await app.conversations.view('conversation')).conversation.work).not.toBeNull();
}, 60_000);

test('external projects verify their uncommitted contents without changing HEAD or publishing', async () => {
  await changeProject({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' } });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  const view = (await app.conversations.view('conversation')); expect(view.conversation.state).toBe('done'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(git(path, 'status', '--porcelain')).toContain('value.txt'); const ledger = app.conversations.ledger('conversation');
  const receipt = ledger.data(ledger.events().find((event) => event.type === 'verification')!) as { worktreeBefore: string; worktreeAfter: string; treeClean: boolean };
  expect(receipt.treeClean).toBe(false); expect(receipt.worktreeBefore).toHaveLength(64); expect(receipt.worktreeAfter).toBe(receipt.worktreeBefore);
}, 60_000);

test('an external verification that changes files does not close work even when its command succeeds', async () => {
  await changeProject({ branchPolicy: 'external', testCommand: 'printf "3\\n" > value.txt', memory: { mode: 'device', dir: '.jevellan/memory' } });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.work?.counters.testFailures).toBe(1);
  expect((await app.conversations.view('conversation')).pause?.reason).toContain('tested files changed'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
}, 60_000);

test('a message arriving during done verification prevents publication from the stale generation', async () => {
  await changeProject({ testCommand: 'touch .git/verification-start; while [ ! -f .git/verification-release ]; do sleep 0.05; done; test "$(cat value.txt)" = 2' });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done');
  await vi.waitFor(() => expect(existsSync(join(path, '.git/verification-start'))).toBe(true), { timeout: 10_000 });
  await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'during_verification', text: 'Wait: add three as well.' });
  writeFileSync(join(path, '.git/verification-release'), 'continue'); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).conversation.work).not.toBeNull(); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect((await app.conversations.view('conversation')).decisionWait).toMatchObject({ kind: 'jev-unavailable', text: 'Jev is unavailable (no key configured). Pick the next step:' });
}, 60_000);

test('cancellation terminates an in-progress verification and retains unpublished ownership', async () => {
  await changeProject({ testCommand: 'echo $$ > .git/verification-pid; while :; do sleep 1; done' });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done');
  await vi.waitFor(() => expect(existsSync(join(path, '.git/verification-pid'))).toBe(true), { timeout: 10_000 }); const pid = Number(readFileSync(join(path, '.git/verification-pid'), 'utf8'));
  const response = await request('/api/conversations/conversation/cancel', 'POST', { schema: 'empty-request-v1' }); expect(response.status).toBe(200);
  expect(() => process.kill(pid, 0)).toThrow(); expect((await app.conversations.view('conversation')).conversation.state).toBe('cancelled');
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true }); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

async function stream(after = 0) {
  const abort = new AbortController(); streams.push(abort);
  const response = await fetch(`${base}/api/conversations/conversation/events`, { headers: { Cookie: cookie, 'Last-Event-ID': String(after) }, signal: abort.signal }); expect(response.status).toBe(200);
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; const pending: ReturnType<typeof ConversationEventSchema.parse>[] = [];
  return { abort, async through(last: number) {
    const events: ReturnType<typeof ConversationEventSchema.parse>[] = [];
    while (!events.length || events.at(-1)!.event.id < last) {
      if (pending.length) { events.push(pending.shift()!); continue; }
      const chunk = await reader.read(); if (chunk.done) throw new Error('Stream ended early'); buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf('\n\n'); if (end < 0) break; const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: ')); if (data) pending.push(ConversationEventSchema.parse(JSON.parse(data.slice(6))));
      }
    }
    return events;
  } };
}
test('two authenticated SSE viewers and reconnect receive exact ledger ids without launching work or exposing native identities', async () => {
  await create(); const ledger = app.conversations.ledger('conversation'); const initialLast = ledger.events().at(-1)!.id;
  const a = await stream(); const b = await stream(); const first = await a.through(initialLast); expect(await b.through(initialLast)).toEqual(first); a.abort.abort();
  fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const last = ledger.events().at(-1)!.id;
  const reconnected = await stream(initialLast); const remaining = await reconnected.through(last); expect(await b.through(last)).toEqual(remaining);
  expect([...first, ...remaining].map((entry) => entry.event.id)).toEqual(ledger.events().map((entry) => entry.id));
  const native = fake.runs[0]!.native; expect(JSON.stringify(remaining)).not.toContain(native.sessionId); expect(JSON.stringify(remaining)).not.toContain('"pgid"');
  const nativeEvent = ledger.events().find((event) => event.type === 'state' && (ledger.data(event) as { kind?: string }).kind === 'native')!;
  const content = await (await request(`/api/conversations/conversation/read?pointer=ledger/${nativeEvent.id}`)).text(); expect(content).not.toContain(native.sessionId);
  expect(fake.starts).toHaveLength(1); expect((await fetch(`${base}/api/conversations/conversation/events`)).status).toBe(401);
  const invalid = await request('/api/conversations/conversation/events?after=999999'); expect(invalid.status).toBe(400);
}, 60_000);

test('application startup recovers a recorded running process before serving history and never relaunches it', async () => {
  await create(); const work = new ConversationWork(app.conversations.ledger('conversation')); work.baseCommit(initial); const view = work.load();
  const { native } = await spawnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path, env: { PATH: process.env.PATH ?? '', HOME: homes.userHome } });
  try {
    work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'implement', modelId: 'fixture-model', runtime: 'fake', model: 'scripted-model', effortRequested: 'high', effortEffective: 'high', accountId: 'acc_fixture', deviceId: app.device.deviceId, decisionId: 'interrupted', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, native }), view.conversation.generation);
    await app.close(); app = new Application({ homes, timers: false, runtimes: () => new Map([['fake', fake]]) }); await app.conversations.ready;
    expect(groupAlive(native.pgid)).toBe(false); const recovered = (await app.conversations.view('conversation'));
    expect(recovered.conversation.state).toBe('waiting-for-you'); expect(recovered.stretches[0]?.status).toBe('interrupted'); expect(recovered.pause?.reason).toContain('Jevellan restarted'); expect(fake.starts).toHaveLength(0);
  } finally { await terminateGroup(native); }
}, 30_000);

test('a graceful stop during a running step leaves the work open for restart recovery instead of cancelling it', async () => {
  await create(); const started = deferred();
  fake.enqueue(async ({ input, emit, signal }) => {
    writeFileSync(join(input.cwd, 'value.txt'), '2\n'); emit({ type: 'text', delta: 'Partial change before the stop.' }); started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' };
  });
  await choose('implement'); await started.promise;
  const running = await app.conversations.view('conversation'); const workId = running.conversation.work!.id; const pgid = fake.runs[0]!.native.pgid;
  expect(await app.conversations.ownership.current(project)).toMatchObject({ workId, conversationId: 'conversation', held: true });
  await restartApplication();
  expect(groupAlive(pgid)).toBe(false);
  const recovered = await app.conversations.view('conversation');
  expect(recovered.conversation.state).toBe('waiting-for-you'); expect(recovered.pause?.reason).toBe(RESTART_NOTICE);
  expect(recovered.conversation.work?.id).toBe(workId); expect(recovered.closedWorks).toEqual([]);
  expect(recovered.stretches.map((entry) => entry.status)).toEqual(['interrupted']); expect(recovered.handoffs[0]).toMatchObject({ stretch: 1, status: 'partial' });
  expect(await app.conversations.ownership.current(project)).toMatchObject({ workId, conversationId: 'conversation', held: true });
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  await app.conversations.wait('conversation'); expect(fake.starts).toHaveLength(1);
  await continueAfterRestart();
}, 60_000);

test('crash recovery at startup routes an interrupted step\'s uncommitted edits through review instead of a dead end', async () => {
  await create(); const work = new ConversationWork(app.conversations.ledger('conversation')); work.baseCommit(initial); const view = work.load(); const workId = view.conversation.work!.id;
  await app.conversations.ownership.acquire(project, { conversationId: 'conversation', conversationTitle: 'conversation', workId });
  const { native } = await spawnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path, env: { PATH: process.env.PATH ?? '', HOME: homes.userHome } });
  try {
    work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId, action: 'implement', modelId: 'fixture-model', runtime: 'fake', model: 'scripted-model', effortRequested: 'high', effortEffective: 'high', accountId: 'acc_fixture', deviceId: app.device.deviceId, decisionId: 'crashed', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, native, gitBefore: initial }), view.conversation.generation);
    writeFileSync(join(path, 'value.txt'), '2\n');
    await restartApplication(); expect(groupAlive(native.pgid)).toBe(false);
    const recovered = await app.conversations.view('conversation');
    expect(recovered.conversation.state).toBe('waiting-for-you'); expect(recovered.pause?.reason).toBe(RESTART_NOTICE); expect(recovered.stretches[0]?.status).toBe('interrupted');
    expect(fake.starts).toHaveLength(0);
    await continueAfterRestart(0);
  } finally { await terminateGroup(native); }
}, 60_000);

// A crash leaves the running operation behind: the old service never drains it, and startup recovery owns the stretch.
async function crashApplication(id = 'conversation') {
  // A dead process writes nothing more: silence the old service's ledger and skip its graceful shutdown.
  const ledger = app.conversations.ledger(id); vi.spyOn(ledger, 'append').mockImplementation((entry) => ({ schema: 'ledger-event-v1', t: new Date().toISOString(), id: 0, ...entry }) as ReturnType<typeof ledger.append>);
  vi.spyOn(app.conversations, 'close').mockImplementation(async () => {}); vi.spyOn(app.lifecycle, 'close').mockImplementation(() => {}); await restartApplication();
}

test('a crash during Integrate leaves the rebase to integration recovery, and publishing continues without a dead end', async () => {
  await changeProject({ testCommand: 'test "$(cat value.txt)" -ge 2' });
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const other = join(root, 'upstream'); git(root, 'clone', origin, other); git(other, 'config', 'user.name', 'Other fixture'); git(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'value.txt'), '3\n'); writeFileSync(join(other, 'upstream.txt'), 'Keep upstream work.\n'); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Change the same value upstream'); git(other, 'push', 'origin', 'main');
  const rebasing = deferred();
  fake.enqueue(async ({ input }) => {
    expect(await integrate(input, 'start')).toMatchObject({ result: { status: 'conflict', conflicts: ['value.txt'] } }); rebasing.resolve();
    return new Promise(() => {}); // The daemon dies here, mid-rebase.
  });
  await choose('done'); await rebasing.promise; expect(git(path, 'status')).toContain('rebase');
  await crashApplication();
  const recovered = await app.conversations.view('conversation');
  expect(recovered.stretches.map((entry) => [entry.action, entry.status])).toEqual([['implement', 'completed'], ['integrate', 'interrupted']]);
  expect(recovered.checkpointBlocks).toEqual([]); expect(recovered.pause?.reason).toBe(RESTART_NOTICE);
  git(path, 'rebase', '--abort'); // The rebase belongs to integration recovery; once it is abandoned, publication integrates again.
  fake.enqueue(async ({ input }) => {
    expect(input.action).toBe('integrate'); expect(await integrate(input, 'start')).toMatchObject({ result: { status: 'conflict' } });
    writeFileSync(join(path, 'value.txt'), '5\n'); expect(await integrate(input, 'continue')).toMatchObject({ result: { status: 'clean' } });
    await handoff(input); return { status: 'completed' };
  });
  await choose('done'); await app.conversations.wait('conversation');
  const finished = await app.conversations.view('conversation');
  expect(finished.conversation.state, finished.pause?.reason).toBe('done'); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(git(origin, 'show', 'main:value.txt')).toBe('5'); expect(git(origin, 'show', 'main:upstream.txt')).toBe('Keep upstream work.');
}, 90_000);

test('a crash after the checkpoint commit keeps the receipt and publishes without a Changes review', async () => {
  await create(); const work = new ConversationWork(app.conversations.ledger('conversation')); work.baseCommit(initial); const view = work.load(); const workId = view.conversation.work!.id;
  await app.conversations.ownership.acquire(project, { conversationId: 'conversation', conversationTitle: 'conversation', workId });
  const { native } = await spawnGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path, env: { PATH: process.env.PATH ?? '', HOME: homes.userHome } });
  try {
    work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId, action: 'implement', modelId: 'fixture-model', runtime: 'fake', model: 'scripted-model', effortRequested: 'high', effortEffective: 'high', accountId: 'acc_fixture', deviceId: app.device.deviceId, decisionId: 'crashed', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, native, gitBefore: initial }), view.conversation.generation);
    writeFileSync(join(path, 'value.txt'), '2\n'); git(path, 'commit', '-qam', 'implement: Change the value'); const head = git(path, 'rev-parse', 'HEAD');
    work.ledger.append({ type: 'git', stretch: 1, data: CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId, stretch: 1, kind: 'stretch', before: initial, after: head }) });
    await restartApplication(); expect(groupAlive(native.pgid)).toBe(false);
    const recovered = await app.conversations.view('conversation');
    expect(recovered.stretches[0]?.status).toBe('interrupted'); expect(recovered.checkpointBlocks).toEqual([]);
    fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
    await choose('implement'); await app.conversations.wait('conversation'); expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    const reply = await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'finish', text: 'Finish and publish.' });
    expect(reply.status, await reply.text()).toBeLessThan(300); await app.conversations.wait('conversation');
    // The no-progress stop and the unanswered message leave Done unavailable as a step; Close work publishes explicitly.
    expect((await app.conversations.view('conversation')).allowed).not.toContain('done');
    await settle('publish');
    const finished = await app.conversations.view('conversation');
    expect(finished.closedWorks).toMatchObject([{ closedAs: 'closed-by-you' }]); expect(finished.settlements.at(-1)).toMatchObject({ status: 'completed', choice: 'publish' });
    expect(git(origin, 'rev-parse', 'main')).toBe(head); expect(fake.starts).toHaveLength(1);
    expect((await app.conversations.changes('conversation', 2)).verifications.some((entry) => entry.passed && entry.commit === head)).toBe(true);
  } finally { await terminateGroup(native); }
}, 60_000);

// 7.5: "Send a message to continue" must continue. Leftover edits are reviewed and accepted first; nothing launches before that.
async function continueAfterRestart(launched = 1) {
  expect((await app.conversations.view('conversation')).checkpointBlocks.map((block) => block.stretch)).toEqual([1]);
  const sent = await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'after_restart', text: 'Continue.' });
  expect(sent.status, await sent.text()).toBeLessThan(300); await app.conversations.wait('conversation');
  const early = await request('/api/conversations/conversation/manual', 'POST', { schema: 'manual-step-v1', generation: (await app.conversations.view('conversation')).conversation.generation, action: 'implement', modelId: 'fixture-model', effort: 'high' });
  await early.text(); await app.conversations.wait('conversation');
  expect(fake.starts).toHaveLength(launched); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  const review = await adoptionReview(); expect(review.changes.uncommitted).toContain('+2');
  const accepted = await acceptFiles(review.input);
  expect(accepted.checkpointBlocks).toEqual([]); expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(path, 'rev-parse', 'HEAD')).not.toBe(initial);
  expect(git(path, 'show', 'HEAD:value.txt')).toBe('2'); expect(fake.starts).toHaveLength(launched);
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation');
  expect(fake.starts).toHaveLength(launched + 1); const after = await app.conversations.view('conversation');
  expect(after.stretches.at(-1)).toMatchObject({ status: 'completed' }); expect(after.conversation.state).not.toBe('blocked'); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
}

test('rename updates the indexed title during execution without interrupting the native process or changing its request', async () => {
  const opened = await create(); const started = deferred(); const release = deferred();
  fake.enqueue(async ({ input, signal }) => { started.resolve(); await Promise.race([release.promise, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]); if (signal.aborted) return { status: 'interrupted' }; await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await started.promise; const before = (await app.conversations.view('conversation')); const pgid = fake.runs[0]!.native.pgid;
  const input = { schema: 'rename-conversation-v1', clientRequestId: 'rename_running', previousTitle: before.conversation.title, title: 'The updated title' };
  expect((await request('/api/conversations/conversation/rename', 'POST', input)).status).toBe(200);
  expect(groupAlive(pgid)).toBe(true); expect((await app.conversations.view('conversation')).conversation).toMatchObject({ title: input.title, generation: before.conversation.generation, state: 'running', work: { request: opened.conversation.work!.request } });
  expect((await app.conversations.list()).conversations[0]!.title).toBe(input.title); expect(fake.starts).toHaveLength(1);
  expect((await request('/api/conversations/conversation/rename', 'POST', input)).status).toBe(200);
  expect((await request('/api/conversations/conversation/rename', 'POST', { ...input, clientRequestId: 'stale_name', title: 'Overwrites a newer title' })).status).toBe(409);
  release.resolve(); await app.conversations.wait('conversation'); await restartApplication(); expect((await app.conversations.view('conversation')).conversation.title).toBe(input.title);
}, 60_000);

test('outside finish without a reason closes pending work, survives reload, and an old retry cannot close a new request', async () => {
  const opened = await create(); const input = { schema: 'finish-outside-v1', clientRequestId: 'outside_pending', generation: opened.conversation.generation };
  const response = await request('/api/conversations/conversation/finish-outside', 'POST', input); expect(response.status).toBe(200);
  const finished = ConversationPublicSchema.parse(await response.json()); expect(finished.conversation).toMatchObject({ state: 'done', work: null, outcome: { kind: 'finished-elsewhere' } }); expect(finished.conversation.outcome?.reason).toBeUndefined(); expect(finished.finishes[0]).toMatchObject({ status: 'completed', retained: false }); expect(fake.starts).toHaveLength(0);
  await restartApplication(); expect((await app.conversations.list()).conversations[0]!.state).toBe('done'); expect((await app.conversations.view('conversation')).conversation.outcome).toEqual(finished.conversation.outcome);
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'fresh', text: 'A fresh request' })).status).toBe(200);
  expect((await request('/api/conversations/conversation/finish-outside', 'POST', input)).status).toBe(200);
  const current = (await app.conversations.view('conversation')); expect(current.conversation.work?.request).toBe('A fresh request'); expect(current.conversation.outcome).toBeUndefined(); expect(current.finishes).toHaveLength(1);
});

test.each(['main', 'external'] as const)('outside finish stops the running process, keeps %s checkout changes and records the reason', async (policy) => {
  await changeProject({ branchPolicy: policy }); const opened = await create(); const started = deferred();
  fake.enqueue(async ({ signal }) => { writeFileSync(join(path, 'value.txt'), '2\n'); started.resolve(); await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' }; });
  await choose('implement'); await started.promise; const pgid = fake.runs[0]!.native.pgid;
  const input = { schema: 'finish-outside-v1', clientRequestId: 'outside_running', generation: (await app.conversations.view('conversation')).conversation.generation, reason: 'I completed the remaining changes in my editor.' };
  const response = await request('/api/conversations/conversation/finish-outside', 'POST', input); expect(response.status).toBe(200); const finished = ConversationPublicSchema.parse(await response.json());
  expect(finished.finishes[0], JSON.stringify(finished.finishes)).toMatchObject({ status: 'completed', retained: policy === 'main' }); expect(groupAlive(pgid)).toBe(false);
  expect(finished.conversation).toMatchObject({ state: 'done', work: null, outcome: { kind: 'finished-elsewhere', reason: input.reason } }); expect(finished.closedWorks[0]).toMatchObject({ id: opened.conversation.work!.id, request: opened.conversation.work!.request, closedAs: 'closed-by-you' });
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(origin, 'rev-parse', 'main')).toBe(initial); if (policy === 'external') expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  expect((await app.conversations.ownership.current(project))?.held).toBe(policy === 'main'); expect(fake.starts).toHaveLength(1);
  const head = git(path, 'rev-parse', 'HEAD'); await restartApplication(); expect((await app.conversations.view('conversation')).conversation.outcome).toEqual(finished.conversation.outcome); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('an outside finish blocked during ownership release can retry after restart without launching another step', async () => {
  await create(); fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await choose('implement'); await app.conversations.wait('conversation');
  const input = { schema: 'finish-outside-v1', clientRequestId: 'outside_retry', generation: (await app.conversations.view('conversation')).conversation.generation, reason: 'Finished manually.' };
  const release = vi.spyOn(app.conversations.ownership, 'release').mockRejectedValueOnce(new Error('Simulated ownership interruption'));
  const response = await request('/api/conversations/conversation/finish-outside', 'POST', input); expect(response.status).toBe(200); release.mockRestore();
  const blocked = (await app.conversations.view('conversation')); expect(blocked.finishes[0]).toMatchObject({ status: 'blocked' }); expect(blocked.conversation.outcome).toBeUndefined(); expect(blocked.conversation.work).not.toBeNull();
  expect((await request('/api/conversations/conversation/messages', 'POST', { schema: 'conversation-message-v1', clientMessageId: 'intervening', text: 'Do not lose this request' })).status).toBe(409);
  await restartApplication(); expect((await app.conversations.view('conversation')).finishes[0]?.status).toBe('blocked');
  expect((await request('/api/conversations/conversation/finish-outside', 'POST', input)).status).toBe(200); expect((await app.conversations.view('conversation')).finishes[0]).toMatchObject({ status: 'completed', retained: false }); expect(fake.starts).toHaveLength(1);
}, 60_000);

test.each(['publish', 'discard'] as const)('restart completes a durable outside intent and keeps its outcome through %s settlement', async (choice) => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const view = (await app.conversations.view('conversation')); const head = git(path, 'rev-parse', 'HEAD');
  new ConversationWork(app.conversations.ledger('conversation')).requestFinishOutside({ schema: 'finish-outside-v1', clientRequestId: 'outside_recovery', generation: view.conversation.generation, reason: 'Completed after leaving Jevellan.' });
  await restartApplication(); const recovered = (await app.conversations.view('conversation')); expect(recovered.finishes[0]).toMatchObject({ status: 'completed', retained: true }); expect(recovered.conversation).toMatchObject({ work: null, outcome: { kind: 'finished-elsewhere' } });
  expect(await app.conversations.ownership.current(project)).toMatchObject({ held: true, workId: view.conversation.work!.id }); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(fake.starts).toHaveLength(1);
  await settle(choice); expect(git(path, 'rev-parse', 'HEAD')).toBe(choice === 'publish' ? head : initial); expect((await app.conversations.view('conversation')).conversation.outcome).toEqual(recovered.conversation.outcome);
}, 60_000);

test('undo after a recorded outside outcome reopens the work, clears its current outcome and can close again', async () => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); await choose('done'); await app.conversations.wait('conversation');
  const input = { schema: 'finish-outside-v1', clientRequestId: 'outside_closed', generation: (await app.conversations.view('conversation')).conversation.generation, reason: 'Finished the last details elsewhere.' };
  expect((await request('/api/conversations/conversation/finish-outside', 'POST', input)).status).toBe(200);
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  const reopened = (await app.conversations.view('conversation')); expect(reopened.redos.at(-1)?.status).toBe('completed'); expect(reopened.conversation.work).not.toBeNull(); expect(reopened.conversation.outcome).toBeUndefined(); expect(reopened.finishes[0]?.request.reason).toBe(input.reason);
  await settle('keep', 'close_after_outside_undo'); expect((await app.conversations.view('conversation')).conversation.work).toBeNull();
}, 90_000);


test('file evidence HTTP reads recorded steps and current files without changing history or launching work', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const firstHead = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; }); await choose('implement'); await app.conversations.wait('conversation');
  writeFileSync(join(path, 'value.txt'), '4\n'); writeFileSync(join(path, 'new file.txt'), 'Unsaved evidence');
  const refs = git(path, 'show-ref'); const status = git(path, 'status', '--porcelain=v1'); const generation = (await app.conversations.view('conversation')).conversation.generation;
  const route = '/api/conversations/conversation/file?ref=value.txt%3A1&stretch=1';
  expect((await fetch(base + route)).status).toBe(401);
  const original = await request(route); expect(original.status).toBe(200); expect(ConversationFileSchema.parse(await original.json())).toMatchObject({ path: 'value.txt', content: '2\n', source: 'checkpoint', commit: firstHead, line: 1 });
  const current = await request(route + '&source=working-tree'); expect(current.status).toBe(200); expect(ConversationFileSchema.parse(await current.json())).toMatchObject({ content: '4\n', source: 'working-tree' });
  const next = await request('/api/conversations/conversation/file?ref=value.txt&stretch=2'); expect(ConversationFileSchema.parse(await next.json())).toMatchObject({ content: '3\n', source: 'checkpoint' });
  const changes = ConversationChangesSchema.parse(await (await request('/api/conversations/conversation/changes/1')).json()); expect(changes.files).toEqual(expect.arrayContaining([{ path: 'value.txt', source: 'step' }, { path: 'value.txt', source: 'working-tree' }, { path: 'new file.txt', source: 'working-tree' }]));
  expect((await request('/api/conversations/conversation/file?ref=../outside.txt&stretch=1')).status).toBe(403); expect((await request('/api/conversations/conversation/file?ref=value.txt&stretch=99')).status).toBe(404);
  expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain=v1')).toBe(status); expect((await app.conversations.view('conversation')).conversation.generation).toBe(generation); expect(fake.starts).toHaveLength(2);
}, 60_000);

test('external project file evidence labels current contents without implying a saved checkpoint', async () => {
  await changeProject({ branchPolicy: 'external' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  const refs = git(path, 'show-ref'); const response = await request('/api/conversations/conversation/file?ref=value.txt&stretch=1'); expect(response.status).toBe(200);
  const file = ConversationFileSchema.parse(await response.json()); expect(file).toMatchObject({ content: '2\n', source: 'working-tree' }); expect(file.commit).toBeUndefined(); expect(git(path, 'show-ref')).toBe(refs); expect(fake.starts).toHaveLength(1);
}, 60_000);

test('new work takes its allowance from current shared settings while existing history keeps its recorded allowance', async () => {
  const revision = await app.state.configuration.current(); revision.configuration['x-jevellan'].guards.maxStretchesPerWork = 5;
  await app.state.configuration.put({ schema: 'config-write-v1', revision: revision.revision, configuration: revision.configuration });
  expect((await create()).conversation.work?.allowance.stretches).toBe(5); await app.conversations.cancel('conversation');
  const changed = await app.state.configuration.current(); changed.configuration['x-jevellan'].guards.maxStretchesPerWork = 3;
  await app.state.configuration.put({ schema: 'config-write-v1', revision: changed.revision, configuration: changed.configuration });
  const next = await app.conversations.message('conversation', { schema: 'conversation-message-v1', clientMessageId: 'second_request', text: 'Explain the next thing.', kind: 'message' });
  expect(next.conversation.work?.allowance.stretches).toBe(3);
  expect(new ConversationWork(app.conversations.ledger('conversation')).load().closedWorks[0]?.allowance.stretches).toBe(5);
});

test('concurrent retries of one composer choice preserve one correction when a shared read is delayed', async () => {
  const first = await create(); const entered = deferred(); const release = deferred(); const projects = app.conversations.options.projects; const get = projects.get.bind(projects);
  vi.spyOn(projects, 'get').mockImplementationOnce(async id => { entered.resolve(); await release.promise; return get(id); });
  const input = { schema: 'composer-choice-v1', clientRequestId: 'same_choice', generation: first.conversation.generation, field: 'effort', mode: 'once', value: 'high' };
  const pending = app.conversations.composerChoice('conversation', input);
  try { await entered.promise; await app.conversations.composerChoice('conversation', input); } finally { release.resolve(); }
  const saved = await pending; expect(saved.composerOverrides.filter(entry => entry.request.clientRequestId === input.clientRequestId)).toHaveLength(1);
  expect(saved.conversation.generation).toBe(first.conversation.generation + 1); expect(fake.starts).toHaveLength(0);
});

test('unavailable settings reject new work before creating durable conversation history', async () => {
  const settings = vi.spyOn(app.conversations.options, 'settings').mockRejectedValue(Object.assign(new Error('Fixture hub unavailable.'), { status: 503 }));
  await expect(app.conversations.create({ schema: 'start-conversation-v1', id: 'unavailable', projectId: project.id, title: 'Unavailable', message: 'New work.', clientMessageId: 'new_request' })).rejects.toMatchObject({ status: 503 });
  settings.mockRestore(); expect(existsSync(homes.at('conversations', 'unavailable'))).toBe(false); expect(fake.starts).toHaveLength(0);
});

test('a manual choice delayed on shared settings cannot launch after cancellation', async () => {
  const first = await create(); const entered = deferred(); const release = deferred(); const settings = app.conversations.options.settings.bind(app.conversations.options);
  vi.spyOn(app.conversations.options, 'settings').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return settings(); });
  const pending = app.conversations.manual('conversation', { schema: 'manual-step-v1', generation: first.conversation.generation, action: 'reply', modelId: 'fixture-model', effort: 'high' });
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
  try { await entered.promise; await app.conversations.cancel('conversation'); } finally { release.resolve(); }
  await rejected; expect(fake.starts).toHaveLength(0); expect((await app.conversations.view('conversation')).conversation.state).toBe('cancelled');
});

test('a settings outage cannot stop a running runtime from recording its stream and handoff', async () => {
  await create(); const entered = deferred(); const release = deferred();
  fake.enqueue(async ({ input, emit }) => { entered.resolve(); await release.promise; emit({ type: 'text', delta: 'Continued through a settings outage.' }); await handoff(input); return { status: 'completed' }; });
  await choose('reply'); await entered.promise;
  const settings = vi.spyOn(app.conversations.options, 'settings').mockRejectedValue(Object.assign(new Error('Fixture hub unavailable.'), { status: 503 }));
  release.resolve(); try { await app.conversations.wait('conversation'); } finally { settings.mockRestore(); }
  const ledger = app.conversations.ledger('conversation'); const saved = new ConversationWork(ledger).load();
  expect(saved.stretches[0]?.status).toBe('completed'); expect(saved.handoffs).toHaveLength(1); expect(saved.conversation.state).toBe('blocked'); expect(fake.starts).toHaveLength(1);
  expect(JSON.stringify(ledger.events().map(event => ledger.data(event)))).toContain('Continued through a settings outage.');
}, 60_000);

function outsideMutationActivity() {
  const directory = join(homes.userHome, '.claude', 'projects', 'synthetic'); mkdirSync(directory, { recursive: true }); const journal = join(directory, 'outside.jsonl');
  writeFileSync(journal, JSON.stringify({ type: 'user', cwd: path }) + '\n'); return journal;
}
function quietMutationActivity(journal: string) { const old = new Date(Date.now() - 600_000); utimesSync(journal, old, old); }

test.each([false, true])('outside activity blocks unpublished/published undo before checkout mutation: %s', async published => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  if (published) { await choose('done'); await app.conversations.wait('conversation'); }
  const head = git(path, 'rev-parse', 'HEAD'); const remote = git(origin, 'rev-parse', 'main'); const journal = outsideMutationActivity();
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; });
  await correct(1, 'redo', { action: 'reply' }); await app.conversations.wait('conversation');
  expect((await app.conversations.view('conversation')).redos.at(-1)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Another agent') });
  expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(git(origin, 'rev-parse', 'main')).toBe(remote); expect(fake.starts).toHaveLength(1);
  quietMutationActivity(journal); await retryRedo('outside_undo_retry'); const retried = (await app.conversations.view('conversation')).redos.at(-1)!; expect(retried.status, retried.reason).toBe('completed'); expect(fake.starts).toHaveLength(2); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n');
}, 90_000);

test('outside activity blocks discarding checkpoints and a fresh quiet choice can discard them', async () => {
  await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation'); const head = git(path, 'rev-parse', 'HEAD'); const journal = outsideMutationActivity();
  await settle('discard', 'outside_discard'); expect((await app.conversations.view('conversation')).settlements.at(-1)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Another agent') }); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
  quietMutationActivity(journal); await settle('discard', 'quiet_discard'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n');
}, 90_000);

test('outside activity during queued memory preserves partial notes and requires review before their checkpoint', async () => {
  await create(); let journal = ''; const projectMemory = app.memory.project.bind(app.memory);
  vi.spyOn(app.memory, 'project').mockImplementation((...args) => {
    const memory = projectMemory(...args); const write = memory.write.bind(memory);
    vi.spyOn(memory, 'write').mockImplementation(async (...input) => {
      const note = await write(...input);
      if (!journal) { journal = outsideMutationActivity(); writeFileSync(join(path, 'outside.txt'), 'Outside contribution.\n'); }
      return note;
    }); return memory;
  });
  fake.enqueue(async ({ input }) => { await handoff(input, { findings: [{ claim: 'memory: Keep useful work', pointer: 'value.txt' }] }); return { status: 'completed' }; });
  await choose('reply'); await app.conversations.wait('conversation'); const blocked = await app.conversations.view('conversation');
  expect(blocked.checkpointBlocks).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(git(path, 'status', '--porcelain')).toContain('outside.txt'); expect(blocked.stretches[0]?.status).toBe('completed'); quietMutationActivity(journal);
  await restartApplication(); expect((await app.conversations.view('conversation')).checkpointBlocks).toHaveLength(1);
  const review = await adoptionReview('memory_overlap_accept'); expect(review.changes.uncommitted).toContain('Outside contribution.'); await acceptFiles(review.input);
  expect((await app.conversations.view('conversation')).checkpointBlocks).toHaveLength(0); expect(fake.starts).toHaveLength(1);
  const memoryReceipt = app.conversations.ledger('conversation').events().filter(event => event.type === 'git').map(event => app.conversations.ledger('conversation').data(event)).find(value => typeof value === 'object' && value !== null && 'schema' in value && value.schema === 'memory-applied-v1');
  expect(memoryReceipt).toMatchObject({ notes: [{ outcome: 'existing' }] });
}, 90_000);

test('outside activity on an external-policy project requires acknowledgement and never changes Git', async () => {
  await changeProject({ branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, testCommand: 'test -f value.txt' });
  await create(); const refs = git(path, 'show-ref'); let journal = '';
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); journal = outsideMutationActivity(); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await app.conversations.wait('conversation'); const blocked = await app.conversations.view('conversation');
  expect(blocked.checkpointBlocks).toHaveLength(1); expect(blocked.pause?.reason).toContain('acknowledge'); quietMutationActivity(journal);
  await restartApplication(); const review = await adoptionReview('external_acknowledgement'); expect(review.changes.recovery?.mode).toBe('acknowledge'); expect(review.changes.uncommitted).toContain('+2');
  await acceptFiles(review.input); expect((await app.conversations.view('conversation')).checkpointBlocks).toHaveLength(0); expect(git(path, 'show-ref')).toBe(refs); expect(git(path, 'status', '--porcelain')).toContain('M value.txt');
  // The blocked step never answered the request; a completed reply must answer it before Done is available.
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await choose('reply'); await app.conversations.wait('conversation');
  await choose('done'); await app.conversations.wait('conversation'); expect((await app.conversations.view('conversation')).conversation.state).toBe('done'); expect(git(path, 'show-ref')).toBe(refs); expect(fake.starts.map((step) => step.action)).toEqual(['implement', 'reply']);
}, 90_000);

test.each(['implement', 'done', 'discard'] as const)('an unrecorded outside commit blocks %s and preserves the complete checkout', async action => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  writeFileSync(join(path, 'outside.txt'), 'Keep this outside commit.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside work');
  const before = git(path, 'rev-parse', 'HEAD'); const refs = git(path, 'show-ref');
  if (action === 'implement') fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; });
  if (action === 'discard') await settle('discard', 'outside_history_discard'); else { await choose(action); await app.conversations.wait('conversation'); }
  expect(git(path, 'rev-parse', 'HEAD')).toBe(before); expect(git(path, 'show-ref')).toBe(refs); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Keep this outside commit.\n'); expect(fake.starts).toHaveLength(1);
  const view = await app.conversations.view('conversation'); expect(action === 'discard' ? view.settlements.at(-1)?.reason : view.pause?.reason).toMatch(/Git history|unrecorded/);
}, 90_000);

test.each([false, true])('an outside commit introduced during publication coordination preserves ordinary/reverted work: %s', async reverted => {
  await changeProject({ testCommand: 'test -f value.txt' }); await create(); fake.enqueue(implement); await choose('implement'); await app.conversations.wait('conversation');
  if (reverted) { await choose('done'); await app.conversations.wait('conversation'); }
  const remote = git(origin, 'rev-parse', 'main'); const assertLease = app.conversations.leases.assert.bind(app.conversations.leases); let outside = '';
  vi.spyOn(app.conversations.leases, 'assert').mockImplementationOnce(async lease => {
    await assertLease(lease); writeFileSync(join(path, 'outside.txt'), 'Outside during publication.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside during publication'); outside = git(path, 'rev-parse', 'HEAD');
  });
  if (reverted) { fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await correct(1, 'redo', { action: 'reply' }); }
  else await choose('done');
  await app.conversations.wait('conversation'); const view = await app.conversations.view('conversation');
  expect(outside).not.toBe(''); expect(git(path, 'rev-parse', 'HEAD')).toBe(outside); expect(git(origin, 'rev-parse', 'main')).toBe(remote); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Outside during publication.\n'); expect(fake.starts).toHaveLength(1);
  expect(reverted ? view.redos.at(-1)?.reason : view.pause?.reason).toContain('Git history changed');
}, 90_000);
