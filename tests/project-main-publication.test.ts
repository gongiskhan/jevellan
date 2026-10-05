// Phase 6 main isolation (brief 8.2 step 4 main, 8.4 main, 9.4, 9.6, 10, 13 PJ6; design 3.6; D29, D44, D45, D64, D65, D288-D292): threads that
// work directly on main claim the device checkout, publish under the publication lease with a fetch and rebase, hand a conflict back to the
// agent with the exact prompt, and give the checkout back. Simulated: the runtime turns (FakeRuntime through the real bridge) and GitHub.
// Live: git on a bare origin behind a GitHub-shaped remote, HTTP, the hub, the ledgers, checkout ownership and publication leases.
import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CheckoutClaimSchema, ConversationPublicSchema, ProjectSchema, ThreadCreatedViewSchema, ThreadOverrideViewSchema, readDocument, writeDocument, type CoordinatorEvent, type ProjectLedgerData,
  type ProjectLedgerEvent, type ProjectLedgerEventType, type ThreadIndex,
} from '../packages/core/dist/index.js';
import { HubProjectAccess, HubProjectStore, HubProtocolError, HubPublicationLeases, MemberProjectStore } from '../packages/mesh/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import {
  MAIN_LEASE_BUSY, MAIN_LEASE_RETRIES, commitsSavedReason, leftoverCommitSubject, mainCheckoutMessage, mainConflictPrompt, savedCommitsRef, threadSystemAppend,
} from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, never, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(options: ProjectFixtureOptions = {}): Promise<ProjectFixture> { fixture = await projectFixture(options); return fixture; }

const createBody = (title: string, task: string, extra: object = { isolation: 'main' }) => ({ schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task, ...extra });
const start = (f: ProjectFixture, title: string, task: string, extra?: object) => f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', createBody(title, task, extra));
const message = (f: ProjectFixture, threadId: string, text: string) =>
  f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text, interrupt: false });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function payloads<T extends ProjectLedgerEventType>(f: ProjectFixture, threadId: string, type: T): ProjectLedgerData<T>[] {
  const ledger = f.app.projectWork.ledgers.thread(f.project.id, threadId);
  return ledger.events().filter((event) => event.type === type).map((event) => ledger.payload(event as ProjectLedgerEvent & { type: T }));
}
const events = (f: ProjectFixture, threadId: string): CoordinatorEvent[] => f.coordinatorState().queue.filter((event) => 'threadId' in event && event.threadId === threadId);
/** Commits `files` from a second clone and pushes them to origin main (another device's publication). */
function pushUpstream(f: ProjectFixture, files: Record<string, string>, subject = 'Upstream'): string {
  const second = join(f.root, `upstream-${randomUUID().slice(0, 8)}`); f.git(f.root, 'clone', f.origin, second);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(second, name), content);
  f.git(second, 'add', '-A'); f.git(second, 'commit', '-m', subject); f.git(second, 'push', 'origin', 'main');
  return f.git(second, 'rev-parse', 'HEAD');
}
const origin = (f: ProjectFixture) => f.git(f.origin, 'rev-parse', 'refs/heads/main');
const claim = (f: ProjectFixture) => f.app.conversations.ownership.current(f.project);
const conversationOwner = { conversationId: 'conv_other', conversationTitle: 'Other work', workId: 'work_other' };
const settled = (state: string) => (thread: { state: string }) => thread.state === state;

