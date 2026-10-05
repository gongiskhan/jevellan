// Phase 5, Move coordinator here and the old device's handover (design 3.5.3, 3.5.4; D43, D76, D80, D269-D272): a hub fixture and a
// simulated member over real HTTP. The new device starts a fresh coordinator from the hub's notebook and indexes, the assignment
// fence keeps every later turn off the old device, and the old device hands its queue over at startup, at the fence or when a
// relayed event arrives. Simulated: the member device (local HTTP) and the runtime turns. Live: git, HTTP, the hub, the ledgers.
import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  CoordinatorStateSchema, DeviceSchema, ProjectEnvelopeSchema, ProjectWorkViewSchema, readDocument, writeDocument, type CoordinatorEvent, type ProjectLedgerEvent,
} from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { forCoordinator, type FakeRuntime, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import {
  PROJECT_NOT_FOUND, PROJECT_OPERATION_NOT_FOUND, coordinatorMovable, coordinatorMovedNotice, coordinatorWorking, type ProjectWork,
} from '../packages/projects/dist/index.js';
import { expectNoLeaks, holdStep, projectFixture, projectMember, type ProjectFixture, type ProjectMember } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => {
  try { if (fixture) await expectNoLeaks(fixture); } finally { await fixture?.close(); fixture = undefined; }
});
/** A hub whose fake runtime runs read-only coordinator turns, and a member whose fake does too (else its coordinator is unavailable, D97). */
async function setup(): Promise<{ f: ProjectFixture; m: ProjectMember }> {
  const f = fixture = await projectFixture({ coordinator: true });
  const m = await projectMember(f); m.fake.capabilities.readOnlyEnforced = true;
  return { f, m };
}

const pid = 'project';
const empty = { schema: 'empty-request-v1' };
const MOVE = `/api/projects/${pid}/coordinator/move`; const MESSAGES = `/api/projects/${pid}/coordinator/messages`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (text: string) => ({ schema: 'coordinator-message-request-v1', clientMessageId: `msg_${randomUUID()}`, text });
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
const ownerEvent = (id: string, text: string): CoordinatorEvent => ({ schema: 'coordinator-event-v1', kind: 'user-message', id, at: new Date().toISOString(), text, clientMessageId: `msg_${id}` });
const coordinatorTurns = (fake: FakeRuntime): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');
const view = (on: ProjectFixture | ProjectMember) => on.json(`/api/projects/${pid}/work`, ProjectWorkViewSchema);
/** The coordinator ledger's notices on a device. */
function notices(work: ProjectWork): string[] {
  const ledger = work.coordinatorLedger(pid);
  return ledger.events().filter((event) => event.type === 'notice').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'notice' }).text);
}
/** The ids of the coordinator events the hub holds for `deviceId`. */
function relayedTo(f: ProjectFixture, deviceId: string): string[] {
  return f.app.hub.list('project-envelopes', ProjectEnvelopeSchema).map((row) => row.document)
    .flatMap((envelope) => envelope.targetDeviceId === deviceId && envelope.body.kind === 'coordinator-event' ? [envelope.body.event.id] : []);
}
/** No heartbeat for an hour: the hub's roster reads the device offline (D80). */
function silence(f: ProjectFixture, deviceId: string): void {
  const row = f.app.hub.get('devices', deviceId, DeviceSchema)!;
  f.app.hub.put('devices', deviceId, DeviceSchema, { ...row.document, lastHeartbeatAt: new Date(Date.now() - 3_600_000).toISOString() }, row.revision);
}
function held(): { step: FakeTurnStep; release(): void } {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  return { step: holdStep(gate), release };
}

