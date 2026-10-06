// An attached thread holds what the owner's terminal uses (brief phase 7; D46, D297, D298; phase 8 fixes): Stop, Restart and Discard
// wait for the terminal session to end, from the owner and the coordinator alike, and the thread's account is held for turns on its
// device, so other threads and the coordinator wait for it or run on another eligible account. Simulated: the runtime turns
// (FakeRuntime under the `claude` id through the real bridge). Live: git, HTTP, the hub, the ledgers and checkout ownership.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AccountSchema, DeviceSchema, ProjectWorkSettingsSchema, ThreadCreatedViewSchema, ThreadIndexSchema, ThreadViewSchema, defaultProjectWorkSettings, type ModelOption,
} from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forCoordinator, forThread } from '../packages/runtime-contract/dist/index.js';
import { STOP_THE_THREAD, accountMovedNotice } from '../packages/projects/dist/index.js';
import { FIXTURE_MENU, commitStep, expectNoLeaks, projectFixture, reportStep, type ProjectFixture, type ProjectFixtureOptions } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});

const CLAUDE: ModelOption = { id: 'claude_fixture', runtime: 'claude', model: 'scripted-model', label: 'Claude fixture', description: 'Simulated model.', efforts: ['high'], enabled: true };
/** A fake runtime registered under the `claude` id, so threads can be attached. */
function named(): FakeRuntime {
  const runtime = new FakeRuntime(); Object.defineProperty(runtime, 'id', { value: 'claude' }); return runtime;
}
async function setup(claude: FakeRuntime, options: ProjectFixtureOptions = {}): Promise<ProjectFixture> {
  fixture = await projectFixture({ menu: [...FIXTURE_MENU, CLAUDE], runtimes: { fake: new FakeRuntime(), claude }, ...options });
  return fixture;
}
async function account(f: ProjectFixture, id: string, label: string): Promise<void> {
  f.app.hub.put('accounts', id, AccountSchema, { schema: 'account-v1', id, runtime: 'claude', label, kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0);
  await f.app.accounts.check(id);
}
async function start(f: ProjectFixture, title: string, extra: object = {}): Promise<string> {
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST',
    { schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: `Do ${title}.`, modelId: 'claude_fixture', ...extra });
  return created.threadId;
}
async function settle(f: ProjectFixture): Promise<void> { await f.app.projectWork.idle('project'); }
async function rest(f: ProjectFixture, threadId: string, state = 'idle'): Promise<void> {
  await f.waitFor(() => f.thread(threadId).state, (current) => current === state); await settle(f);
}
async function refusedWith(response: Response, message: string): Promise<void> {
  expect({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { schema: 'error-v1', code: 'conflict', message } });
}
/** The one sentence every refused Stop, Restart and Discard of an attached thread answers. */
const attachedRefusal = (threadId: string) => `This thread is attached in a terminal: exit that terminal session first, or run jevellan thread detach ${threadId}.`;
const waitingForAccount = (label: string) => `Waiting for account ${label}, which is in use in a terminal. This thread continues when the terminal session ends.`;
const coordinatorWaits = (label: string) => `Account ${label} is in use in a terminal. The coordinator continues when the terminal session ends.`;
const threadTurns = (runtime: FakeRuntime) => runtime.turnStarts.filter((input) => input.owner.kind === 'thread');
const coordinatorTurns = (runtime: FakeRuntime) => runtime.turnStarts.filter((input) => input.owner.kind === 'coordinator');
const notices = (f: ProjectFixture, threadId: string) => f.ledgerText(threadId).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { text?: string } })
  .filter((event) => event.type === 'notice').map((event) => event.data.text);