test('a main thread claims the checkout, works on main, publishes to main and gives the checkout back; a conversation and a second main thread are kept off it meanwhile (brief 8.2, 8.4, 9.4, 10)', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  const base = origin(f); const hold = deferred();
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }, async (turn) => {
    // The agent may also leave a file uncommitted: publication commits it with the thread's subject.
    writeFileSync(join(turn.input.cwd, 'notes.md'), 'left over\n'); await hold.promise;
  }), forThread());
  const created = await start(f, 'Add greeting', 'Create greeting.txt.');
  expect(created).toMatchObject({ state: 'preparing', placement: `Scripted test runtime Fixture · high · Main · ${f.deviceName} · placed without Jev: no key configured` });
  const threadId = created.threadId;
  await f.waitFor(() => f.fake.turnStarts.length, (count) => count === 1);
  await f.waitFor(() => existsSync(join(f.checkout, 'notes.md')));

  // The thread works in the project checkout on main, with the main parts of the system append and the mail and reservation tools.
  const input = f.fake.turnStarts[0]!;
  expect(input.cwd).toBe(f.checkout);
  expect(input.prompt).toBe('Task: Add greeting\n\nCreate greeting.txt.');
  expect(input.systemAppend).toBe(threadSystemAppend({ projectName: 'Shop', cwd: f.checkout, isolation: 'main', baseBranch: 'main', deviceName: f.deviceName, testCommand: 'test -f greeting.txt' }));
  expect(input.systemAppend).toContain(`Isolation: you work directly on main in the project checkout of ${f.deviceName}. Other main threads may work on other devices at the same time.`);
  expect(f.thread(threadId)).toMatchObject({ state: 'running', isolation: 'main', cwd: f.checkout, baseBranch: 'main', baseCommit: base });
  expect(f.thread(threadId).branch).toBeUndefined();

  // The claim names the thread; the hub reports the checkout as held for every device.
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId, conversationTitle: 'Add greeting', workId: threadId, pid: process.pid, path: f.checkout });
  expect(await f.app.projectHub.heldCheckouts('project')).toEqual([{ deviceId: f.app.device.deviceId, ownerId: threadId, title: 'Add greeting' }]);
  // A conversation on the same checkout is refused with the thread's title, through the conversation service itself.
  const refusal = `Shop on ${f.deviceName} is in use by "Add greeting".`;
  await expect(f.app.conversations.ownership.acquire(f.project, conversationOwner)).rejects.toThrow(refusal);
  const conversation = await f.request('/api/conversations', 'POST', { schema: 'start-conversation-v1', id: 'conv_blocked', projectId: 'project', title: 'Chat', message: 'Change value.txt.',
    clientMessageId: 'first_conv' });
  expect(conversation.status).toBe(201);
  const opened = ConversationPublicSchema.parse(await conversation.json());
  const chosen = await f.request('/api/conversations/conv_blocked/manual', 'POST', { schema: 'manual-step-v1', generation: opened.conversation.generation, action: 'implement',
    modelId: 'fixture', effort: 'high' });
  expect(chosen.status).toBe(202);
  await f.app.conversations.wait('conv_blocked');
  expect((await f.app.conversations.view('conv_blocked')).pause?.reason).toContain(refusal);
  // A second main thread is not placed on this device.
  const second = await f.request('/api/projects/project/threads', 'POST', createBody('Second', 'Also on main.'));
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: `No device can run any enabled model: ${f.deviceName}: main checkout busy: Add greeting.` });

  // Done: leftovers are committed, the exact head is verified, then pushed to main; the thread is done and the checkout free again.
  hold.resolve();
  const done = await f.waitFor(() => f.thread(threadId), settled('done'));
  const head = f.git(f.checkout, 'rev-parse', 'HEAD');
  expect(done).toMatchObject({ publishedCommit: head, verificationAttempts: 0 }); expect(done.stateReason).toBeUndefined();
  expect(origin(f)).toBe(head);
  expect(f.git(f.checkout, 'log', '--format=%s', `${base}..HEAD`).split('\n')).toEqual([leftoverCommitSubject('Add greeting', 'Added greeting.txt.'), 'Work']);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe(''); expect(f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  expect(payloads(f, threadId, 'thread-verification')).toEqual([expect.objectContaining({ attempt: 1, status: 'passed', command: 'test -f greeting.txt', commit: head })]);
  expect(payloads(f, threadId, 'thread-publication')).toEqual([{ schema: 'thread-publication-v1', result: 'main-published', commit: head }]);
  expect(events(f, threadId).filter((event) => event.kind === 'thread-published')).toEqual([expect.objectContaining({ result: 'main-published', commit: head })]);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(await f.app.projectHub.heldCheckouts('project')).toEqual([]);
  await f.app.conversations.ownership.acquire(f.project, conversationOwner);
  await f.app.conversations.ownership.release(f.project, conversationOwner, { processesGone: true, commits: 'unchanged' });
});

