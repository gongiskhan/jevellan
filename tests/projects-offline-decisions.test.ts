// Phase 5, owner questions while the coordinator cannot take them (brief section 4 decision 7, brief 11 decision answers; design 2.6.11;
// D32, D80, D195, D280): a hub fixture and a simulated member over real HTTP. A thread whose coordinator lives on a device the roster
// reads offline asks the owner itself, under the id the coordinator's own fallback would use; the answer reaches the thread as the
// owner's message; the coordinator, wherever it later receives the report, reads it as already asked. Simulated: the member device
// (local HTTP), the runtime turns and the device presence. Live: git, HTTP, the hub, the relay and the ledgers.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DeviceSchema, ProjectEnvelopeSchema, ProjectWorkViewSchema, ThreadCreatedViewSchema, type CoordinatorEvent, type ProjectDecision,
} from '../packages/core/dist/index.js';
import { forCoordinator, forThread, type FakeRuntime, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { ASKED_DIRECTLY_SUFFIX, derivedId } from '../packages/projects/dist/index.js';
import { expectNoLeaks, projectFixture, projectMember, reportStep, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
/** A hub whose coordinator runs read-only turns and checks waiting questions at every sweep, and a member that can run the coordinator. */
async function setup(): Promise<{ f: ProjectFixture; m: ProjectMember }> {
  const f = fixture = await projectFixture({ coordinator: true, projectTimers: { fallbackCheckMs: 0 } });
  const m = await projectMember(f); m.fake.capabilities.readOnlyEnforced = true;
  return { f, m };
}

const pid = 'project';
const empty = { schema: 'empty-request-v1' };
const MOVE = `/api/projects/${pid}/coordinator/move`; const MESSAGES = `/api/projects/${pid}/coordinator/messages`;
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
const fail = (text: string): FakeTurnStep => () => ({ status: 'failed', error: { kind: 'other', message: text } });
const coordinatorTurns = (fake: FakeRuntime): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');
const threadTurns = (fake: FakeRuntime, threadId: string): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'thread' && input.owner.id === threadId);
const database = { status: 'needs-decision', summary: 'Need a database choice.', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] };
const port = { status: 'needs-decision', summary: 'Need a port.', question: 'Which port?', options: [{ label: '5432' }, { label: '6543' }] };
const createBody = (title: string) => ({ schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title, task: `Do ${title}.` });
const answer = (optionLabel: string) => ({ schema: 'decision-answer-request-v1', clientRequestId: `ans_${randomUUID()}`, optionLabel });
const message = (text: string) => ({ schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text });
/** No heartbeat for an hour: the roster reads the device offline (D80). */
function silence(f: ProjectFixture, deviceId: string): void {
  const row = f.app.hub.get('devices', deviceId, DeviceSchema)!;
  f.app.hub.put('devices', deviceId, DeviceSchema, { ...row.document, lastHeartbeatAt: new Date(Date.now() - 3_600_000).toISOString() }, row.revision);
}
/** The coordinator events the hub relay holds for a device. */
function relayed(f: ProjectFixture, deviceId: string): CoordinatorEvent[] {
  return f.app.hub.list('project-envelopes', ProjectEnvelopeSchema).map((row) => row.document)
    .flatMap((envelope) => envelope.targetDeviceId === deviceId && envelope.body.kind === 'coordinator-event' ? [envelope.body.event] : []);
}
const questions = async (f: ProjectFixture, threadId: string): Promise<ProjectDecision[]> => (await f.app.projectHub.decisions(pid)).filter((decision) => decision.threadId === threadId);
const reportLine = (title: string, threadId: string, report: typeof database) =>
  `[thread "${title}" (${threadId}) reported needs-decision] ${report.summary}\nQuestion: ${report.question}\nOptions: ${report.options.map((option) => option.label).join('; ')}`;