test('the move rule: a device that is gone, revoked or offline, or whose own status says it runs no turn, gives the coordinator up', () => {
  const online = { status: 'online', revoked: false } as const;
  expect(coordinatorMovable('dev_a', undefined, { deviceId: 'dev_a', state: 'running' })).toBe(true);
  expect(coordinatorMovable('dev_a', { status: 'offline', revoked: false }, { deviceId: 'dev_a', state: 'running' })).toBe(true);
  expect(coordinatorMovable('dev_a', { status: 'online', revoked: true }, { deviceId: 'dev_a', state: 'running' })).toBe(true);
  // A stale device keeps its state (D80): it may still be working.
  expect(coordinatorMovable('dev_a', { status: 'stale', revoked: false }, { deviceId: 'dev_a', state: 'running' })).toBe(false);
  expect(coordinatorMovable('dev_a', online, { deviceId: 'dev_a', state: 'running' })).toBe(false);
  expect(coordinatorMovable('dev_a', online, { deviceId: 'dev_a', state: 'idle' })).toBe(true);
  expect(coordinatorMovable('dev_a', online, { deviceId: 'dev_a', state: 'unavailable' })).toBe(true);
  // Nothing published yet, or a status a former coordinator device left: idle, as the chip shows it.
  expect(coordinatorMovable('dev_a', online, null)).toBe(true);
  expect(coordinatorMovable('dev_a', online, { deviceId: 'dev_b', state: 'running' })).toBe(true);
});