test('a rebase conflict is aborted and the agent gets the exact main-conflict prompt; its resolution publishes (brief 8.4 main, 9.6)', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'grep -q thread value.txt' });
  const pushed = deferred(); let during: { state: string; rebasing: boolean; head: string } | undefined;
  f.fake.enqueueTurn(commitStep({ 'value.txt': 'thread\n' }, { status: 'done', summary: 'Changed the value.' }, () => pushed.promise), forThread((turn) => turn.turn === 1));
  f.fake.enqueueTurn(async (turn) => {
    const cwd = turn.input.cwd;
    during = { state: f.thread(turn.input.owner.id).state, rebasing: existsSync(join(cwd, '.git', 'rebase-merge')), head: f.git(cwd, 'rev-parse', 'HEAD') };
    f.git(cwd, 'fetch', 'origin', 'main');
    try { f.git(cwd, 'rebase', 'origin/main'); } catch { /* the conflict the prompt announced */ }
    writeFileSync(join(cwd, 'value.txt'), 'upstream\nthread\n'); f.git(cwd, 'add', 'value.txt'); f.git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Kept both values.' });
    return { status: 'completed' };
  }, forThread((turn) => turn.turn === 2));
  const { threadId } = await start(f, 'Change value', 'Set value.txt to thread.');
  await f.waitFor(() => f.git(f.checkout, 'log', '-1', '--format=%s'), (subject) => subject === 'Work');
  const committed = f.git(f.checkout, 'rev-parse', 'HEAD');
  const upstream = pushUpstream(f, { 'value.txt': 'upstream\n' });
  pushed.resolve();

  const done = await f.waitFor(() => f.thread(threadId), settled('done'));
  // The second turn's prompt is the brief's text with the conflicting file, word for word; the rebase was aborted before it.
  expect(f.fake.turnStarts[1]!.prompt).toBe('Main moved while you worked and your commits conflict with it in: value.txt. Run git fetch origin main and git rebase origin/main, resolve the conflicts keeping both intents, run the tests, and report done again.');
  expect(f.fake.turnStarts[1]!.prompt).toBe(mainConflictPrompt(['value.txt']));
  expect(during).toEqual({ state: 'running', rebasing: false, head: committed });
  expect(payloads(f, threadId, 'thread-publication')).toEqual([{ schema: 'thread-publication-v1', result: 'conflict', files: ['value.txt'] },
    { schema: 'thread-publication-v1', result: 'main-published', commit: done.publishedCommit }]);
  // The resolution sits on top of the other publication, and both intents reached main.
  expect(origin(f)).toBe(done.publishedCommit);
  expect(f.git(f.checkout, 'rev-parse', `${done.publishedCommit}^`)).toBe(upstream);
  expect(f.git(f.origin, 'show', 'main:value.txt')).toBe('upstream\nthread');
  expect(payloads(f, threadId, 'thread-verification').map((receipt) => [receipt.status, receipt.commit])).toEqual([['passed', committed], ['passed', done.publishedCommit]]);
  expect(await claim(f)).toMatchObject({ held: false });
});

