// The claimed project checkout of a main thread is the owner's checkout too (brief 8.2 step 4 main, 8.4 main): when the owner switches
// it to a branch of their own, a Stop, a publication and a turn change nothing there and the claim stays; once the owner is back on main,
// the sweep finishes such a Stop only when main is as the Stop saw it and holds nothing new, and otherwise gives the checkout back as it
// is (P8 review N-2); a Stop pressed while the
// publication waits for its lease stops the push; messages that wait during a publication that concludes the thread are reported as not
// delivered. Simulated: the runtime turns (FakeRuntime through the real bridge) and, where a test says so, a held publication lease.
// Live: git on a bare origin, HTTP, the hub, the ledgers and checkout ownership.
import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, expectNoLeaks, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(): Promise<ProjectFixture> { fixture = await projectFixture(); return fixture; }

const start = (f: ProjectFixture, title: string) => f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
  { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: `Do ${title}.`, isolation: 'main' });
const stop = (f: ProjectFixture, threadId: string) => f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' });
const message = (f: ProjectFixture, threadId: string, text: string) => f.request(`/api/projects/project/threads/${threadId}/messages`, 'POST',
  { schema: 'thread-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text, interrupt: false });
const claim = (f: ProjectFixture) => f.app.conversations.ownership.current(f.project);
const origin = (f: ProjectFixture) => f.git(f.origin, 'rev-parse', 'refs/heads/main');
async function pulse(f: ProjectFixture): Promise<void> { await f.app.projectWork.pulse(); await f.app.projectWork.idle('project'); }
function notices(f: ProjectFixture, threadId: string): Array<{ text: string; kind: string }> {
  return f.ledgerText(threadId).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { text: string; kind: string } })
    .filter((event) => event.type === 'notice').map((event) => ({ text: event.data.text, kind: event.data.kind }));
}
const threadTurns = (f: ProjectFixture) => f.fake.turnStarts.filter((input) => input.owner.kind === 'thread');
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const OFF_MAIN = 'This project must be on main before Jevellan can change git.';
const KEPT = `The project checkout stays held by this thread: ${OFF_MAIN}`;
const WAITING_FOR_MAIN = `${OFF_MAIN} This thread continues once the checkout is back on main.`;
const hasRef = (f: ProjectFixture, ref: string) => { try { f.git(f.checkout, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };
const RELEASED = 'The project checkout was given back.';
const LEFT_AS_IS = "The checkout changed after the Stop, so Jevellan gave it back as it is: nothing was committed, saved or reset, and any of the thread's commits still on main stay there.";
const ACTIVE = (f: ProjectFixture) => `Another agent (Claude) is active in Shop on ${f.deviceName}.`;
/** A main thread whose one turn committed `thread.txt` on main ("Work"), at rest; `extra` runs in the turn after the commit. */
async function rested(f: ProjectFixture, title: string, extra?: Parameters<typeof commitStep>[2]): Promise<{ threadId: string; work: string }> {
  f.fake.enqueueTurn(commitStep({ 'thread.txt': 'thread\n' }, { status: 'progress', summary: 'Did stuff.' }, extra), forThread());
  const { threadId } = await start(f, title);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  return { threadId, work: f.git(f.checkout, 'rev-parse', 'refs/heads/main') };
}
/** The owner's own branch with a draft, then Stop: refused off main, the claim kept with one notice (P8 review TH-1). */
async function stopOffMain(f: ProjectFixture, threadId: string): Promise<void> {
  f.git(f.checkout, 'switch', '-c', 'owner-feature');
  writeFileSync(join(f.checkout, 'owner.txt'), 'owner draft\n');
  expect((await stop(f, threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
  expect(notices(f, threadId)).toEqual([{ text: KEPT, kind: 'error' }]);
}

test("a Stop while the owner works on a branch of their own in the claimed checkout commits nothing there and keeps the claim", { timeout: 120_000 }, async () => {
  const f = await setup();
  f.fake.enqueueTurn(commitStep({ 'thread.txt': 'thread\n' }, { status: 'progress', summary: 'Did stuff.' }), forThread());
  const { threadId } = await start(f, 'Did stuff');
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  // The owner takes the checkout by hand: their own branch, with a draft they have not committed.
  f.git(f.checkout, 'switch', '-c', 'owner-feature');
  writeFileSync(join(f.checkout, 'owner.txt'), 'owner draft\n');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD');

  expect((await stop(f, threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/owner-feature');
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? owner.txt');
  expect(hasRef(f, `refs/jevellan/discard/${threadId}/1`)).toBe(false);
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
  expect(notices(f, threadId)).toEqual([{ text: KEPT, kind: 'error' }]);
  // A sweep while the owner is still there changes nothing either.
  await pulse(f);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? owner.txt');
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
});

test("after a Stop refused off main, the owner's return to main with a commit of their own and their draft is left as it is: the sweep gives the checkout back without changing git", { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  const { threadId, work } = await rested(f, 'Did stuff');
  await stopOffMain(f, threadId);
  const feature = f.git(f.checkout, 'rev-parse', 'owner-feature');
  // The owner goes back to main (the draft comes along) and commits by hand there, on top of the thread's commit.
  f.git(f.checkout, 'switch', 'main');
  writeFileSync(join(f.checkout, 'hand.txt'), 'hand\n'); f.git(f.checkout, 'add', 'hand.txt'); f.git(f.checkout, 'commit', '-m', 'Owner hand commit');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD');

  await pulse(f);
  expect(f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD~1')).toBe(work);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? owner.txt');
  expect(existsSync(join(f.checkout, 'owner.txt'))).toBe(true); expect(existsSync(join(f.checkout, 'hand.txt'))).toBe(true);
  expect(hasRef(f, `refs/jevellan/discard/${threadId}/1`)).toBe(false);
  expect(origin(f)).toBe(base); expect(f.git(f.checkout, 'rev-parse', 'owner-feature')).toBe(feature);
  // Nothing is left for the thread to do there: the checkout is given back, once, and says how it was left.
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(f.local(threadId)).not.toHaveProperty('unsettledCheckout');
  expect(notices(f, threadId)).toEqual([{ text: KEPT, kind: 'error' }, { text: LEFT_AS_IS, kind: 'info' }]);
  expect(f.thread(threadId)).toMatchObject({ state: 'stopped', stateReason: 'Stopped by you.' });
  await pulse(f);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head); expect(notices(f, threadId)).toHaveLength(2);
});

test("after a Stop refused off main, the owner's return to main with only their draft leaves main, the draft and the thread's commit as they are", { timeout: 120_000 }, async () => {
  const f = await setup();
  const { threadId, work } = await rested(f, 'Did stuff');
  await stopOffMain(f, threadId);
  // Main is where the Stop saw it, but the draft the owner carried back is not the thread's to commit.
  f.git(f.checkout, 'switch', 'main');

  await pulse(f);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(work);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? owner.txt');
  expect(hasRef(f, `refs/jevellan/discard/${threadId}/1`)).toBe(false);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(notices(f, threadId).at(-1)).toEqual({ text: LEFT_AS_IS, kind: 'info' });
});

test('after a Stop refused off main, a clean return to main as the Stop saw it lets the sweep finish the Stop: commits saved, main reset, checkout given back', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  const { threadId, work } = await rested(f, 'Did stuff');
  await stopOffMain(f, threadId);
  f.git(f.checkout, 'stash', '--include-untracked'); f.git(f.checkout, 'switch', 'main');

  await pulse(f);
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(f.git(f.checkout, 'rev-parse', ref)).toBe(work);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('');
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(f.thread(threadId).stateReason).toBe(`Stopped by you. Its unpublished commits were saved at ${ref}.`);
  expect(notices(f, threadId).at(-1)).toEqual({ text: RELEASED, kind: 'info' });
});

test("a Stop refused while another agent is active on main finishes once it is idle only if the checkout is as the Stop saw it, the thread's leftovers included", { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  const leaveFile = async (turn: { input: { cwd: string } }) => { writeFileSync(join(turn.input.cwd, 'left.txt'), 'left over\n'); };
  const { threadId, work } = await rested(f, 'Did stuff', leaveFile);
  const outside = f.app.conversations.outside;
  vi.spyOn(outside, 'assertIdle').mockRejectedValueOnce(new Error(ACTIVE(f)));
  expect((await stop(f, threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  expect(notices(f, threadId)).toEqual([{ text: `The project checkout stays held by this thread: ${ACTIVE(f)}`, kind: 'error' }]);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? left.txt');

  // The other agent is idle again and nothing changed: the thread's own leftover is committed and saved with its work.
  await pulse(f);
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(f.git(f.checkout, 'rev-parse', `${ref}~1`)).toBe(work);
  expect(f.git(f.checkout, 'show', `${ref}:left.txt`)).toBe('left over');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('');
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
});

test('a Stop refused while another agent is active on main leaves the checkout as it is when that agent changed it meanwhile', { timeout: 120_000 }, async () => {
  const f = await setup();
  const leaveFile = async (turn: { input: { cwd: string } }) => { writeFileSync(join(turn.input.cwd, 'left.txt'), 'left over\n'); };
  const { threadId, work } = await rested(f, 'Did stuff', leaveFile);
  vi.spyOn(f.app.conversations.outside, 'assertIdle').mockRejectedValueOnce(new Error(ACTIVE(f)));
  expect((await stop(f, threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  // The other agent edits the thread's file before it goes idle.
  writeFileSync(join(f.checkout, 'thread.txt'), 'edited by the other agent\n');

  await pulse(f);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(work);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('M thread.txt\n?? left.txt');
  expect(hasRef(f, `refs/jevellan/discard/${threadId}/1`)).toBe(false);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(notices(f, threadId).at(-1)).toEqual({ text: LEFT_AS_IS, kind: 'info' });
});

test('no turn runs while the claimed checkout is off main: the thread rests with its message and runs it once main is back', { timeout: 120_000 }, async () => {
  const f = await setup();
  f.fake.enqueueTurn(commitStep({ 'thread.txt': 'thread\n' }, { status: 'progress', summary: 'First step.' }), forThread());
  const { threadId } = await start(f, 'Two steps');
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  f.git(f.checkout, 'switch', '-c', 'owner-feature');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD');

  f.fake.enqueueTurn(commitStep({ 'second.txt': 'second\n' }, { status: 'progress', summary: 'Second step.' }), forThread());
  expect((await message(f, threadId, 'Go on.')).status).toBe(202);
  const resting = await f.waitFor(() => f.thread(threadId), (thread) => thread.stateReason === WAITING_FOR_MAIN);
  expect(resting).toMatchObject({ state: 'idle', turns: 1 });
  expect(resting.queuedMessages.map((queued) => queued.text)).toEqual(['Go on.']);
  expect(threadTurns(f)).toHaveLength(1);
  // A sweep while the checkout stays off main starts nothing and writes nothing new.
  await pulse(f);
  expect(threadTurns(f)).toHaveLength(1);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });

  f.git(f.checkout, 'switch', 'main');
  await pulse(f);
  const ran = await f.waitFor(() => f.thread(threadId), (thread) => thread.turns === 2 && thread.state === 'idle');
  expect(ran.stateReason).toBeUndefined(); expect(ran.queuedMessages).toEqual([]);
  expect(threadTurns(f)).toHaveLength(2); expect(threadTurns(f)[1]!.prompt).toContain('Go on.');
  expect(f.git(f.checkout, 'log', '-1', '--format=%s', 'owner-feature')).toBe('Work');
  expect(f.git(f.checkout, 'rev-parse', 'owner-feature')).toBe(head);
});

test('a done report while the checkout is off main publishes nothing and commits none of the leftovers there', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(async (turn) => {
    const cwd = turn.input.cwd; f.git(cwd, 'switch', '-c', 'side');
    writeFileSync(join(cwd, 'side.txt'), 'side\n'); f.git(cwd, 'add', '-A'); f.git(cwd, 'commit', '-m', 'Side');
    writeFileSync(join(cwd, 'left.txt'), 'left over\n');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Done on the side.' });
    return { status: 'completed' };
  }, forThread());
  const { threadId } = await start(f, 'Side done');
  const rested = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  expect(rested.stateReason).toBe(OFF_MAIN);
  expect(f.git(f.checkout, 'log', '-1', '--format=%s', 'side')).toBe('Side');
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('?? left.txt');
  expect(origin(f)).toBe(base);
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
});

test("a Stop while the agent's own rebase onto main is unfinished aborts it, saves the thread's commits and releases the checkout", { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(commitStep({ 'value.txt': 'thread\n' }, { status: 'progress', summary: 'Changed the value.' }, async (turn) => {
    // Main moves meanwhile with a conflicting change; the agent starts the rebase and leaves it unfinished.
    const other = join(f.root, 'other'); f.git(f.root, 'clone', f.origin, other);
    writeFileSync(join(other, 'value.txt'), 'upstream\n'); f.git(other, 'commit', '-am', 'Upstream'); f.git(other, 'push', 'origin', 'main');
    f.git(turn.input.cwd, 'fetch', 'origin');
    try { f.git(turn.input.cwd, 'rebase', 'origin/main'); } catch { /* the conflict this test needs */ }
  }), forThread());
  const { threadId } = await start(f, 'Value change');
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'idle' && thread.turns === 1);
  expect(existsSync(join(f.checkout, '.git', 'rebase-merge'))).toBe(true);
  const work = f.git(f.checkout, 'rev-parse', 'ORIG_HEAD');

  expect((await stop(f, threadId)).status).toBe(202);
  const stopped = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(stopped.stateReason).toBe(`Stopped by you. Its unpublished commits were saved at ${ref}.`);
  expect(f.git(f.checkout, 'rev-parse', ref)).toBe(work);
  expect(f.git(f.checkout, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base);
  expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('');
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
});

test('a Stop pressed while the publication waits for its lease stops the push: main stays where it was and the commits are saved', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  const leases = f.app.conversations.leases; const acquire = leases.acquire.bind(leases);
  const waiting = deferred(); const stopped = deferred();
  vi.spyOn(leases, 'acquire').mockImplementation(async (...args) => { waiting.resolve(); await stopped.promise; return acquire(...args); });
  f.fake.enqueueTurn(commitStep({ 'shipped.txt': 'shipped\n' }, { status: 'done', summary: 'Shipped.' }), forThread());
  const { threadId } = await start(f, 'Ship it');
  await waiting.promise;
  expect(f.thread(threadId).state).toBe('publishing');
  const runner = f.app.projectWork.threads.runner(threadId)!; const original = runner.stop.bind(runner);
  vi.spyOn(runner, 'stop').mockImplementation((...args) => { const result = original(...args); stopped.resolve(); return result; });
  const response = stop(f, threadId);
  await stopped.promise;
  expect((await response).status).toBe(202);
  const ended = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  expect(origin(f)).toBe(base);
  expect(ended.publishedCommit).toBeUndefined();
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(ended.stateReason).toBe(`Stopped by you. Its unpublished commits were saved at ${ref}.`);
  expect(f.git(f.checkout, 'log', '-1', '--format=%s', ref)).toBe('Work');
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
});

test('messages that waited during a publication that concluded the thread are named as not delivered, and the queue is cleared', { timeout: 120_000 }, async () => {
  const f = await setup();
  const leases = f.app.conversations.leases; const acquire = leases.acquire.bind(leases);
  const waiting = deferred(); const release = deferred();
  vi.spyOn(leases, 'acquire').mockImplementation(async (...args) => { waiting.resolve(); await release.promise; return acquire(...args); });
  f.fake.enqueueTurn(commitStep({ 'shipped.txt': 'shipped\n' }, { status: 'done', summary: 'Shipped.' }), forThread());
  const { threadId } = await start(f, 'Ship it');
  await waiting.promise;
  expect((await message(f, threadId, 'Also rename the button.')).status).toBe(202);
  expect(f.thread(threadId).queuedMessages.map((queued) => queued.text)).toEqual(['Also rename the button.']);
  release.resolve();
  const done = await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'done');
  expect(done.publishedCommit).toBe(origin(f));
  expect(done.queuedMessages).toEqual([]);
  expect(notices(f, threadId)).toContainEqual({ text: 'The thread concluded before these messages reached it: "Also rename the button."', kind: 'error' });
  expect(threadTurns(f)).toHaveLength(1);
});