test('Move coordinator here is refused while the coordinator works and allowed once it is idle; the new device starts fresh from the hub notebook and indexes, postpones while the hub is unreachable, and the old device never runs a coordinator turn again', { timeout: 180_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId; const paths = f.app.projectWork.paths;

  // 1. A coordinator turn runs on the hub, which is online: the member may not take the coordinator (3.5.3).
  const turn = held(); f.fake.enqueueTurn(turn.step, forCoordinator);
  expect((await f.request(MESSAGES, 'POST', message('Plan the search page.'))).status).toBe(202);
  await f.waitFor(async () => (await f.app.projectHub.coordinatorStatus(pid))?.document.state, (state) => state === 'running');
  expect((await view(m)).coordinator).toMatchObject({ deviceId: hubId, deviceName: f.deviceName, state: 'running', online: true, canMoveHere: false });
  const refused = await m.request(MOVE, 'POST', empty);
  expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ schema: 'error-v1', code: 'conflict', message: coordinatorWorking(f.deviceName) });
  expect((await f.app.projectHub.coordinator(pid))?.document.deviceId).toBe(hubId);
  // Move runs on the device the owner uses: no peer path, and a project must exist.
  const token = f.cookie.slice(f.cookie.indexOf('=') + 1);
  const peer = await fetch(`${m.base}/api/mesh/projects/${pid}/coordinator/move`, { method: 'POST', body: JSON.stringify(empty),
    headers: { Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': hubId, 'Content-Type': 'application/json' } });
  expect(peer.status).toBe(404); expect(await peer.json()).toMatchObject({ message: PROJECT_OPERATION_NOT_FOUND });
  const unknown = await m.request('/api/projects/elsewhere/coordinator/move', 'POST', empty);
  expect(unknown.status).toBe(404); expect(await unknown.json()).toMatchObject({ message: PROJECT_NOT_FOUND });

  // 2. Idle again: the member's page offers the move and performs it. The member starts with no session and an empty queue, says
  // so in its chat and publishes its status; the hub keeps its history.
  turn.release(); await f.app.projectWork.idle();
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document.state).toBe('idle');
  expect((await view(m)).coordinator.canMoveHere).toBe(true); expect((await view(f)).coordinator.canMoveHere).toBe(false);
  expect((await f.request(`/api/projects/${pid}/notebook`, 'PUT', { schema: 'notebook-request-v1', expectedRevision: 0, content: 'Ship the search page first.' })).status).toBe(200);
  const revision = (await f.app.projectHub.coordinator(pid))!.revision;
  const moved = await m.request(MOVE, 'POST', empty);
  expect(moved.status).toBe(200);
  expect(ProjectWorkViewSchema.parse(await moved.json()).coordinator).toMatchObject({ deviceId: m.deviceId, deviceName: m.name, state: 'idle', online: true, canMoveHere: false, session: null });
  expect(await f.app.projectHub.coordinator(pid)).toMatchObject({ revision: revision + 1, document: { deviceId: m.deviceId } });
  expect(readDocument(m.app.projectWork.paths.coordinator(pid), CoordinatorStateSchema)).toMatchObject({ state: 'idle', session: null, queue: [], failedTurnsInARow: 0 });
  expect(notices(m.app.projectWork)).toEqual([coordinatorMovedNotice(m.name)]);
  await m.app.projectWork.idle();
  expect((await f.app.projectHub.coordinatorStatus(pid))?.document).toMatchObject({ deviceId: m.deviceId, state: 'idle', session: null });
  // A repeated move (its reply was lost) changes nothing; the hub's page now offers the move back.
  expect((await m.request(MOVE, 'POST', empty)).status).toBe(200);
  expect(notices(m.app.projectWork)).toHaveLength(1); expect((await f.app.projectHub.coordinator(pid))?.revision).toBe(revision + 1);
  expect((await view(f)).coordinator).toMatchObject({ deviceId: m.deviceId, deviceName: m.name, state: 'idle', online: true, canMoveHere: true });

  // 3. The owner writes on the hub's page: the message goes to the member, whose first turn is a fresh session built from the hub's
  // notebook and indexes, with a recap that starts empty (D43). The hub runs no coordinator turn.
  const hubTurns = coordinatorTurns(f.fake).length; expect(hubTurns).toBe(1);
  m.fake.enqueueTurn(say('Filters next.'), forCoordinator);
  expect((await f.request(MESSAGES, 'POST', message('Now add filters.'))).status).toBe(202);
  await f.waitFor(() => coordinatorTurns(m.fake).length, (count) => count === 1); await m.app.projectWork.idle();
  const fresh = coordinatorTurns(m.fake)[0]!;
  expect(fresh.resume).toBeUndefined(); expect(fresh.prompt.startsWith('Project notebook:\nShip the search page first.')).toBe(true);
  expect(fresh.prompt).toContain('Now add filters.'); expect(fresh.prompt).not.toContain('Plan the search page.');
  expect(coordinatorTurns(f.fake)).toHaveLength(hubTurns);

  // 4. D76: while the hub is unreachable the member's coordinator postpones its turns (the fence needs the hub); they run after.
  m.fake.enqueueTurn(say('Back again.'), forCoordinator);
  m.offline = true;
  m.app.projectWork.coordinators.get(pid).enqueue(ownerEvent('cev_outage', 'Written during the outage.'));
  await delay(400);
  expect(coordinatorTurns(m.fake)).toHaveLength(1);
  expect(m.app.projectWork.coordinators.get(pid).state().queue.map((event) => event.id)).toEqual(['cev_outage']);
  m.offline = false;
  await f.waitFor(() => coordinatorTurns(m.fake).length, (count) => count === 2); await m.app.projectWork.idle();
  expect(coordinatorTurns(m.fake)[1]).toMatchObject({ resume: { sessionId: expect.any(String) }, prompt: expect.stringContaining('Written during the outage.') });

  // 5. The hub never learned of the move. An event that still lands in its own queue meets the assignment fence: no turn runs
  // there, its coordinator state goes (the ledger stays), and the event reaches the member under its own id (3.5.4).
  expect(existsSync(paths.coordinator(pid))).toBe(true);
  m.fake.enqueueTurn(say('Handled.'), forCoordinator);
  f.app.projectWork.coordinators.get(pid).enqueue(ownerEvent('cev_fenced', 'Sent before the hub knew.'));
  await f.app.projectWork.idle();
  expect(existsSync(paths.coordinator(pid))).toBe(false); expect(coordinatorTurns(f.fake)).toHaveLength(hubTurns);
  expect(f.app.projectWork.outbox.pending()).toEqual([]); expect(relayedTo(f, m.deviceId)).toEqual(['cev_fenced']);
  expect(f.ledgerText()).toContain('Plan the search page.');
  await m.app.projectWork.pulse();
  await f.waitFor(() => coordinatorTurns(m.fake).length, (count) => count === 3); await m.app.projectWork.idle();
  expect(coordinatorTurns(m.fake)[2]!.prompt).toContain('Sent before the hub knew.');
  expect(relayedTo(f, m.deviceId)).toEqual([]);

  // 6. A hub that went down before it learned of the move (its coordinator state still holds a queued event, after two failed turns
  // so no turn would even try) reads the assignment at startup, hands the event over through the relay and keeps no coordinator
  // state; still no coordinator turn runs there.
  await f.restart(() => {
    writeDocument(paths.coordinator(pid), CoordinatorStateSchema, { schema: 'coordinator-state-v1', projectId: pid, state: 'idle', session: null,
      queue: [ownerEvent('cev_restart', 'Left on the hub.')], failedTurnsInARow: 2 });
  });
  await f.app.projectWork.idle();
  expect(existsSync(paths.coordinator(pid))).toBe(false); expect(coordinatorTurns(f.fake)).toHaveLength(hubTurns);
  expect(relayedTo(f, m.deviceId)).toEqual(['cev_restart']);
  expect((await view(f)).coordinator).toMatchObject({ deviceId: m.deviceId, state: 'idle', canMoveHere: true });
});

