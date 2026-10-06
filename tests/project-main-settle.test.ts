// A main thread's checkout claim that could not be settled when the thread ended (D291: the hub unreachable at the release, a stop on a
// branch the agent switched to, a process whose end was not confirmed) is settled again at every sweep until it is released, and the
// thread page says why the checkout stays held meanwhile. Simulated: the runtime turns (FakeRuntime through the real bridge) and, where
// a test says so, one failed release. Live: git on a bare origin, HTTP, the hub, the ledgers, checkout ownership and process groups.
import { afterEach, expect, test, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubUnavailable, ThreadCreatedViewSchema, ThreadLocalSchema, ThreadSchema, ThreadViewSchema, groupAlive, processIdentity, readDocument, writeDocument } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { RESTART_UNCONFIRMED, commitsSavedReason, mainCheckoutKept } from '../packages/projects/dist/index.js';
import { commitStep, expectNoLeaks, holdStep, never, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
async function setup(): Promise<ProjectFixture> { fixture = await projectFixture(); return fixture; }

const start = (f: ProjectFixture, title: string) => f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
  { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: `Do ${title}.`, isolation: 'main' });
const stop = (f: ProjectFixture, threadId: string) => f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' });
const claim = (f: ProjectFixture) => f.app.conversations.ownership.current(f.project);
const origin = (f: ProjectFixture) => f.git(f.origin, 'rev-parse', 'refs/heads/main');
const page = (f: ProjectFixture, threadId: string) => f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema);
async function pulse(f: ProjectFixture): Promise<void> { await f.app.projectWork.pulse(); await f.app.projectWork.idle('project'); }
function notices(f: ProjectFixture, threadId: string): Array<{ text: string; kind: string }> {
  return f.ledgerText(threadId).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { text: string; kind: string } })
    .filter((event) => event.type === 'notice').map((event) => ({ text: event.data.text, kind: event.data.kind }));
}
/** The thread page line while the claim waits (the server sentence, shown as is). */
const stillHeld = (message: string) => `${mainCheckoutKept(message)} Jevellan tries again until it is released.`;
const RELEASED = 'The project checkout was given back.';
const OFF_MAIN = 'This project must be on main before Jevellan can change git.';
const conversationOwner = { conversationId: 'conv_other', conversationTitle: 'Other work', workId: 'work_other' };