test('an attached thread refuses Stop, Restart and Discard from the owner and the coordinator with one sentence, and works again after detach', { timeout: 120_000 }, async () => {
  const claude = named(); const f = await setup(claude);
  await account(f, 'acc_claude', 'Claude');
  // A main thread holds the project checkout: a stop under the owner's terminal would save its commits and reset main.
  claude.enqueueTurn(commitStep({ 'copy.txt': 'copy\n' }, { status: 'progress', summary: 'Drafted the copy.' }), forThread());
  const threadId = await start(f, 'Edit copy', { isolation: 'main' });
  await rest(f, threadId);
  await f.app.projectWork.attach(threadId);
  const head = f.git(f.checkout, 'rev-parse', 'HEAD'); const status = f.git(f.checkout, 'status', '--porcelain=v1');
  const claim = await f.app.conversations.ownership.current(f.project);
  expect(claim).toMatchObject({ held: true, conversationId: threadId });
  const refusal = attachedRefusal(threadId);

  // The owner's Stop, Restart and Discard, then the coordinator's stop: each refused with the sentence, nothing changes.
  await refusedWith(await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' }), refusal);
  await refusedWith(await f.request(`/api/projects/project/threads/${threadId}/override`, 'POST',
    { schema: 'thread-override-request-v1', clientRequestId: `ovr_${randomUUID()}`, mode: 'restart', isolation: 'main', modelId: 'claude_fixture', effort: 'high', deviceId: f.app.device.deviceId }), refusal);
  await refusedWith(await f.request(`/api/projects/project/threads/${threadId}/discard`, 'POST', { schema: 'empty-request-v1' }), refusal);
  await expect(f.app.projectWork.threads.stop('project', threadId, 'No longer needed.', false)).rejects.toMatchObject({ status: 409, message: refusal });
  expect(f.thread(threadId)).toMatchObject({ state: 'attached' });
  expect(f.app.projectWork.store.list('project').map((thread) => thread.id)).toEqual([threadId]);
  expect(await f.app.projectHub.recentOverrides('project', 10)).toEqual([]);
  expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(head); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe(status);
  expect(f.git(f.checkout, 'for-each-ref', '--format=%(refname)', `refs/jevellan/discard/${threadId}`)).toBe('');
  expect(await f.app.conversations.ownership.current(f.project)).toEqual(claim);

  // The page says why: Stop and the Restart choice are disabled with the sentence.
  const page = await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema);
  expect(page.stopRefusal).toBe(refusal);
  expect(page.canOverride).toEqual({ nextTurn: true, restart: false, restartReason: refusal });

  // After detach the refused stop left nothing behind: a message runs the next turn, and Stop works.
  await f.app.projectWork.detach(threadId); await settle(f);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Checked the copy.' }), forThread());
  await f.app.projectWork.threads.message('project', threadId, 'owner', 'Check the copy.', false);
  await f.waitFor(() => threadTurns(claude).length, (count) => count === 2); await rest(f, threadId);
  expect(threadTurns(claude).at(-1)!.prompt).toBe('Check the copy.');
  expect((await f.json(`/api/projects/project/threads/${threadId}`, ThreadViewSchema)).stopRefusal).toBeUndefined();
  expect((await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' })).status).toBe(202);
  expect((await f.waitFor(() => f.thread(threadId), (thread) => thread.state === 'stopped')).stateReason).toMatch(/^Stopped by you\. Its unpublished commits were saved at /);
});

test('the turn-limit Stop answer and a coordinator stop for another device wait for the terminal session too, and the question stays open', { timeout: 120_000 }, async () => {
  const claude = named(); const f = await setup(claude);
  await account(f, 'acc_claude', 'Claude');
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Half way.' }), forThread());
  const threadId = await start(f, 'Long task');
  await rest(f, threadId);
  // The thread reaches its turn limit with a waiting message: the owner decides with the turn-limit question.
  f.app.projectWork.store.update(threadId, (thread) => ({ ...thread, turnAllowance: thread.turns }));
  await f.app.projectWork.threads.message('project', threadId, 'owner', 'Keep going.', false);
  await rest(f, threadId, 'waiting-for-you');
  const question = (await f.app.projectHub.decisions('project')).find((decision) => decision.threadId === threadId)!;
  expect(question.options.map((option) => option.label)).toContain(STOP_THE_THREAD);
  await f.app.projectWork.attach(threadId);
  await expect(f.app.projectWork.answerDecision('project', question.id, { schema: 'decision-answer-request-v1', clientRequestId: `ans_${randomUUID()}`, optionLabel: STOP_THE_THREAD }))
    .rejects.toMatchObject({ status: 409, message: attachedRefusal(threadId) });
  expect((await f.app.projectHub.decisions('project')).find((decision) => decision.id === question.id)).not.toHaveProperty('answer');
  expect(f.thread(threadId).state).toBe('attached');

  // An attached thread on another device: the coordinator's stop is refused before any command is sent.
  const at = new Date().toISOString();
  f.app.hub.put('devices', 'dev_laptop', DeviceSchema, { schema: 'device-v1', id: 'dev_laptop', name: 'Laptop', role: 'member', url: 'http://127.0.0.1:9', os: 'darwin', version: '0.1.0', joinedAt: at }, 0);
  await new HubProjectAccess(f.app.hub, 'dev_laptop').publishThread(ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_remote', projectId: 'project',
    title: 'Elsewhere', state: 'attached', isolation: 'worktree', ownerDeviceId: 'dev_laptop', runtime: 'claude', modelLabel: 'Claude fixture', effort: 'high', accountLabel: 'Laptop account',
    turns: 1, createdAt: at, updatedAt: at }), 1);
  await expect(f.app.projectWork.threads.stop('project', 'thread_remote', 'No longer needed.', false)).rejects.toMatchObject({ status: 409, message: attachedRefusal('thread_remote') });
  expect(f.app.projectWork.outbox.pending('project')).toEqual([]);
});