test('an offline coordinator device: the hub takes the coordinator over, events relayed to the gone device follow the move, and the device that returns stops its turn and hands its queue over', { timeout: 180_000 }, async () => {
  const { f, m } = await setup();
  const hubId = f.app.device.deviceId; const memberPaths = m.app.projectWork.paths;

  // 1. Before any assignment Move assigns the member as a first message would (D6): no notice, no state yet.
  const first = await m.request(MOVE, 'POST', empty);
  expect(first.status).toBe(200);
  expect(ProjectWorkViewSchema.parse(await first.json()).coordinator).toMatchObject({ deviceId: m.deviceId, state: 'idle', canMoveHere: false });
  expect(notices(m.app.projectWork)).toEqual([]); expect(existsSync(memberPaths.coordinator(pid))).toBe(false);
  // A member coordinator turn is held; a second owner message waits behind it.
  const turn = held(); m.fake.enqueueTurn(turn.step, forCoordinator);
  expect((await m.request(MESSAGES, 'POST', message('First.'))).status).toBe(202);
  await f.waitFor(async () => (await f.app.projectHub.coordinatorStatus(pid))?.document.state, (state) => state === 'running');
  expect((await m.request(MESSAGES, 'POST', message('Second.'))).status).toBe(202);
  // A hub event for the member's coordinator waits on the hub (the member has not polled).
  f.app.projectWork.outbox.enqueue(pid, 'coordinator', { kind: 'coordinator-event', event: ownerEvent('cev_relayed', 'Relayed to the member.') });
  await f.app.projectWork.outbox.drain();
  expect(relayedTo(f, m.deviceId)).toEqual(['cev_relayed']);

  // 2. The member stops reporting: after 10 minutes without a heartbeat it is offline (D80), and the hub may take the coordinator
  // over although the member's last status says it works.
  silence(f, m.deviceId);
  expect((await view(f)).coordinator).toMatchObject({ deviceId: m.deviceId, deviceName: m.name, state: 'offline', online: false, canMoveHere: true });
  f.fake.enqueueTurn(say('Taking over.'), forCoordinator);
  const moved = await f.request(MOVE, 'POST', empty);
  expect(moved.status).toBe(200);
  expect(ProjectWorkViewSchema.parse(await moved.json()).coordinator).toMatchObject({ deviceId: hubId, state: 'idle', canMoveHere: false, session: null });
  expect(notices(f.app.projectWork)).toEqual([coordinatorMovedNotice(f.deviceName)]);
  // The event relayed to the gone device moved with the coordinator (D270), and the hub reads it at once: its first turn is fresh and
  // delivers it (tests/project-hub-store.test.ts covers the sender's retry of the old envelope).
  expect(relayedTo(f, m.deviceId)).toEqual([]);
  await f.waitFor(() => coordinatorTurns(f.fake).length, (count) => count === 1); await f.app.projectWork.idle();
  expect(relayedTo(f, hubId)).toEqual([]);
  expect(coordinatorTurns(f.fake)[0]).toMatchObject({ prompt: expect.stringContaining('Relayed to the member.') }); expect(coordinatorTurns(f.fake)[0]!.resume).toBeUndefined();

  // 3. The member returns with its turn still running. An envelope the relay still brings it (a device that resolved the old
  // coordinator before the move) makes it hand over: the running turn stops (its batch counts as delivered, D33), the waiting
  // message and the event go to the hub under their own ids, and its coordinator state goes while its ledger stays.
  await m.heartbeat();
  // The two events may reach the hub in one turn or two.
  f.fake.enqueueTurn(say('Caught up.'), forCoordinator); f.fake.enqueueTurn(say('Caught up again.'), forCoordinator);
  await new HubProjectAccess(f.app.hub, hubId).putEnvelope({ schema: 'project-envelope-v1', revision: 0, id: 'env_late', projectId: pid, sourceDeviceId: hubId,
    targetDeviceId: m.deviceId, seq: 1000, createdAt: new Date().toISOString(), body: { kind: 'coordinator-event', event: ownerEvent('cev_late', 'Late for the member.') } });
  await m.app.projectWork.inbox.poll(); await m.app.projectWork.idle();
  expect(existsSync(memberPaths.coordinator(pid))).toBe(false); expect(coordinatorTurns(m.fake)).toHaveLength(1);
  const memberLedger = m.app.projectWork.coordinatorLedger(pid);
  expect(memberLedger.events().filter((event) => event.type === 'coordinator-turn-end').map((event) => memberLedger.payload(event as ProjectLedgerEvent & { type: 'coordinator-turn-end' }).status))
    .toEqual(['interrupted']);
  expect(m.app.projectWork.outbox.pending()).toEqual([]); expect(relayedTo(f, m.deviceId)).toEqual([]);
  await f.waitFor(async () => { await f.app.projectWork.pulse(); return coordinatorTurns(f.fake).slice(1).map((input) => input.prompt).join('\n'); },
    (prompts) => prompts.includes('Second.') && prompts.includes('Late for the member.'));
  await f.app.projectWork.idle();
  const later = coordinatorTurns(f.fake).slice(1).map((input) => input.prompt).join('\n');
  expect(later).not.toContain('First.'); expect(coordinatorTurns(f.fake)[1]!.resume).toBeDefined();
  // Back online and idle, the member's page offers the move back; the hub's own page does not.
  expect((await view(m)).coordinator).toMatchObject({ deviceId: hubId, state: 'idle', online: true, canMoveHere: true });
  // What the member handed over no longer counts as received there (D271): had the coordinator come back before the hub delivered
  // it, the member would take it again. Here the member's fence sends it on once more and the hub, which delivered it, drops it.
  const second = memberLedger.events().filter((event) => event.type === 'coordinator-event').map((event) => memberLedger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }))
    .find((event) => event.kind === 'user-message' && event.text === 'Second.')!;
  expect(m.app.projectWork.coordinators.store.local(pid).forwardedEventIds).toEqual([second.id, 'cev_late']);
  expect(m.app.projectWork.coordinators.get(pid).enqueue(second)).toEqual({ repeated: false });
  await m.app.projectWork.idle(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect(existsSync(memberPaths.coordinator(pid))).toBe(false); expect(coordinatorTurns(m.fake)).toHaveLength(1);
  expect(f.app.projectWork.coordinators.get(pid).state().queue).toEqual([]); expect(relayedTo(f, hubId)).toEqual([]);
  turn.release();
});

