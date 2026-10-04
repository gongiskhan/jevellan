import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountSchema, AccountStatusSchema, CoordinatorEventSchema, DeviceRosterSchema, Homes, ProjectSchema, ProjectWorkSettingsSchema, SecretRedactor, defaultProjectWorkSettings,
  projectToolNames, seedConfiguration, type Account, type CoordinatorEvent, type ProjectLedgerEvent, type ProjectWorkSettings,
} from '../packages/core/dist/index.js';
import { StretchBridges } from '../packages/conversations/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forCoordinator, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { DEFAULT_PROJECT_TIMERS, ProjectWork, coordinatorSystemAppend, derivedId } from '../packages/projects/dist/index.js';

// The coordinator turn loop (brief 8.1, 8.6; design 3.2) in-process: the real hub store, FakeRuntime coordinator turns
// through a small bridge server, and injected timers. Thread events are enqueued directly (threads are covered elsewhere).

const at = '2026-10-03T10:00:00.000Z';
let root: string; let homes: Homes; let redactor: SecretRedactor; let hub: HubDatabase; let fake: FakeRuntime; let server: Server; let url: string;
let checkout: string; let project: ReturnType<typeof ProjectSchema.parse>; let works: ProjectWork[]; let bridges: StretchBridges;
let accounts: Account[]; let ineligible: Set<string>; let readOnly: boolean;
const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const account = (id: string, label: string) => AccountSchema.parse({ schema: 'account-v1', id, runtime: 'fake', label, kind: 'subscription', enabled: true, credential: 'per-device' });

function app(timers: Record<string, unknown> = {}): ProjectWork {
  fake.capabilities.readOnlyEnforced = readOnly;
  const work = new ProjectWork({ homes, deviceId: 'dev_a', deviceName: 'Mac mini', redactor, hub: new HubProjectAccess(hub, 'dev_a'),
    projects: { get: async (id: string) => id === project.id ? { schema: 'project-view-v1', revision: 1, project } : null, list: async () => [{ schema: 'project-view-v1', revision: 1, project }] } as never,
    github: { credential: async () => undefined },
    accounts: { list: async () => accounts.map((entry) => ({ schema: 'account-view-v1', revision: 1, account: entry,
      statuses: [AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: entry.id, deviceId: 'dev_a', auth: ineligible.has(entry.id) ? 'needs-login' : 'ready', observedAt: new Date().toISOString() })] })),
    resolve: async (id: string) => ({ account: accounts.find((entry) => entry.id === id)!, home: homes.ensure('homes', 'fake', id), env: {} }), markUsed: async () => undefined,
    recordUsage: async () => undefined as never, recordError: async () => undefined as never } as never,
    runtimes: new Map([['fake', fake]]), accountRuns: new Set(), bridges,
    memory: { project: () => ({ search: async () => ({ schema: 'memory-search-v1', notes: [] }), read: async () => { throw new Error('No note.'); } }) } as never,
    settings: async () => ({ ...seedConfiguration()['x-jevellan'], menu: [{ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model.',
      efforts: ['low', 'medium', 'high'], enabled: true }], runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, fake: { enabled: true } } }),
    riggingItems: async () => [],
    roster: async () => DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: 'dev_a', devices: [{ schema: 'device-view-v1', status: 'online', heartbeat: null, revoked: false,
      device: { schema: 'device-v1', id: 'dev_a', name: 'Mac mini', role: 'hub', url: 'http://127.0.0.1:9771', os: 'darwin', version: '0.1.0', joinedAt: at } }] }),
    enterOperation: () => () => undefined, timers: { periodic: false, coordinatorStartMs: 0, coordinatorRetryMs: 50, ...timers } });
  work.daemonUrl = url; works.push(work);
  return work;
}
async function started(timers: Record<string, unknown> = {}): Promise<ProjectWork> { const work = app(timers); await work.ready; work.start(); return work; }
const message = (work: ProjectWork, text: string, clientMessageId = `msg_${Math.random().toString(36).slice(2)}`) =>
  work.postMessage('proj_a', { schema: 'coordinator-message-request-v1', clientMessageId, text });