test('upstream commits that do not conflict are rebased onto and the rebased head is verified again before the push (brief 8.4 main step 3)', { timeout: 120_000 }, async () => {
  const f = await setup({ testCommand: 'test -f greeting.txt' });
  const pushed = deferred();
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }, () => pushed.promise), forThread());
  const { threadId } = await start(f, 'Add greeting', 'Create greeting.txt.');
  await f.waitFor(() => f.git(f.checkout, 'log', '-1', '--format=%s'), (subject) => subject === 'Work');
  const committed = f.git(f.checkout, 'rev-parse', 'HEAD');
  const upstream = pushUpstream(f, { 'upstream.txt': 'upstream\n' });
  pushed.resolve();
  const done = await f.waitFor(() => f.thread(threadId), settled('done'));
  const published = done.publishedCommit!;
  expect(published).not.toBe(committed); expect(origin(f)).toBe(published);
  expect(f.git(f.checkout, 'rev-parse', `${published}^`)).toBe(upstream);
  // Two receipts: the agent's head, then the rebased head that was pushed.
  expect(payloads(f, threadId, 'thread-verification').map((receipt) => [receipt.attempt, receipt.status, receipt.commit])).toEqual([[1, 'passed', committed], [1, 'passed', published]]);
  expect(payloads(f, threadId, 'thread-publication')).toEqual([{ schema: 'thread-publication-v1', result: 'main-published', commit: published }]);
});

test('a busy publication lease is tried again three times, then the thread rests with the reason; a message tries again (D45)', { timeout: 120_000 }, async () => {
  const f = await setup({ projectTimers: { mainLeaseRetryMs: 40 } });
  // Another device publishes to the same origin: the lease key is the remote git resolves (the GitHub URL is redirected to the bare origin).
  const other = new HubPublicationLeases(f.app.hub, 'dev_other'); const held = await other.acquire(`file:${f.origin}`, 'work_other');
  const leases = f.app.conversations.leases; const acquire = leases.acquire.bind(leases); const tries: number[] = [];
  leases.acquire = async (remote, owner) => { tries.push(Date.now()); return acquire(remote, owner); };
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  const { threadId } = await start(f, 'Add greeting', 'Create greeting.txt.');
  const rested = await f.waitFor(() => f.thread(threadId), settled('idle'));
  expect(rested.stateReason).toBe(MAIN_LEASE_BUSY);
  expect(rested.stateReason).toBe('Another publication to main is in progress. Send a message to try again.');
  // One try and three more, each after the wait.
  expect(tries).toHaveLength(1 + MAIN_LEASE_RETRIES); expect(MAIN_LEASE_RETRIES).toBe(3);
  for (let n = 1; n < tries.length; n += 1) expect(tries[n]! - tries[n - 1]!).toBeGreaterThanOrEqual(35);
  expect(origin(f)).not.toBe(f.git(f.checkout, 'rev-parse', 'HEAD'));
  // The coordinator hears why; the thread keeps the checkout while it rests.
  expect(events(f, threadId).filter((event) => event.kind === 'thread-report').at(-1)).toMatchObject({ report: { status: 'blocked', summary: MAIN_LEASE_BUSY, synthesized: true } });
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });

  await other.release(held);
  f.fake.enqueueTurn(reportStep({ status: 'done', summary: 'Ready again.' }), forThread());
  expect((await message(f, threadId, 'Publish again.')).status).toBe(202);
  const done = await f.waitFor(() => f.thread(threadId), settled('done'));
  expect(origin(f)).toBe(done.publishedCommit); expect(tries).toHaveLength(5);
  expect(await claim(f)).toMatchObject({ held: false });
});