test('a coordinator that failed twice gives the coordinator up: its waiting message reaches the new device at its next sweep', { timeout: 120_000 }, async () => {
  const { f, m } = await setup();
  // Two failed turns (no scripted turn remains): the hub's coordinator waits for the owner's next message, with this one queued.
  expect((await f.request(MESSAGES, 'POST', message('Try the other model.'))).status).toBe(202);
  await f.waitFor(() => f.coordinatorState().failedTurnsInARow, (count) => count === 2); await f.app.projectWork.idle();
  expect(f.coordinatorState()).toMatchObject({ state: 'idle', queue: [{ kind: 'user-message', text: 'Try the other model.' }] });
  expect((await view(m)).coordinator).toMatchObject({ state: 'idle', canMoveHere: true });
  m.fake.enqueueTurn(say('On it.'), forCoordinator);
  expect((await m.request(MOVE, 'POST', empty)).status).toBe(200);
  // No turn will start on the hub, so its sweep reads the assignment for the stalled coordinator and hands the message over (D271).
  await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect(existsSync(f.app.projectWork.paths.coordinator(pid))).toBe(false); expect(coordinatorTurns(f.fake)).toHaveLength(2);
  await m.app.projectWork.pulse();
  await f.waitFor(() => coordinatorTurns(m.fake).length, (count) => count === 1); await m.app.projectWork.idle();
  expect(coordinatorTurns(m.fake)[0]!.prompt).toContain('Try the other model.'); expect(coordinatorTurns(m.fake)[0]!.resume).toBeUndefined();
  expect(coordinatorTurns(f.fake)).toHaveLength(2);
});