const event = (raw: Record<string, unknown>): CoordinatorEvent => CoordinatorEventSchema.parse({ schema: 'coordinator-event-v1', at, ...raw });
const published = (id: string, threadId: string, prNumber: number) => event({ kind: 'thread-published', id, threadId, result: 'pr-opened', prNumber });
const question = (id: string, threadId: string) => event({ kind: 'thread-report', id, threadId, report: { schema: 'thread-report-v1', turn: 1, status: 'needs-decision',
  summary: 'Need a database choice.', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], changedFiles: [], synthesized: false } });
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
const fail = (text: string): FakeTurnStep => () => ({ status: 'failed', error: { kind: 'other', message: text } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
const turns = (): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');
const ledger = (work: ProjectWork) => work.ledgers.coordinator('proj_a');
const payloads = (work: ProjectWork, type: ProjectLedgerEvent['type']) => ledger(work).events().filter((entry) => entry.type === type)
  .map((entry) => ledger(work).payload(entry as ProjectLedgerEvent & { type: typeof type }) as Record<string, unknown>);
const notices = (work: ProjectWork) => payloads(work, 'notice').map((data) => data.text);
const status = async () => (await new HubProjectAccess(hub, 'dev_a').coordinatorStatus('proj_a'))?.document;
async function settings(over: Partial<ProjectWorkSettings>): Promise<void> {
  const access = new HubProjectAccess(hub, 'dev_a'); const current = await access.settings('proj_a');
  await access.putSettings(ProjectWorkSettingsSchema.parse({ ...(current?.document ?? defaultProjectWorkSettings('proj_a')), ...over }), current?.revision ?? 0);
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-coordinator-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); redactor = new SecretRedactor(); works = [];
  checkout = join(root, 'project'); mkdirSync(checkout); run(checkout, 'init', '-b', 'main');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); run(checkout, 'add', '-A'); run(checkout, 'commit', '-m', 'Seed');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_a', name: 'Shop', paths: { dev_a: checkout }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' },
    context: { state: 'none' } });
  hub = new HubDatabase(homes, 'hub'); hub.put('projects', 'proj_a', ProjectSchema, project, 0);
  accounts = [account('acc_work', 'Work')]; ineligible = new Set(); readOnly = true;
  fake = new FakeRuntime(); bridges = new StretchBridges(redactor);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => {
      const authorization = request.headers.authorization;
      bridges.request(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')))
        .then((result) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); },
          (error: Error & { status?: number }) => { response.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ schema: 'error-v1', code: 'refused', message: error.message })); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const work of works) await work.close().catch(() => undefined);
  await fake.close(); await new Promise((resolve) => server.close(resolve)); await bridges.close(); hub.close();
  rmSync(root, { recursive: true, force: true });
});