test('a stopped main thread saves its unpublished commits, returns the checkout to main, releases the checkout and its reservations (D29)', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(holdStep(never(), async (turn) => {
    await turn.bridge('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' });
    writeFileSync(join(turn.input.cwd, 'work.txt'), 'work\n'); f.git(turn.input.cwd, 'add', '-A'); f.git(turn.input.cwd, 'commit', '-m', 'Work');
    writeFileSync(join(turn.input.cwd, 'draft.txt'), 'draft\n');
  }), forThread());
  const { threadId } = await start(f, 'Draft work', 'Start something.');
  await f.waitFor(() => existsSync(join(f.checkout, 'draft.txt')));
  expect(await f.app.projectHub.reservations('project')).toEqual([expect.objectContaining({ threadId, paths: ['src/'] })]);
  expect((await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' })).status).toBe(202);
  const stopped = await f.waitFor(() => f.thread(threadId), settled('stopped'));
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(stopped.stateReason).toBe(commitsSavedReason('Stopped by you.', ref));
  expect(stopped.stateReason).toBe(`Stopped by you. Its unpublished commits were saved at ${ref}.`);
  // Both the agent's commit and its leftovers are kept at the ref; the checkout is a clean main at its base again.
  expect(f.git(f.checkout, 'log', '--format=%s', `${base}..${ref}`).split('\n')).toEqual([leftoverCommitSubject('Draft work', 'Draft work'), 'Work']);
  expect(f.git(f.checkout, 'show', `${ref}:draft.txt`)).toBe('draft');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('');
  expect(existsSync(join(f.checkout, 'work.txt'))).toBe(false); expect(origin(f)).toBe(base);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(await f.app.projectHub.reservations('project')).toEqual([]);

  // Without commits of its own the stop keeps its reason and changes nothing in git.
  f.fake.enqueueTurn(holdStep(never()), forThread());
  const idle = await start(f, 'Look only', 'Read the code.');
  await f.waitFor(() => f.thread(idle.threadId), settled('running'));
  expect((await f.request(`/api/projects/project/threads/${idle.threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' })).status).toBe(202);
  expect((await f.waitFor(() => f.thread(idle.threadId), settled('stopped'))).stateReason).toBe('Stopped by you.');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base);
  expect(f.git(f.checkout, 'for-each-ref', '--format=%(refname)', `refs/jevellan/discard/${idle.threadId}`)).toBe('');
  expect(await claim(f)).toMatchObject({ held: false, conversationId: idle.threadId });
});

test('Restart of a running main thread with the shown choices starts the new thread on the same checkout once the old one saved its commits and gave it back (brief 10, D29, D292)', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(holdStep(never(), async (turn) => {
    writeFileSync(join(turn.input.cwd, 'work.txt'), 'work\n'); f.git(turn.input.cwd, 'add', '-A'); f.git(turn.input.cwd, 'commit', '-m', 'Work');
  }), forThread());
  const { threadId } = await start(f, 'Restart me', 'Start something.');
  await f.waitFor(() => f.git(f.checkout, 'log', '-1', '--format=%s'), (subject) => subject === 'Work');
  const committed = f.git(f.checkout, 'rev-parse', 'HEAD');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Started again.' }), forThread());
  // The Override dialog sends every shown field for a restart: main, the same model, effort and device.
  const restarted = await f.json(`/api/projects/project/threads/${threadId}/override`, ThreadOverrideViewSchema, 'POST', { schema: 'thread-override-request-v1',
    clientRequestId: 'ovr_main', mode: 'restart', isolation: 'main', modelId: 'fixture', effort: 'high', deviceId: f.app.device.deviceId });
  const newId = restarted.newThreadId!; const ref = `refs/jevellan/discard/${threadId}/1`;
  // The old thread's reason names both the new thread and where its commits went; the checkout is back at its base.
  expect(f.thread(threadId)).toMatchObject({ state: 'stopped', stateReason: `Restarted as ${newId}. Its unpublished commits were saved at ${ref}.` });
  expect(f.git(f.checkout, 'rev-parse', ref)).toBe(committed);
  const fresh = await f.waitFor(() => f.thread(newId), (thread) => thread.state === 'idle' && thread.turns === 1);
  expect(fresh).toMatchObject({ isolation: 'main', cwd: f.checkout, baseCommit: base, ownerDeviceId: f.app.device.deviceId });
  expect(fresh.placement).toMatchObject({ isolation: 'main', fixed: ['isolation', 'model', 'effort', 'device'] });
  expect(await claim(f)).toMatchObject({ held: true, conversationId: newId });
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base);
});

test('after a restart the next turn claims the checkout for the new process without preparing main again; a dirty checkout refuses preparation in thread words (D44, D67)', { timeout: 120_000 }, async () => {
  const f = await setup();
  f.fake.enqueueTurn(commitStep({ 'first.txt': '1\n' }, { status: 'progress', summary: 'First part.' }), forThread());
  const { threadId } = await start(f, 'Two parts', 'Do it in two turns.');
  const first = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  await f.restart();
  // The old daemon's process is gone: its pid stays on the claim, which `assert` refuses for this process.
  const dead = spawnSync('true').pid!;
  const key = createHash('sha256').update(`${f.app.device.deviceId}\0${f.checkout}`).digest('hex');
  const row = f.app.hub.get('checkout-ownership', key, CheckoutClaimSchema)!;
  f.app.hub.put('checkout-ownership', key, CheckoutClaimSchema, { ...row.document, pid: dead }, row.revision);
  const lock = f.homes.at('locks', `${createHash('sha1').update(f.checkout).digest('hex')}.json`);
  writeDocument(lock, CheckoutClaimSchema, { ...readDocument(lock, CheckoutClaimSchema), pid: dead });
  f.fake.enqueueTurn(commitStep({ 'second.txt': '2\n' }, { status: 'done', summary: 'Both parts.' }), forThread());
  expect((await message(f, threadId, 'Do the second part.')).status).toBe(202);
  const done = await f.waitFor(() => f.thread(threadId), settled('done'));
  expect(done.baseCommit).toBe(first.baseCommit); expect(origin(f)).toBe(done.publishedCommit);
  expect(f.git(f.origin, 'log', '--format=%s', `${first.baseCommit}..main`).split('\n')).toEqual(['Work', 'Work']);
  expect(await claim(f)).toMatchObject({ held: false, pid: process.pid });

  // Changes in the checkout that no thread made: the thread fails with the reason in thread words and the claim is given back.
  writeFileSync(join(f.checkout, 'stray.txt'), 'stray\n');
  const dirty = await start(f, 'Dirty start', 'Try on a dirty checkout.');
  const failed = await f.waitFor(() => f.thread(dirty.threadId), settled('failed'));
  expect(failed.stateReason).toBe(`Shop on ${f.deviceName} has changes that don't belong to this thread. Commit, stash or publish them, then start the thread again.`);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: dirty.threadId });
  expect(readFileSync(join(f.checkout, 'stray.txt'), 'utf8')).toBe('stray\n');
});

test('the hub derives held checkouts for any device from claims and main thread indexes; members check the reply (D65, D288)', { timeout: 60_000 }, async () => {
  const f = await setup();
  const hubId = f.app.device.deviceId; const at = new Date().toISOString();
  const stored = (await f.app.state.projects.get('project'))!;
  f.app.hub.put('projects', 'project', ProjectSchema, { ...stored.project, paths: { ...stored.project.paths, dev_b: '/srv/shop', dev_c: '/srv/c', dev_e: '/srv/e' } }, stored.revision);
  const put = (deviceId: string, path: string, owner: string, title: string, held = true) => {
    const id = createHash('sha256').update(`${deviceId}\0${path}`).digest('hex');
    f.app.hub.put('checkout-ownership', id, CheckoutClaimSchema, { schema: 'checkout-claim-v1', deviceId, path, held, conversationId: owner, conversationTitle: title, workId: owner, pid: 4242, updatedAt: at }, 0);
  };
  const index = (id: string, owner: string, fields: Partial<ThreadIndex>): ThreadIndex => ({ schema: 'project-thread-index-v1', revision: 0, id, projectId: 'project', title: `${id} title`,
    state: 'running', isolation: 'main', ownerDeviceId: owner, runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 1, createdAt: at, updatedAt: at, ...fields });
  // The hub's checkout by its stored path; dev_b's claim at a resolved path is a thread of this project; dev_c has a main thread whose claim is
  // not there yet and a claim of other work at another path; dev_d has no path in the project; dev_e has only ended or worktree threads.
  put(hubId, f.checkout, 'conv_a', 'Chat A');
  put('dev_b', '/private/srv/shop', 'thread_b', 'thread_b title'); put('dev_b', '/srv/old', 'thread_old', 'Old', false);
  put('dev_c', '/elsewhere', 'conv_other', 'Elsewhere'); put('dev_d', '/srv/d', 'conv_d', 'No path here');
  await new HubProjectAccess(f.app.hub, 'dev_b').publishThread(index('thread_b', 'dev_b', {}), 1);
  await new HubProjectAccess(f.app.hub, 'dev_c').publishThread(index('thread_c', 'dev_c', { state: 'queued', createdAt: '2026-01-02T00:00:00.000Z' }), 1);
  await new HubProjectAccess(f.app.hub, 'dev_c').publishThread(index('thread_c2', 'dev_c', { state: 'idle', createdAt: '2026-01-03T00:00:00.000Z' }), 1);
  await new HubProjectAccess(f.app.hub, 'dev_e').publishThread(index('thread_e1', 'dev_e', { state: 'done' }), 1);
  await new HubProjectAccess(f.app.hub, 'dev_e').publishThread(index('thread_e2', 'dev_e', { isolation: 'worktree' }), 1);
  const expected = [{ deviceId: 'dev_b', ownerId: 'thread_b', title: 'thread_b title' }, { deviceId: 'dev_c', ownerId: 'thread_c', title: 'thread_c title' },
    { deviceId: hubId, ownerId: 'conv_a', title: 'Chat A' }].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
  // Any device reads the same answer.
  expect(new HubProjectStore(f.app.hub, 'dev_e').heldCheckouts('project')).toEqual(expected);
  expect(await f.app.projectHub.heldCheckouts('project')).toEqual(expected);
  expect(() => new HubProjectStore(f.app.hub, 'dev_e').heldCheckouts('missing')).toThrow('Project not found.');
  // A member accepts one entry per device in device order only.
  const reply = (records: unknown[]) => new MemberProjectStore({ projects: async () => ({ schema: 'project-hub-result-v1', operation: 'checkouts-held', records }) } as never);
  expect(await reply(expected).heldCheckouts('project')).toEqual(expected);
  await expect(reply([...expected].reverse()).heldCheckouts('project')).rejects.toThrow(HubProtocolError);
  await expect(reply([expected[0], expected[0]]).heldCheckouts('project')).rejects.toThrow(HubProtocolError);
});

test('main checkout copy: the dirty-checkout refusal in thread words, no conversation in any reason, the saved-commits reason within 400 characters (D29, D44)', () => {
  const input = { projectName: 'Shop', deviceId: 'dev_mini', deviceName: 'Mac mini' };
  expect(mainCheckoutMessage("Shop on dev_mini has changes that don't belong to this conversation. Commit, stash or publish them, then press Retry.", input))
    .toBe("Shop on Mac mini has changes that don't belong to this thread. Commit, stash or publish them, then start the thread again.");
  expect(mainCheckoutMessage('This project must be on main before Jevellan can change git.', input)).toBe('This project must be on main before Jevellan can change git.');
  expect(mainCheckoutMessage('Finish this conversation first; other conversations wait.', input)).toBe('Finish this thread first; other threads wait.');
  const ref = 'refs/jevellan/discard/thread_01K6ABCDEFGHJKMNPQRSTVWXYZ0/1';
  expect(commitsSavedReason('Stopped by you.', ref)).toBe(`Stopped by you. Its unpublished commits were saved at ${ref}.`);
  expect(savedCommitsRef(commitsSavedReason('Stopped by you.', ref))).toBe(ref); expect(savedCommitsRef('Stopped by you.')).toBeUndefined();
  const long = commitsSavedReason('x'.repeat(400), ref);
  expect(long.length).toBeLessThanOrEqual(400); expect(long.endsWith(`saved at ${ref}.`)).toBe(true);
});