test("an attached thread's account is held for turns on its device: other threads wait, also across a restart, and run on another eligible account", { timeout: 120_000 }, async () => {
  const claude = named(); const f = await setup(claude);
  await account(f, 'acc_claude_a', 'Claude A');
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Terminal work next.' }), forThread((input) => input.prompt.startsWith('Task: Terminal')));
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Waiting for more.' }), forThread((input) => input.prompt.startsWith('Task: Other')));
  const attached = await start(f, 'Terminal'); const other = await start(f, 'Other');
  await rest(f, attached); await rest(f, other);
  const session = f.thread(other).nativeSessionId; expect(session).toBeTruthy();
  expect(f.thread(attached).placement.accountId).toBe('acc_claude_a'); expect(f.thread(other).placement.accountId).toBe('acc_claude_a');
  await f.app.projectWork.attach(attached);

  // A message for the other thread waits with its reason; a new thread's first turn waits too. No turn starts on the held account.
  await f.app.projectWork.threads.message('project', other, 'owner', 'Go on.', false); await settle(f);
  const late = await start(f, 'Late'); await f.waitFor(() => f.thread(late).stateReason, (reason) => reason === waitingForAccount('Claude A')); await settle(f);
  expect(threadTurns(claude)).toHaveLength(2);
  expect(f.thread(other)).toMatchObject({ state: 'idle', stateReason: waitingForAccount('Claude A'), queuedMessages: [expect.objectContaining({ text: 'Go on.' })] });
  expect(f.thread(late)).toMatchObject({ state: 'idle', stateReason: waitingForAccount('Claude A'), turns: 0 });

  // The hold is the attached state itself, so it survives a restart and the sweeps start nothing.
  await f.restart(); await f.app.projectWork.pulse(); await settle(f);
  expect(f.thread(attached).state).toBe('attached'); expect(threadTurns(claude)).toHaveLength(2);
  expect(f.thread(other).stateReason).toBe(waitingForAccount('Claude A')); expect(f.thread(late).stateReason).toBe(waitingForAccount('Claude A'));

  // Detach releases the account: the waiting message resumes the other thread's session and the late thread takes its first turn.
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Went on.' }), forThread((input) => input.prompt === 'Go on.'));
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Started late.' }), forThread((input) => input.prompt.startsWith('Task: Late')));
  await f.app.projectWork.detach(attached);
  await f.waitFor(() => threadTurns(claude).length, (count) => count === 4); await rest(f, other); await rest(f, late);
  const resumed = threadTurns(claude).find((input) => input.prompt === 'Go on.')!;
  expect(resumed.resume).toEqual({ sessionId: session }); expect(resumed.account.account.id).toBe('acc_claude_a');
  expect(threadTurns(claude).find((input) => input.prompt.startsWith('Task: Late'))!.prompt).toBe('Task: Late\n\nDo Late.');
  expect(f.thread(other)).toMatchObject({ state: 'idle', queuedMessages: [], turns: 2 }); expect(f.thread(other).stateReason).toBeUndefined();
  expect(f.thread(late)).toMatchObject({ state: 'idle', turns: 1 }); expect(f.local(late)).not.toHaveProperty('pendingTurn');

  // With a second eligible account the other thread does not wait: it moves there in a fresh session (D16).
  await account(f, 'acc_claude_b', 'Claude B');
  await f.app.projectWork.attach(attached);
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Moved.' }), forThread((input) => input.prompt.endsWith('Use the other account.')));
  await f.app.projectWork.threads.message('project', other, 'owner', 'Use the other account.', false);
  await f.waitFor(() => threadTurns(claude).length, (count) => count === 5); await rest(f, other);
  const moved = threadTurns(claude).at(-1)!;
  expect(moved.account.account.id).toBe('acc_claude_b'); expect(moved.resume).toBeUndefined();
  expect(f.thread(other).placement.accountId).toBe('acc_claude_b');
  expect(notices(f, other)).toContain(accountMovedNotice('Claude B'));
  await f.app.projectWork.detach(attached); await settle(f);
});