test('while the coordinator device is offline a thread asks the owner directly, the answer reaches the thread, and the coordinator later reads the report as asked', { timeout: 180_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId;

  // 1. A thread on the hub, its first turn held; the hub coordinator notes the start. Then the coordinator moves to the member.
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  f.fake.enqueueTurn(async (turn) => { await gate; await turn.bridge('jevellan_thread_report', database); return { status: 'completed' }; },
    forThread((input) => input.prompt.startsWith('Task: Store data')));
  f.fake.enqueueTurn(say('Noted.'), forCoordinator);
  const threadId = (await f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody('Store data'))).threadId;
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'running');
  await f.waitFor(() => coordinatorTurns(f.fake).length, (count) => count === 1); await f.waitFor(() => f.coordinatorState().state, (state) => state === 'idle');
  expect((await m.request(MOVE, 'POST', empty)).status).toBe(200);
  expect((await f.app.projectHub.coordinator(pid))?.document.deviceId).toBe(m.deviceId);

  // 2. The member stops reporting (D80). The thread asks: the hub, which owns the thread, creates the owner's question itself under
  // the id the coordinator's fallback would use (D195), and still relays the report to the coordinator device.
  silence(f, m.deviceId);
  expect((await f.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema)).coordinator.state).toBe('offline');
  release();
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'waiting-for-you'); await f.app.projectWork.idle();
  // Asked when the report was made, before any sweep.
  const asked = await questions(f, threadId);
  expect(asked).toHaveLength(1);
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  const first = relayed(f, m.deviceId).find((event) => event.kind === 'thread-report')!;
  expect(first).toMatchObject({ kind: 'thread-report', threadId, report: { status: 'needs-decision', question: 'Which database?' } });
  expect(await questions(f, threadId)).toHaveLength(1);
  expect(asked[0]).toMatchObject({ id: derivedId('pdec', 'fallback', first.id), from: 'thread', threadId, question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    createdAt: first.at });
  expect((await f.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema)).decisions.open.map((decision) => decision.id)).toEqual([asked[0]!.id]);

  // 3. The member is back but has not read the relay. The owner answers on the hub: the answer reaches the thread directly as the
  // owner's message (brief 11), and its next turn asks again. With the coordinator device online that question goes to the coordinator.
  await m.heartbeat();
  f.fake.enqueueTurn(reportStep(port), forThread((input) => input.prompt === 'Postgres'));
  const answered = await f.request(`/api/projects/${pid}/decisions/${asked[0]!.id}/answer`, 'POST', answer('Postgres'));
  expect(answered.status).toBe(202);
  await f.waitFor(() => f.thread(threadId), (thread) => thread.turns === 2 && thread.state === 'waiting-for-you'); await f.app.projectWork.idle();
  expect(threadTurns(f.fake, threadId).map((input) => input.prompt)[1]).toBe('Postgres');
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await questions(f, threadId)).filter((decision) => !decision.answer)).toEqual([]);

  // 4. The member goes quiet again before reading the relay: the hub's next sweep notices that the thread still waits on a question
  // the coordinator cannot take, and asks the owner (once, however many sweeps run).
  silence(f, m.deviceId);
  await f.app.projectWork.pulse(); await f.app.projectWork.idle(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  // The relay lists envelopes by id, not by time: pick the second report by its question.
  const reports = relayed(f, m.deviceId).filter((event) => event.kind === 'thread-report');
  expect(reports).toHaveLength(2);
  const second = reports.find((event) => event.kind === 'thread-report' && event.report.question === 'Which port?')!;
  expect(second).toMatchObject({ threadId, report: { status: 'needs-decision' } });
  const open = (await questions(f, threadId)).filter((decision) => !decision.answer);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({ id: derivedId('pdec', 'fallback', second.id), from: 'thread', threadId, question: 'Which port?' });

  // 5. The member returns and reads the relay: its coordinator gets both reports marked as asked directly (D32), and creates nothing.
  await m.heartbeat();
  for (let n = 0; n < 3; n++) m.fake.enqueueTurn(say('Noted.'), forCoordinator);
  const prompts = await f.waitFor(async () => { await m.app.projectWork.pulse(); await m.app.projectWork.idle(); return coordinatorTurns(m.fake).map((input) => input.prompt).join('\n'); },
    (text) => text.includes('Which port?'));
  expect(prompts).toContain(`${reportLine('Store data', threadId, database)}${ASKED_DIRECTLY_SUFFIX}`);
  expect(prompts).toContain(`${reportLine('Store data', threadId, port)}${ASKED_DIRECTLY_SUFFIX}`);
  expect(await questions(f, threadId)).toHaveLength(2);
  // Nothing ran on the hub's coordinator after the move.
  expect(coordinatorTurns(f.fake)).toHaveLength(1); expect(hubId).not.toBe(m.deviceId);
});

test('a question the former coordinator asked the owner directly stays marked as asked when its report moves with the coordinator', { timeout: 120_000 }, async () => {
  const { f, m } = await setup();
  // Two failed coordinator turns on the hub: the fallback is active, so the thread's question becomes the owner's at once (D195).
  f.fake.enqueueTurn(fail('Model overloaded.'), forCoordinator); f.fake.enqueueTurn(fail('Model overloaded.'), forCoordinator);
  f.fake.enqueueTurn(reportStep(database), forThread((input) => input.prompt.startsWith('Task: Store data')));
  expect((await f.request(MESSAGES, 'POST', message('Plan the storage.'))).status).toBe(202);
  await f.waitFor(() => f.coordinatorState().failedTurnsInARow, (count) => count === 2); await f.app.projectWork.idle();
  const threadId = (await f.json(`/api/projects/${pid}/threads`, ThreadCreatedViewSchema, 'POST', createBody('Store data'))).threadId;
  await f.waitFor(() => f.thread(threadId).state, (state) => state === 'waiting-for-you');
  await f.waitFor(async () => questions(f, threadId), (items) => items.length === 1); await f.app.projectWork.idle();
  const report = f.coordinatorState().queue.find((event) => event.kind === 'thread-report')!;
  expect((await questions(f, threadId))[0]).toMatchObject({ id: derivedId('pdec', 'fallback', report.id), from: 'thread' });

  // The member takes the coordinator over; the hub's sweep hands the queue over (D271) and the member's turns (the events arrive one
  // by one, so they may take more than one) read the report as already asked, without a second question.
  for (let n = 0; n < 3; n++) m.fake.enqueueTurn(say('On it.'), forCoordinator);
  expect((await m.request(MOVE, 'POST', empty)).status).toBe(200);
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  const prompts = await f.waitFor(async () => { await m.app.projectWork.pulse(); await m.app.projectWork.idle(); return coordinatorTurns(m.fake).map((input) => input.prompt).join('\n'); },
    (text) => text.includes('Which database?\nOptions'));
  expect(coordinatorTurns(m.fake)[0]!.resume).toBeUndefined(); expect(prompts).toContain('Plan the storage.');
  expect(prompts).toContain(`${reportLine('Store data', threadId, database)}${ASKED_DIRECTLY_SUFFIX}`);
  expect(await questions(f, threadId)).toHaveLength(1);
  expect(coordinatorTurns(f.fake)).toHaveLength(2);
});