test('one turn at a time: events during a turn arrive batched in the next, which resumes the session, until the queue is empty', { timeout: 60_000 }, async () => {
  expect(DEFAULT_PROJECT_TIMERS).toMatchObject({ coordinatorStartMs: 250, coordinatorRetryMs: 30_000, coordinatorTurnTimeoutMs: 1_200_000 });
  const work = await started();
  const gate = deferred(); const inside = deferred(); let tools: string[] = [];
  fake.enqueueTurn(async (turn) => { tools = await turn.tools(); inside.resolve(); await gate.promise; turn.say('Started two threads.'); return { status: 'completed' }; }, forCoordinator);
  fake.enqueueTurn(say('Both pull requests are open.'), forCoordinator);
  expect(await message(work, 'add A and fix B', 'msg_pj2')).toEqual({ repeated: false });
  await inside.promise;
  // The token works for exactly this turn's scope (D11).
  expect(tools.sort()).toEqual(projectToolNames({ kind: 'coordinator' }).sort());
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'running', session: { runtime: 'fake', modelId: 'fixture', effort: 'medium', accountId: 'acc_work', turns: 0 } });
  expect((await status())?.state).toBe('running');
  // Two events while the turn runs: they wait and go together in the next turn.
  await new HubProjectAccess(hub, 'dev_a').publishThread({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_a', projectId: 'proj_a', title: 'Add A', state: 'in-review',
    isolation: 'worktree', ownerDeviceId: 'dev_a', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Work', turns: 1, createdAt: at, updatedAt: at }, 1);
  work.coordinators.get('proj_a').enqueue(published('cev_pa', 'thread_a', 1));
  work.coordinators.get('proj_a').enqueue(published('cev_pb', 'thread_b', 2));
  expect(turns()).toHaveLength(1);
  gate.resolve(); await work.idle('proj_a');

  expect(turns()).toHaveLength(2);
  const [first, second] = turns();
  expect(first).toMatchObject({ owner: { kind: 'coordinator', projectId: 'proj_a', id: 'proj_a' }, turn: 1, permissions: 'read-only', safetyProfile: 'coordinator', cwd: checkout,
    model: 'scripted-model', effort: 'medium', timeoutMs: 1_200_000, systemAppend: coordinatorSystemAppend('Shop') });
  expect(first!.resume).toBeUndefined();
  expect(first!.prompt).toMatch(/^Project notebook:\n\(empty\)\n\nActive threads:\n\(none\)\n\nOpen questions to the owner:\n\(none\)\n\nRecent conversation with the owner:\n\(none\)\n\nEvents since your last turn:\n\[owner \d{2}:\d{2}\] add A and fix B$/);
  expect(second).toMatchObject({ turn: 2, resume: { sessionId: work.coordinators.get('proj_a').state().session!.nativeSessionId } });
  expect(second!.prompt).toBe('Events since your last turn:\n[thread "Add A" (thread_a)] Pull request #1 opened.\n[thread "(unknown thread)" (thread_b)] Pull request #2 opened.');
  const state = work.coordinators.get('proj_a').state();
  expect(state).toMatchObject({ state: 'idle', queue: [], failedTurnsInARow: 0, session: { turns: 2, accountId: 'acc_work' } });
  expect(state.lastTurnAt).toBeDefined();
  // Ledger: events on receipt (D2a), delivered ids on the turn start, the final text, and completed ends.
  const starts = payloads(work, 'coordinator-turn-start');
  expect(starts).toEqual([
    { schema: 'coordinator-turn-v1', turn: 1, fresh: true, runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Work', eventIds: [expect.stringMatching(/^cev_/)] },
    { schema: 'coordinator-turn-v1', turn: 2, fresh: false, runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Work', eventIds: ['cev_pa', 'cev_pb'] }]);
  expect(payloads(work, 'coordinator-text').map((data) => data.text)).toEqual(['Started two threads.', 'Both pull requests are open.']);
  expect(payloads(work, 'coordinator-turn-end')).toEqual([{ schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed' }, { schema: 'coordinator-turn-end-v1', turn: 2, status: 'completed' }]);
  expect(ledger(work).events().map((entry) => entry.type)).toEqual(['coordinator-event', 'coordinator-turn-start', 'coordinator-event', 'coordinator-event', 'coordinator-text',
    'coordinator-turn-end', 'coordinator-turn-start', 'coordinator-text', 'coordinator-turn-end']);
  expect(work.coordinators.store.local('proj_a').process).toBeUndefined();
  expect(await status()).toMatchObject({ state: 'idle', failedTurnsInARow: 0, session: { runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Work', turns: 2 } });
  // The native session id stays in coordinator.json: never in the hub status or the ledger.
  const sessionId = state.session!.nativeSessionId!;
  expect(JSON.stringify(await status())).not.toContain(sessionId);
  expect(ledger(work).events().map((entry) => JSON.stringify(entry)).join('\n')).not.toContain(sessionId);
  // Idempotent by client id (PJ2e): the same message repeats, other text under the id is refused, and no turn runs.
  expect(await message(work, 'add A and fix B', 'msg_pj2')).toEqual({ repeated: true });
  await expect(message(work, 'something else', 'msg_pj2')).rejects.toMatchObject({ status: 409, message: 'This message id was already used for different content.' });
  await work.idle('proj_a');
  expect(turns()).toHaveLength(2);
});

test('sessions rotate at 40 turns, on Fresh, on an effort change and when the account changes; otherwise turns resume', { timeout: 60_000 }, async () => {
  const work = await started();
  const coordinator = work.coordinators.get('proj_a');
  const next = async (text: string) => { fake.enqueueTurn(say('ok'), forCoordinator); await message(work, text); await work.idle('proj_a'); return turns().at(-1)!; };
  expect((await next('one')).resume).toBeUndefined();
  const session = coordinator.state().session!;
  expect((await next('two')).resume).toEqual({ sessionId: session.nativeSessionId });
  // At 40 turns the next turn starts a fresh session with the fresh context and counts from one again.
  work.coordinators.store.update('proj_a', (state) => ({ ...state, session: { ...state.session!, turns: 40 } }));
  const rotated = await next('three');
  expect(rotated.resume).toBeUndefined();
  expect(rotated.prompt).toMatch(/^Project notebook:\n\(empty\)\n\nActive threads:\n\(none\)\n\nOpen questions to the owner:\n\(none\)\n\nRecent conversation with the owner:\nOwner: one\n\nYou: ok\n\nOwner: two\n\nYou: ok\n\nEvents since your last turn:\n\[owner \d{2}:\d{2}\] three$/);
  expect(coordinator.state().session).toMatchObject({ turns: 1 });
  expect(coordinator.state().session!.nativeSessionId).not.toBe(session.nativeSessionId);
  expect(payloads(work, 'coordinator-turn-start').at(-1)).toMatchObject({ turn: 3, fresh: true });
  expect((await next('four')).resume).toEqual({ sessionId: coordinator.state().session!.nativeSessionId });
  // Fresh coordinator session (D77).
  await work.freshCoordinator('proj_a');
  expect(coordinator.state().session).toBeNull();
  const fresh = await next('five');
  expect(fresh.resume).toBeUndefined(); expect(fresh.prompt.startsWith('Project notebook:')).toBe(true);
  // The settings effort maps to another effort on the session model.
  await settings({ coordinator: { modelId: null, effort: 'low' } });
  const lower = await next('six');
  expect(lower).toMatchObject({ effort: 'low' }); expect(lower.resume).toBeUndefined();
  expect((await next('seven')).resume).toBeDefined();
  // The session's account is no longer eligible: another account, a fresh session and a notice (D16).
  accounts.push(account('acc_other', 'Other')); ineligible.add('acc_work');
  const moved = await next('eight');
  expect(moved.resume).toBeUndefined(); expect(moved.account.account.id).toBe('acc_other'); expect(moved.prompt.startsWith('Project notebook:')).toBe(true);
  expect(coordinator.state().session).toMatchObject({ accountId: 'acc_other', turns: 1 });
  expect(notices(work)).toEqual(['The coordinator moved to account Other; a fresh session started.']);
  expect(payloads(work, 'coordinator-turn-start').at(-1)).toMatchObject({ fresh: true, accountLabel: 'Other' });
  expect(payloads(work, 'coordinator-turn-start').map((data) => data.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  // Fresh while a turn runs: that turn completes but never writes its session back, so the next one starts fresh.
  const gate = deferred(); const inside = deferred();
  fake.enqueueTurn(async (turn) => { inside.resolve(); await gate.promise; turn.say('ok'); return { status: 'completed' }; }, forCoordinator);
  await message(work, 'nine'); await inside.promise;
  expect(turns().at(-1)!.resume).toBeDefined();
  await work.freshCoordinator('proj_a');
  gate.resolve(); await work.idle('proj_a');
  expect(coordinator.state()).toMatchObject({ session: null, queue: [] });
  expect((await next('ten')).resume).toBeUndefined();
});

test('a failed turn retries once with its events in front; after two failures the owner is told and only a message tries again', { timeout: 60_000 }, async () => {
  const work = await started();
  fake.enqueueTurn(fail('Model overloaded.'), forCoordinator);
  fake.enqueueTurn(fail('Model overloaded.'), forCoordinator);
  await message(work, 'plan the release');
  await work.idle('proj_a');
  const [first, retry] = turns();
  expect(turns()).toHaveLength(2);
  // The retry delivers the same batch, resuming the native session the failed turn opened.
  expect(retry!.prompt).toBe(first!.prompt.slice(first!.prompt.indexOf('Events since your last turn:')));
  expect(retry!.resume).toBeDefined();
  const [startOne, startTwo] = payloads(work, 'coordinator-turn-start');
  expect(startTwo!.eventIds).toEqual(startOne!.eventIds);
  const coordinator = work.coordinators.get('proj_a');
  expect(coordinator.state()).toMatchObject({ state: 'idle', failedTurnsInARow: 2 });
  expect(coordinator.state().queue.map((entry) => entry.kind)).toEqual(['user-message']);
  expect(coordinator.fallbackActive()).toBe(true);
  expect(payloads(work, 'coordinator-turn-end')).toEqual([{ schema: 'coordinator-turn-end-v1', turn: 1, status: 'failed', error: 'Model overloaded.' },
    { schema: 'coordinator-turn-end-v1', turn: 2, status: 'failed', error: 'Model overloaded.' }]);
  expect(notices(work)).toEqual(['The coordinator failed twice: Model overloaded. Send a message to try again.']);
  expect(await status()).toMatchObject({ state: 'idle', failedTurnsInARow: 2 });
  // A thread event does not start a third turn; its needs-decision question goes to the owner directly (decision 7).
  coordinator.enqueue(question('cev_q', 'thread_x'));
  await work.idle('proj_a');
  expect(turns()).toHaveLength(2);
  const asked = (await new HubProjectAccess(hub, 'dev_a').decisions('proj_a'));
  expect(asked).toEqual([expect.objectContaining({ id: derivedId('pdec', 'fallback', 'cev_q'), from: 'thread', threadId: 'thread_x', question: 'Which database?',
    options: [{ label: 'SQLite' }, { label: 'Postgres' }], createdAt: at })]);
  expect(work.coordinators.store.local('proj_a').fallbackEventIds).toEqual(['cev_q']);
  // The sweep retries nothing that already exists.
  await work.pulse(); await work.idle('proj_a');
  expect(await new HubProjectAccess(hub, 'dev_a').decisions('proj_a')).toHaveLength(1);
  // A message tries again; the report is delivered with the fallback suffix (D32), and success clears the failure count.
  fake.enqueueTurn(say('Planned.'), forCoordinator);
  await message(work, 'try again');
  await work.idle('proj_a');
  expect(turns()).toHaveLength(3);
  expect(turns()[2]!.prompt).toContain('[thread "(unknown thread)" (thread_x) reported needs-decision] Need a database choice.\nQuestion: Which database?\nOptions: SQLite; Postgres (Jevellan asked the owner directly.)');
  expect(turns()[2]!.prompt).toMatch(/\[owner \d{2}:\d{2}\] plan the release\n\[thread /);
  expect(coordinator.state()).toMatchObject({ state: 'idle', failedTurnsInARow: 0, queue: [] });
  expect(coordinator.fallbackActive()).toBe(false);
  expect(work.coordinators.store.local('proj_a').fallbackEventIds).toEqual([]);
  // A turn that runs out of time fails as timed out and is retried like any failure.
  await work.close();
  const quick = await started({ coordinatorTurnTimeoutMs: 200 });
  fake.enqueueTurn(async ({ signal }) => { await aborted(signal); return { status: 'completed' }; }, forCoordinator);
  fake.enqueueTurn(say('Done.'), forCoordinator);
  await message(quick, 'slow');
  await quick.idle('proj_a');
  expect(payloads(quick, 'coordinator-turn-end').at(-2)).toEqual({ schema: 'coordinator-turn-end-v1', turn: 4, status: 'timed-out', error: 'The coordinator turn timed out after 1 second.' });
  expect(payloads(quick, 'coordinator-turn-end').at(-1)).toMatchObject({ turn: 5, status: 'completed' });
  expect(quick.coordinators.get('proj_a').state()).toMatchObject({ failedTurnsInARow: 0, queue: [] });
});

test('Stop interrupts the running turn, whose events count as delivered; later events run next (D33)', { timeout: 60_000 }, async () => {
  const work = await started();
  await work.stopCoordinator('proj_a');
  const inside = deferred();
  fake.enqueueTurn(async ({ signal }) => { inside.resolve(); await aborted(signal); return { status: 'completed' }; }, forCoordinator);
  fake.enqueueTurn(say('Picked up the publication.'), forCoordinator);
  await message(work, 'refactor everything');
  await inside.promise;
  work.coordinators.get('proj_a').enqueue(published('cev_late', 'thread_a', 3));
  await work.stopCoordinator('proj_a');
  await work.idle('proj_a');
  expect(turns()).toHaveLength(2);
  expect(turns()[1]!.prompt).toBe('Events since your last turn:\n[thread "(unknown thread)" (thread_a)] Pull request #3 opened.');
  expect(payloads(work, 'coordinator-turn-end').map((data) => data.status)).toEqual(['interrupted', 'completed']);
  expect(payloads(work, 'coordinator-text').map((data) => data.text)).toEqual(['Picked up the publication.']);
  const state = work.coordinators.get('proj_a').state();
  expect(state).toMatchObject({ state: 'idle', queue: [], failedTurnsInARow: 0, session: { turns: 2 } });
  expect(work.coordinators.store.local('proj_a').process).toBeUndefined();
});

test('without a coordinator model or account the coordinator is unavailable with one notice, asks the owner directly, and runs once it can (D34, D70, D97)', { timeout: 60_000 }, async () => {
  readOnly = false;
  let work = await started();
  await message(work, 'first'); await message(work, 'second'); await work.idle('proj_a');
  expect(turns()).toHaveLength(0);
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'unavailable', unavailableReason: 'No enabled model can run the coordinator on Mac mini.' });
  expect(notices(work)).toEqual(['The coordinator cannot run: No enabled model can run the coordinator on Mac mini.']);
  expect(await status()).toMatchObject({ state: 'unavailable', unavailableReason: 'No enabled model can run the coordinator on Mac mini.', session: null });
  await work.close();

  // The model qualifies but no account can run it: the brief's text, a new notice for the new reason.
  readOnly = true; ineligible = new Set(['acc_work']);
  work = await started();
  await work.idle('proj_a');
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'unavailable', unavailableReason: 'No account can run the coordinator model on Mac mini.' });
  work.coordinators.get('proj_a').enqueue(question('cev_q', 'thread_x'));
  await message(work, 'third'); await work.idle('proj_a');
  expect(notices(work)).toEqual(['The coordinator cannot run: No enabled model can run the coordinator on Mac mini.',
    'The coordinator cannot run: No account can run the coordinator model on Mac mini.']);
  expect((await new HubProjectAccess(hub, 'dev_a').decisions('proj_a')).map((entry) => [entry.id, entry.from, entry.threadId]))
    .toEqual([[derivedId('pdec', 'fallback', 'cev_q'), 'thread', 'thread_x']]);
  expect(turns()).toHaveLength(0);

  // The account is back: the queue sweep (D70) runs one turn with every queued event.
  ineligible.clear();
  fake.enqueueTurn(say('Caught up.'), forCoordinator);
  await work.pulse(); await work.idle('proj_a');
  expect(turns()).toHaveLength(1);
  expect(turns()[0]!.prompt).toMatch(/\[owner \d{2}:\d{2}\] first\n\[owner \d{2}:\d{2}\] second\n\[thread "\(unknown thread\)" \(thread_x\) reported needs-decision\] Need a database choice\.\nQuestion: Which database\?\nOptions: SQLite; Postgres \(Jevellan asked the owner directly\.\)\n\[owner \d{2}:\d{2}\] third$/);
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'idle', queue: [] });
  expect('unavailableReason' in work.coordinators.get('proj_a').state()).toBe(false);
  expect(notices(work)).toHaveLength(2);

  // No checkout on this device (D34): the path sentence.
  project = ProjectSchema.parse({ ...project, paths: { dev_a: join(root, 'missing') } });
  await message(work, 'fourth'); await work.idle('proj_a');
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'unavailable', unavailableReason: `Project Shop isn't checked out on Mac mini at ${join(root, 'missing')}.` });
  expect(turns()).toHaveLength(1);
});

test('a restart drops the running turn, keeps its events queued, and the next start delivers them in a new turn (brief 8.6)', { timeout: 60_000 }, async () => {
  const work = await started();
  const inside = deferred();
  fake.enqueueTurn(async ({ signal }) => { inside.resolve(); await aborted(signal); return { status: 'completed' }; }, forCoordinator);
  await message(work, 'long plan');
  await inside.promise;
  const queued = work.coordinators.get('proj_a').state().queue.map((entry) => entry.id);
  await work.close();
  expect(work.coordinators.store.get('proj_a')).toMatchObject({ state: 'running' });

  fake.enqueueTurn(say('Resumed the plan.'), forCoordinator);
  const again = app();
  await again.ready;
  // Recovery: the turn is dropped, the process record cleared, nothing runs before start().
  expect(again.coordinators.get('proj_a').state()).toMatchObject({ state: 'idle' });
  expect(again.coordinators.get('proj_a').state().queue.map((entry) => entry.id)).toEqual(queued);
  expect(payloads(again, 'coordinator-turn-end')).toEqual([{ schema: 'coordinator-turn-end-v1', turn: 1, status: 'dropped' }]);
  expect(again.coordinators.store.local('proj_a').process).toBeUndefined();
  expect(turns()).toHaveLength(1);
  again.start(); await again.idle('proj_a');
  expect(turns()).toHaveLength(2);
  expect(payloads(again, 'coordinator-turn-start').map((data) => [data.turn, data.eventIds])).toEqual([[1, queued], [2, queued]]);
  expect(again.coordinators.get('proj_a').state()).toMatchObject({ state: 'idle', queue: [] });
  expect(payloads(again, 'coordinator-turn-end').at(-1)).toMatchObject({ turn: 2, status: 'completed' });
});

test('coordinator memory tools read project memory through the bridge and leave chat lines', { timeout: 60_000 }, async () => {
  const work = await started();
  const found: unknown[] = []; const refused: string[] = [];
  fake.enqueueTurn(async (turn) => {
    found.push(await turn.bridge('memory_search', { query: 'login' }));
    await turn.bridge('memory_read', { permalink: 'notes/login' }).catch((error: Error) => { refused.push(error.message); });
    await turn.bridge('memory_write', { title: 'Login', content: 'No.' }).catch((error: Error) => { refused.push(error.message); });
    turn.say('Nothing on login yet.'); return { status: 'completed' };
  }, forCoordinator);
  await message(work, 'What do we know about login?'); await work.idle('proj_a');
  expect(found).toEqual([{ schema: 'memory-search-v1', notes: [] }]);
  expect(refused).toEqual(['No note.', 'This turn cannot use that tool.']);
  expect(payloads(work, 'coordinator-tool')).toEqual([
    { schema: 'coordinator-tool-v1', tool: 'memory_search', ok: true, summary: 'Searched project memory' },
    { schema: 'coordinator-tool-v1', tool: 'memory_read', ok: false, summary: 'Could not read a project memory note: No note.' },
  ]);
});