test('a coordinator on the held account waits as Unavailable without a failed turn and runs once the terminal session ends', { timeout: 120_000 }, async () => {
  const claude = named(); claude.capabilities.readOnlyEnforced = true;
  const f = await setup(claude);
  await account(f, 'acc_claude', 'Claude');
  await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('project'), coordinator: { modelId: 'claude_fixture', effort: 'high' } }), 0);
  const reply = () => claude.enqueueTurn((turn) => { turn.say('Noted.'); return { status: 'completed' }; }, forCoordinator);
  for (let i = 0; i < 3; i++) reply();
  claude.enqueueTurn(reportStep({ status: 'progress', summary: 'Ready for the terminal.' }), forThread());
  const threadId = await start(f, 'Terminal');
  await rest(f, threadId);
  await f.waitFor(() => f.coordinatorState(), (state) => state.state === 'idle' && state.queue.length === 0); await settle(f);
  const before = coordinatorTurns(claude).length; expect(before).toBeGreaterThan(0);
  expect(coordinatorTurns(claude).at(-1)!.account.account.id).toBe('acc_claude');

  await f.app.projectWork.attach(threadId);
  await f.app.projectWork.postMessage('project', { schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text: 'How is it going?' });
  await f.waitFor(() => f.coordinatorState(), (state) => state.state === 'unavailable'); await settle(f);
  expect(f.coordinatorState()).toMatchObject({ state: 'unavailable', unavailableReason: coordinatorWaits('Claude'), failedTurnsInARow: 0 });
  expect(f.coordinatorState().queue.map((event) => event.kind)).toContain('user-message');
  await f.app.projectWork.pulse(); await settle(f);
  expect(coordinatorTurns(claude)).toHaveLength(before);

  // Detach frees the account: the coordinator takes the waiting events in its next turn.
  reply();
  await f.app.projectWork.detach(threadId);
  await f.waitFor(() => f.coordinatorState(), (state) => state.state === 'idle' && state.queue.length === 0); await settle(f);
  expect(coordinatorTurns(claude)).toHaveLength(before + 1);
  expect(f.coordinatorState().failedTurnsInARow).toBe(0); expect(f.coordinatorState()).not.toHaveProperty('unavailableReason');
});