test('a stop on a branch the agent switched to keeps the claim with one notice; once main is back a sweep settles it and the checkout is free', { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(holdStep(never(), async (turn) => {
    const cwd = turn.input.cwd; f.git(cwd, 'checkout', '-b', 'side');
    writeFileSync(join(cwd, 'side.txt'), 'side\n'); f.git(cwd, 'add', '-A'); f.git(cwd, 'commit', '-m', 'Side');
  }), forThread());
  const { threadId } = await start(f, 'Side work');
  await f.waitFor(() => f.git(f.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'), (branch) => branch === 'side');
  expect((await stop(f, threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped');
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
  expect(notices(f, threadId)).toEqual([{ text: mainCheckoutKept(OFF_MAIN), kind: 'error' }]);
  expect((await page(f, threadId)).checkoutHeld).toBe(stillHeld(OFF_MAIN));

  // While the cause stays, a sweep keeps the claim and says nothing new; a conversation is still kept off the checkout.
  await pulse(f);
  expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
  expect(notices(f, threadId)).toHaveLength(1);
  await expect(f.app.conversations.ownership.acquire(f.project, conversationOwner)).rejects.toThrow(`Shop on ${f.deviceName} is in use by "Side work".`);

  // The owner puts the checkout back on main: the next sweep settles the stop and gives the checkout back.
  f.git(f.checkout, 'checkout', 'main');
  await pulse(f);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(f.local(threadId)).not.toHaveProperty('unsettledCheckout');
  expect((await page(f, threadId)).checkoutHeld).toBeUndefined();
  expect(notices(f, threadId).at(-1)).toEqual({ text: RELEASED, kind: 'info' });
  expect(f.thread(threadId)).toMatchObject({ state: 'stopped', stateReason: 'Stopped by you.' });
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe('');
  expect(f.git(f.checkout, 'log', '-1', '--format=%s', 'side')).toBe('Side');
  await f.app.conversations.ownership.acquire(f.project, conversationOwner);
  await f.app.conversations.ownership.release(f.project, conversationOwner, { processesGone: true, commits: 'unchanged' });
});

test('a release the hub refused after publishing, and a stop whose release failed after it saved and reset, are settled at the next sweep (simulated hub outage)', { timeout: 120_000 }, async () => {
  const f = await setup();
  const ownership = f.app.conversations.ownership; const release = ownership.release.bind(ownership);
  let failures = 0;
  vi.spyOn(ownership, 'release').mockImplementation(async (...args) => { if (failures > 0) { failures -= 1; throw new HubUnavailable('checkout-ownership'); } return release(...args); });
  const outage = new HubUnavailable('checkout-ownership').message;

  failures = 1;
  f.fake.enqueueTurn(commitStep({ 'shipped.txt': 'shipped\n' }, { status: 'done', summary: 'Shipped.' }), forThread());
  const shipped = await start(f, 'Ship it');
  const done = await f.waitFor(() => f.thread(shipped.threadId), (thread) => thread.state === 'done');
  expect(origin(f)).toBe(done.publishedCommit);
  expect(await claim(f)).toMatchObject({ held: true, conversationId: shipped.threadId });
  expect((await page(f, shipped.threadId)).checkoutHeld).toBe(stillHeld(outage));
  await pulse(f);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: shipped.threadId });
  expect((await page(f, shipped.threadId)).checkoutHeld).toBeUndefined();
  expect(notices(f, shipped.threadId).map((notice) => notice.text)).toEqual([mainCheckoutKept(outage), RELEASED]);

  // A stop that saved the commits and reset main, then could not release: the next sweep releases, and the reason names the saved ref.
  const base = origin(f);
  f.fake.enqueueTurn(holdStep(never(), async (turn) => {
    writeFileSync(join(turn.input.cwd, 'draft.txt'), 'draft\n'); f.git(turn.input.cwd, 'add', '-A'); f.git(turn.input.cwd, 'commit', '-m', 'Draft');
  }), forThread());
  const drafted = await start(f, 'Draft it');
  await f.waitFor(() => f.git(f.checkout, 'log', '-1', '--format=%s'), (subject) => subject === 'Draft');
  failures = 1;
  expect((await stop(f, drafted.threadId)).status).toBe(202);
  await f.waitFor(() => f.thread(drafted.threadId), (thread) => thread.state === 'stopped');
  const ref = `refs/jevellan/discard/${drafted.threadId}/1`;
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'log', '-1', '--format=%s', ref)).toBe('Draft');
  expect(await claim(f)).toMatchObject({ held: true, conversationId: drafted.threadId });
  await pulse(f);
  expect(await claim(f)).toMatchObject({ held: false, conversationId: drafted.threadId });
  expect(f.thread(drafted.threadId).stateReason).toBe(commitsSavedReason('Stopped by you.', ref));
  expect(f.git(f.checkout, 'rev-parse', ref)).not.toBe(base);
});

test("a main thread whose process could not be confirmed gone after a restart keeps the claim until the process ends, then saves its commits and releases", { timeout: 120_000 }, async () => {
  const f = await setup();
  const base = origin(f);
  f.fake.enqueueTurn(holdStep(never(), async (turn) => {
    writeFileSync(join(turn.input.cwd, 'half.txt'), 'half\n'); f.git(turn.input.cwd, 'add', '-A'); f.git(turn.input.cwd, 'commit', '-m', 'Half');
  }), forThread());
  const { threadId } = await start(f, 'Half done');
  await f.waitFor(() => f.git(f.checkout, 'log', '-1', '--format=%s'), (subject) => subject === 'Half');
  // A crash leaves the thread running with a recorded process that is still alive under an identity that does not match.
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); sleeper.unref();
  // Reaped, not only killed: on macOS a group whose only member is an unreaped zombie answers EPERM, and `ps` still lists it.
  const exited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
  const live = processIdentity(sleeper.pid!);
  try {
    await f.restart(() => {
      // A shutdown leaves the thread `running` (D24); its own process record was cleared when that turn ended.
      const paths = f.app.projectWork.paths;
      expect(readDocument(paths.threadFile('project', threadId), ThreadSchema).state).toBe('running');
      const local = readDocument(paths.threadLocal('project', threadId), ThreadLocalSchema);
      writeDocument(paths.threadLocal('project', threadId), ThreadLocalSchema, { ...local, process: { turn: 1, pid: live.pid, pgid: live.pgid, startIdentity: 'Thu Jan  1 00:00:00 1970',
        startedAt: new Date().toISOString() } });
    });
    expect(f.thread(threadId)).toMatchObject({ state: 'failed', stateReason: RESTART_UNCONFIRMED });
    await pulse(f);
    expect(groupAlive(live.pgid)).toBe(true);
    expect(await claim(f)).toMatchObject({ held: true, conversationId: threadId });
    expect(f.git(f.checkout, 'log', '-1', '--format=%s')).toBe('Half');
    expect((await page(f, threadId)).checkoutHeld).toBe(stillHeld("Jevellan could not confirm this thread's process stopped."));
  } finally { try { process.kill(-live.pgid, 'SIGKILL'); } catch { /* gone */ } }
  await exited;
  await pulse(f);
  const ref = `refs/jevellan/discard/${threadId}/1`;
  expect(await claim(f)).toMatchObject({ held: false, conversationId: threadId });
  expect(f.thread(threadId)).toMatchObject({ state: 'failed', stateReason: commitsSavedReason(RESTART_UNCONFIRMED, ref) });
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(base); expect(f.git(f.checkout, 'log', '-1', '--format=%s', ref)).toBe('Half');
  expect(f.local(threadId)).not.toHaveProperty('process'); expect(existsSync(join(f.checkout, 'half.txt'))).toBe(false);
});
