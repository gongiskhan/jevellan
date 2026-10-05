import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountSchema, AccountStatusSchema, DeviceRosterSchema, Homes, HubUnavailable, PlacementRecordSchema, ProjectSchema, ProjectWorkSettingsSchema, SecretRedactor, ThreadSchema,
  defaultProjectWorkSettings, seedConfiguration, type CoordinatorEvent, type OutboxEntry, type ProjectEnvelope, type Project, type ProjectDecision, type ProjectWorkSettings, type Thread,
  type ThreadIndex,
} from '../packages/core/dist/index.js';
import { StretchBridges } from '../packages/conversations/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forThread, groupAlive, processIdentity, type FakeTurnStep } from '../packages/runtime-contract/dist/index.js';
import {
  ALLOW_MORE_TURNS, DISCARD_REFUSED, LEAVE_GIT_SETTING, LocalDelivery, MAIN_NOT_AVAILABLE, NO_CHANGES, NO_RELAY, OWNER_STOPPED_THREAD, ProjectWork, RESTARTED, RESTART_UNCONFIRMED,
  START_REQUEST_REUSED, STOP_THE_THREAD, THREAD_ENDED, TURN_FAILED, TURN_LIMIT_REACHED, TURN_TIMED_OUT, TURN_WITHOUT_REPORT, WORKTREE_DISCARDED, atTurnLimit,
  coordinatorPlan, decisionLists, deliveryRoute, derivedId, discardedReason, effectiveSettings, isDiscarded, isTurnLimitItem, isWaitingForSlot, messagesTurn,
  ownerStartedLine, pullRequestEntries, queuedReason, synthesizedReport, turnEndAction, turnLimitQuestion, waitingForSlotReason, withState, workCounts,
} from '../packages/projects/dist/index.js';
import { startGitHubFixture, type GitHubFixture } from './fixtures/github-server.mjs';

const at = '2026-10-03T10:00:00.000Z';
const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'fake', modelId: 'fixture',
  model: 'scripted-model', effortRequested: 'high', effortEffective: 'high', deviceId: 'dev_a', accountId: 'acc_fixture', eligibleModels: ['fixture'], excludedModels: [],
  eligibleDevices: ['dev_a'], excludedDevices: [], jevCalls: [], decidedAt: at });
const sample = (over: Partial<Thread> = {}): Thread => ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_a', projectId: 'proj_a', title: 'Add greeting', task: 'Create it.',
  createdAt: at, createdBy: 'owner', state: 'idle', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a', cwd: '/w', baseBranch: 'main',
  baseCommit: 'a'.repeat(40), turns: 1, turnAllowance: 5, queuedMessages: [], verificationAttempts: 0, ...over });
const message = (id: string, from: 'owner' | 'coordinator', text: string) => ({ id, from, text, at, interrupt: false });

test('turn ends follow the D73 order, synthesized reports carry the turn outcome, and messages route by state (2.6.9)', () => {
  const report = (status: 'progress' | 'done' | 'needs-decision' | 'blocked', question?: string) => ({ status, ...(question ? { question } : {}) });
  // done publishes, even at the limit; any other report at the limit waits for the owner.
  expect(turnEndAction(sample({ turns: 5 }), report('done'))).toEqual({ kind: 'publish' });
  for (const status of ['progress', 'blocked', 'needs-decision'] as const) expect(turnEndAction(sample({ turns: 5, queuedMessages: [message('m1', 'owner', 'x')] }), report(status, 'Which?'))).toEqual({ kind: 'limit' });
  expect(turnEndAction(sample(), report('needs-decision', `Which database?\nPostgres or SQLite.${'x'.repeat(500)}`))).toEqual({ kind: 'decision', reason: 'Which database?' });
  // Progress and blocked continue with queued messages (D72), else rest.
  expect(turnEndAction(sample({ queuedMessages: [message('m1', 'owner', 'x')] }), report('blocked'))).toEqual({ kind: 'continue' });
  expect(turnEndAction(sample(), report('progress'))).toEqual({ kind: 'idle' });
  expect(atTurnLimit({ turns: 4, turnAllowance: 5 })).toBe(false); expect(atTurnLimit({ turns: 5, turnAllowance: 5 })).toBe(true);

  expect(synthesizedReport({ status: 'completed', finalText: 'x'.repeat(1500) }, 3)).toEqual({ schema: 'thread-report-v1', turn: 3, status: 'progress', summary: 'x'.repeat(1200), changedFiles: [], synthesized: true });
  expect(synthesizedReport({ status: 'completed', finalText: '' }, 1).summary).toBe(TURN_WITHOUT_REPORT);
  expect(synthesizedReport({ status: 'failed', error: 'You have hit your limit.' }, 2)).toMatchObject({ status: 'blocked', summary: 'You have hit your limit.', synthesized: true });
  expect(synthesizedReport({ status: 'failed' }, 2).summary).toBe(TURN_FAILED);
  expect(synthesizedReport({ status: 'timed-out' }, 2).summary).toBe(TURN_TIMED_OUT);
  expect(synthesizedReport({ status: 'unavailable', error: 'No account can run Fixture on Mac mini right now: x.' }, 2)).toMatchObject({ status: 'blocked', summary: 'No account can run Fixture on Mac mini right now: x.' });
  expect(synthesizedReport({ status: 'failed', error: 'e'.repeat(2000) }, 2).summary).toHaveLength(1200);

  expect(['done', 'stopped', 'failed'].map((state) => deliveryRoute(state as Thread['state']))).toEqual(['ended', 'ended', 'ended']);
  expect(deliveryRoute('running')).toBe('running');
  expect(['idle', 'in-review', 'waiting-for-you'].map((state) => deliveryRoute(state as Thread['state']))).toEqual(['rest', 'rest', 'rest']);
  expect(['queued', 'preparing', 'publishing', 'attached'].map((state) => deliveryRoute(state as Thread['state']))).toEqual(['later', 'later', 'later', 'later']);
  // One message as is, several with their senders (D22); the ids leave the queue with the turn.
  expect(messagesTurn(sample({ queuedMessages: [message('m1', 'owner', 'Carry on.')] }), 'messages')).toEqual({ reason: 'messages', body: 'Carry on.', messages: ['m1'] });
  expect(messagesTurn(sample({ queuedMessages: [message('m1', 'coordinator', 'A'), message('m2', 'owner', 'B')] }), 'steer'))
    .toEqual({ reason: 'steer', body: 'From the coordinator:\nA\n\n---\n\nFrom the owner:\nB', messages: ['m1', 'm2'] });

  const waiting = withState(sample({ stateReason: 'Old.' }), 'running');
  expect(waiting.state).toBe('running'); expect('stateReason' in waiting).toBe(false);
  expect(withState(sample(), 'idle', 'r'.repeat(500)).stateReason).toHaveLength(400);
  expect(discardedReason('Stopped by you.')).toBe('Stopped by you. Worktree discarded.'); expect(discardedReason(undefined)).toBe('Worktree discarded.');
  expect(discardedReason('s'.repeat(400))).toHaveLength(400); expect(isDiscarded(discardedReason('s'.repeat(400)))).toBe(true); expect(isDiscarded('Stopped by you.')).toBe(false);
  expect(WORKTREE_DISCARDED).toBe(' Worktree discarded.');
  expect(isWaitingForSlot(waitingForSlotReason(4, 'Mac mini'))).toBe(true); expect(isWaitingForSlot(queuedReason(4, null))).toBe(false); expect(isWaitingForSlot(undefined)).toBe(false);
});

const decision = (over: Partial<ProjectDecision>): ProjectDecision => ({ schema: 'project-decision-v1', revision: 1, id: 'pdec_1', projectId: 'proj_a', from: 'thread', question: 'Q?', options: [], createdAt: at, ...over });
const index = (id: string, state: ThreadIndex['state'], over: Partial<ThreadIndex> = {}): ThreadIndex => ({ schema: 'project-thread-index-v1', revision: 1, id, projectId: 'proj_a', title: id,
  state, isolation: 'worktree', ownerDeviceId: 'dev_a', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Work', turns: 1, createdAt: at, updatedAt: at, ...over });

test('views count work, list pull requests and questions, coerce a Leave git default, and the coordinator plan follows the null rule (D91, D97)', () => {
  const limit = decision({ id: 'pdec_limit', options: [{ label: ALLOW_MORE_TURNS }, { label: STOP_THE_THREAD }] });
  expect(isTurnLimitItem(limit)).toBe(true);
  expect(isTurnLimitItem({ ...limit, from: 'coordinator' })).toBe(false); expect(isTurnLimitItem({ ...limit, options: [{ label: STOP_THE_THREAD }, { label: ALLOW_MORE_TURNS }] })).toBe(false);
  const answered = Array.from({ length: 12 }, (_, n) => decision({ id: `pdec_a${n}`, answer: { optionLabel: 'x' }, answeredAt: `2026-10-03T10:${String(n).padStart(2, '0')}:00.000Z` }));
  const lists = decisionLists([limit, decision({ id: 'pdec_w', withdrawnAt: at }), ...answered]);
  expect(lists.open.map((entry) => entry.id)).toEqual(['pdec_limit']); expect(lists.answered.map((entry) => entry.id)).toEqual(answered.slice(2).reverse().map((entry) => entry.id));
  const threads = [index('thread_1', 'running'), index('thread_2', 'waiting-for-you'), index('thread_3', 'in-review', { pr: { number: 4, url: 'https://github.com/o/r/pull/4', state: 'open', headSha: 'a', checks: 'passing', mergeable: 'clean', updatedAt: at }, branch: 'jv/x-1' }),
    index('thread_4', 'idle', { branch: 'jv/y-2', stateReason: 'Branch pushed. Add a GitHub token in Settings → Git to open pull requests.' }), index('thread_5', 'idle', { branch: 'jv/z-3', stateReason: 'Tests failed three times.' }), index('thread_6', 'done')];
  // The sidebar's running count is live work only: the waiting and idle threads are listed under Running but never counted (D257).
  expect(workCounts(threads, [limit])).toEqual({ waiting: 1, running: 1, inReview: 1 });
  expect(workCounts([index('thread_p', 'preparing'), index('thread_u', 'publishing'), index('thread_q', 'queued'), index('thread_a', 'attached')], [])).toEqual({ waiting: 0, running: 2, inReview: 0 });
  expect(pullRequestEntries(threads)).toEqual([{ threadId: 'thread_3', title: 'thread_3', branch: 'jv/x-1', pr: threads[2]!.pr },
    { threadId: 'thread_4', title: 'thread_4', branch: 'jv/y-2', reason: 'Branch pushed. Add a GitHub token in Settings → Git to open pull requests.' }]);
  const main = ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('proj_a'), defaultIsolation: 'main' });
  expect(effectiveSettings(main, { branchPolicy: 'external' })).toEqual({ settings: { ...main, defaultIsolation: 'worktree' }, notice: LEAVE_GIT_SETTING });
  // Main isolation is gated until phase 6 (D88): a main default reads as worktree with the phase text; Leave git still wins above.
  expect(effectiveSettings(main, { branchPolicy: 'main' })).toEqual({ settings: { ...main, defaultIsolation: 'worktree' }, notice: MAIN_NOT_AVAILABLE });
  expect(effectiveSettings(main, { branchPolicy: 'external' }, { mainIsolation: true })).toEqual({ settings: { ...main, defaultIsolation: 'worktree' }, notice: LEAVE_GIT_SETTING });
  expect(effectiveSettings(main, { branchPolicy: 'main' }, { mainIsolation: true })).toEqual({ settings: main });
  expect(effectiveSettings(defaultProjectWorkSettings('proj_a'), { branchPolicy: 'external' })).toEqual({ settings: defaultProjectWorkSettings('proj_a') });

  const config = { ...seedConfiguration()['x-jevellan'], menu: [
    { id: 'writer', runtime: 'fake', model: 'w', label: 'Writer', description: 'd', efforts: ['high' as const], enabled: true },
    { id: 'reader', runtime: 'fake', model: 'r', label: 'Reader', description: 'd', efforts: ['low' as const, 'medium' as const], enabled: true },
  ], runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, fake: { enabled: true } } };
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_a', runtime: 'fake', label: 'Work', kind: 'subscription', enabled: true, credential: 'per-device' });
  const ready = AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: 'acc_a', deviceId: 'dev_a', auth: 'ready', observedAt: at });
  const runtimes = (readOnlyEnforced: boolean) => new Map([['fake', { mcp: true, readOnlyEnforced, edit: true, shell: true, turns: true }]]);
  const work = (modelId: string | null) => ({ coordinator: { modelId, effort: 'medium' as const } });
  const plan = (o: Partial<Parameters<typeof coordinatorPlan>[0]> = {}) => coordinatorPlan({ work: work(null), settings: config, runtimes: runtimes(true), accounts: [account], statuses: [ready],
    deviceId: 'dev_a', deviceName: 'Mac mini', now: Date.parse(at), ...o });
  expect(plan()).toMatchObject({ kind: 'ready', model: { id: 'writer' }, effort: 'high', account: { id: 'acc_a' } });
  expect(plan({ work: work('reader') })).toMatchObject({ kind: 'ready', model: { id: 'reader' }, effort: 'medium' });
  expect(plan({ runtimes: runtimes(false) })).toEqual({ kind: 'unavailable', reason: 'No enabled model can run the coordinator on Mac mini.' });
  expect(plan({ statuses: [{ ...ready, auth: 'needs-login' }] })).toEqual({ kind: 'unavailable', reason: 'No account can run the coordinator model on Mac mini.' });
  expect(derivedId('cev', 'answer', 'pdec_1')).toBe(derivedId('cev', 'answer', 'pdec_1')); expect(derivedId('cev', 'answer', 'pdec_1')).toMatch(/^cev_[0-9a-f]{40}$/);
});

test('delivery runs local work here and sends other devices\' work through the relay, and needs a relay for them (D265)', async () => {
  const created: string[] = []; const queued: string[] = []; const applied: string[] = [];
  const local = { create: (thread: Thread) => { created.push(thread.id); return thread; } };
  const coordinator = { enqueue: (event: CoordinatorEvent) => { queued.push(event.id); return { repeated: false }; } };
  const bare = new LocalDelivery({ deviceId: 'dev_a', coordinators: { get: () => coordinator as never, deviceOf: async () => 'dev_b' }, store: local, command: async () => undefined });
  await expect(bare.startOnDevice(sample({ ownerDeviceId: 'dev_b' }), { modelLabel: 'Fixture', accountLabel: 'Work' })).rejects.toThrow(NO_RELAY);
  await expect(bare.toThreadOwner('proj_a', 'thread_a', 'dev_b', { type: 'allow-turns' })).rejects.toThrow(NO_RELAY);
  await bare.startOnDevice(sample(), { modelLabel: 'Fixture', accountLabel: 'Work' });
  expect(created).toEqual(['thread_a']);

  // With the relay: the hub assignment decides where coordinator events go, and starts and commands go to their owner.
  const sent: Array<{ projectId: string; target: string; body: ProjectEnvelope['body'] }> = []; const waiting: OutboxEntry[] = [];
  const hub = { assigned: 'dev_b' as string | null, down: false };
  const delivery = new LocalDelivery({ deviceId: 'dev_a', store: local, now: () => Date.parse(at),
    coordinators: { get: () => coordinator as never, deviceOf: async () => { if (hub.down) throw new HubUnavailable('Fixture hub'); return hub.assigned; } },
    command: async (_projectId, threadId, command) => { applied.push(`${threadId} ${command.type}`); },
    outbox: () => ({ enqueue: (projectId: string, target: string, body: ProjectEnvelope['body']) => { sent.push({ projectId, target, body }); return undefined as never; }, pending: () => waiting }) });
  const event = (id: string): CoordinatorEvent => ({ schema: 'coordinator-event-v1', kind: 'thread-interrupted', id, at, threadId: 'thread_a', reason: 'stopped', message: 'Stopped.' });
  await delivery.toCoordinator('proj_a', event('cev_elsewhere'));
  hub.assigned = 'dev_a'; await delivery.toCoordinator('proj_a', event('cev_here'));
  hub.assigned = null; await delivery.toCoordinator('proj_a', event('cev_none'));
  // The hub unreachable: the last assignment read decides; never read means the relay, which resolves it later.
  hub.assigned = 'dev_a'; await delivery.toCoordinator('proj_a', event('cev_known')); hub.down = true;
  await delivery.toCoordinator('proj_a', event('cev_down_here')); await delivery.toCoordinator('proj_other', event('cev_down_unknown'));
  // Coordinator events waiting in the outbox keep the ones after them in order, even for a coordinator here.
  hub.down = false; waiting.push({ schema: 'project-outbox-entry-v1', target: 'coordinator', envelope: { schema: 'project-envelope-v1', id: 'env_w', projectId: 'proj_a', sourceDeviceId: 'dev_a',
    seq: 1, createdAt: at, body: { kind: 'coordinator-event', event: event('cev_waiting') } } });
  await delivery.toCoordinator('proj_a', event('cev_behind'));
  expect(queued).toEqual(['cev_here', 'cev_none', 'cev_known', 'cev_down_here']);
  expect(sent.map((entry) => [entry.projectId, entry.target, entry.body.kind === 'coordinator-event' ? entry.body.event.id : ''])).toEqual([
    ['proj_a', 'coordinator', 'cev_elsewhere'], ['proj_other', 'coordinator', 'cev_down_unknown'], ['proj_a', 'coordinator', 'cev_behind']]);
  sent.length = 0;
  await delivery.startOnDevice(sample({ id: 'thread_b', ownerDeviceId: 'dev_b' }), { modelLabel: 'Fixture', accountLabel: 'Work' });
  await delivery.toThreadOwner('proj_a', 'thread_b', 'dev_b', { type: 'allow-turns' }, 'tcmd_given');
  await delivery.toThreadOwner('proj_a', 'thread_b', 'dev_b', { type: 'stop', reason: 'Not needed.', notify: true });
  await delivery.toThreadOwner('proj_a', 'thread_a', 'dev_a', { type: 'dispatch' });
  expect(sent.map((entry) => [entry.target, entry.body.kind])).toEqual([['dev_b', 'thread-start'], ['dev_b', 'thread-command'], ['dev_b', 'thread-command']]);
  expect(sent[1]!.body).toEqual({ kind: 'thread-command', threadId: 'thread_b', commandId: 'tcmd_given', command: { type: 'allow-turns' } });
  expect(sent[2]!.body).toMatchObject({ kind: 'thread-command', threadId: 'thread_b', commandId: expect.stringMatching(/^tcmd_/), command: { type: 'stop', notify: true } });
  expect(applied).toEqual(['thread_a dispatch']); expect(created).toEqual(['thread_a']);
});

// In-process Projects on a real git origin, the real hub store, FakeRuntime turns through a bridge server, and fake GitHub.
let root: string; let homes: Homes; let redactor: SecretRedactor; let hub: HubDatabase; let fake: FakeRuntime; let github: GitHubFixture; let server: Server; let url: string;
let origin: string; let checkout: string; let project: Project; let works: ProjectWork[]; let bridges: StretchBridges;
function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_fixture', runtime: 'fake', label: 'Work', kind: 'subscription', enabled: true, credential: 'per-device' });
function app(timers: Record<string, unknown> = {}): ProjectWork {
  const access = new HubProjectAccess(hub, 'dev_a');
  const work = new ProjectWork({ homes, deviceId: 'dev_a', deviceName: 'Mac mini', redactor, hub: access,
    projects: { get: async (id: string) => id === project.id ? { schema: 'project-view-v1', revision: 1, project } : null, list: async () => [{ schema: 'project-view-v1', revision: 1, project }] } as never,
    github: { credential: async () => token, baseUrl: github.url },
    accounts: { list: async () => [{ schema: 'account-view-v1', revision: 1, account, statuses: [AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: 'acc_fixture', deviceId: 'dev_a', auth: 'ready', observedAt: new Date().toISOString() })] }],
      resolve: async () => ({ account, home: homes.ensure('homes', 'fake', 'acc_fixture'), env: {} }), markUsed: async () => undefined, recordUsage: async () => undefined as never, recordError: async () => undefined as never } as never,
    runtimes: new Map([['fake', fake]]), accountRuns: new Set(), bridges,
    memory: { project: () => ({ search: async () => ({ schema: 'memory-search-v1', notes: [] }), read: async () => { throw new Error('No note.'); } }) } as never,
    settings: async () => ({ ...seedConfiguration()['x-jevellan'], menu: [{ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model.', efforts: ['high'], enabled: true }],
      runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, fake: { enabled: true } } }),
    riggingItems: async () => [],
    roster: async () => DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: 'dev_a', devices: [{ schema: 'device-view-v1', status: 'online', heartbeat: null, revoked: false,
      device: { schema: 'device-v1', id: 'dev_a', name: 'Mac mini', role: 'hub', url: 'http://127.0.0.1:9771', os: 'darwin', version: '0.1.0', joinedAt: at } }] }),
    enterOperation: () => () => undefined, timers: { periodic: false, ...timers } });
  work.daemonUrl = url; works.push(work);
  return work;
}
let token: string | undefined;
const settle = async (work: ProjectWork) => { await work.idle('proj_a'); };
async function waitFor<T>(read: () => T, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = read(); if (accept(value)) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value)}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
const queue = (work: ProjectWork) => work.coordinators.get('proj_a').state().queue;
const kinds = (events: CoordinatorEvent[]) => events.map((event) => event.kind === 'thread-report' ? `report:${event.report.status}` : event.kind === 'pr-update' ? `pr:${event.change}` : event.kind);
const report = (body: object): FakeTurnStep => async (turn) => { await turn.bridge('jevellan_thread_report', body); return { status: 'completed' }; };
const commit = (files: Record<string, string>, body: object): FakeTurnStep => async (turn) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(turn.input.cwd, name), content);
  run(turn.input.cwd, 'add', '-A'); run(turn.input.cwd, 'commit', '-m', 'Work');
  await turn.bridge('jevellan_thread_report', body); return { status: 'completed' };
};
const hold = (): FakeTurnStep => async ({ signal }) => { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { status: 'completed' }; };
const create = (work: ProjectWork, title: string, clientRequestId = `req_${randomUUID()}`) => work.createThread('proj_a', { schema: 'thread-create-request-v1', clientRequestId, title, task: `Do ${title}.` });
async function settings(over: Partial<ProjectWorkSettings>): Promise<void> {
  const access = new HubProjectAccess(hub, 'dev_a'); const current = await access.settings('proj_a');
  await access.putSettings(ProjectWorkSettingsSchema.parse({ ...(current?.document ?? defaultProjectWorkSettings('proj_a')), ...over }), current?.revision ?? 0);
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-runner-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); redactor = new SecretRedactor(); works = [];
  origin = join(root, 'origin.git'); run(root, 'init', '--bare', '-b', 'main', origin);
  checkout = join(root, 'project'); run(root, 'clone', origin, checkout);
  run(checkout, 'config', 'user.name', 'Fixture'); run(checkout, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); run(checkout, 'add', '-A'); run(checkout, 'commit', '-m', 'Seed'); run(checkout, 'push', '-u', 'origin', 'main');
  run(checkout, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'); run(checkout, 'config', `url.${origin}.insteadOf`, 'https://github.com/fixture/repo.git');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_a', name: 'Shop', paths: { dev_a: checkout }, branchPolicy: 'main', testCommand: 'test -f greeting.txt',
    memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  hub = new HubDatabase(homes, 'hub'); hub.put('projects', 'proj_a', ProjectSchema, project, 0);
  token = `fixture-${randomUUID()}`; github = await startGitHubFixture({ token, repositories: { 'fixture/repo': origin } });
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
  await fake.close(); await github.close(); await new Promise((resolve) => server.close(resolve)); await bridges.close(); hub.close();
  rmSync(root, { recursive: true, force: true });
});

test('an owner thread prepares a worktree, runs its turn, opens the pull request, and concludes when it merges (3.1)', { timeout: 120_000 }, async () => {
  const work = app(); await work.ready; work.start();
  const before = { head: run(checkout, 'rev-parse', 'HEAD'), status: run(checkout, 'status', '--porcelain=v1') };
  fake.enqueueTurn(commit({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  const created = await create(work, 'Add greeting', 'req_pj1');
  expect(created).toEqual({ schema: 'thread-created-view-v1', threadId: expect.stringMatching(/^thread_/), state: 'preparing',
    placement: 'Scripted test runtime Fixture · high · Worktree · Mac mini · placed without Jev: no key configured' });
  // The same request repeats; the same id with other content is refused (D78).
  expect((await create(work, 'Add greeting', 'req_pj1')).threadId).toBe(created.threadId);
  await expect(create(work, 'Other', 'req_pj1')).rejects.toMatchObject({ message: START_REQUEST_REUSED, status: 409 });
  await settle(work);
  const thread = work.store.get(created.threadId)!;
  expect(thread).toMatchObject({ state: 'in-review', turns: 1, verificationAttempts: 0, pr: { number: 1, state: 'open' }, lastReport: { status: 'done', synthesized: false } });
  expect(thread.branch).toMatch(/^jv\/add-greeting-[0-9a-z]{6}$/);
  expect(fake.turnStarts).toHaveLength(1);
  expect(fake.turnStarts[0]).toMatchObject({ owner: { kind: 'thread', projectId: 'proj_a', id: created.threadId }, turn: 1, permissions: 'write', safetyProfile: 'thread',
    prompt: 'Task: Add greeting\n\nDo Add greeting.', cwd: homes.at('worktrees', 'proj_a', created.threadId) });
  expect(fake.turnStarts[0]!.resume).toBeUndefined();
  expect(fake.turnStarts[0]!.systemAppend).toContain(`Isolation: your own git worktree on branch ${thread.branch}, based on main.`);
  expect(work.ledgers.thread('proj_a', created.threadId).events().map((event) => event.type)).toEqual(['thread-placement', 'thread-state', 'thread-state', 'thread-state',
    'thread-turn-start', 'thread-turn-end', 'thread-report', 'thread-state', 'thread-verification', 'thread-publication', 'thread-state']);
  expect(kinds(queue(work))).toEqual(['thread-user-message', 'thread-published']);
  expect(queue(work)[0]).toMatchObject({ text: ownerStartedLine('Add greeting', created.threadId, 'Do Add greeting.') });
  expect(queue(work)[1]).toMatchObject({ result: 'pr-opened', prNumber: 1 });
  expect(work.store.local(created.threadId).process).toBeUndefined();
  await work.pulse();
  expect((await new HubProjectAccess(hub, 'dev_a').thread(created.threadId))?.document).toMatchObject({ state: 'in-review', branch: thread.branch, turns: 1 });
  // The thread view: no native session id, no worktree path.
  const view = await work.threadView('proj_a', created.threadId);
  expect(view).toMatchObject({ canMessage: true, atTurnLimit: false, canDiscard: false, deviceName: 'Mac mini', baseBranch: 'main', attachCommand: `jevellan thread attach ${created.threadId}` });
  expect(JSON.stringify(view)).not.toContain(thread.nativeSessionId!); expect(JSON.stringify(view.thread)).not.toContain(thread.cwd);
  const page = await work.view('proj_a');
  // The fake runtime cannot enforce read-only turns, so the coordinator evaluated its first event as unavailable (D97).
  expect(page).toMatchObject({ coordinator: { state: 'unavailable', unavailableReason: 'No enabled model can run the coordinator on Mac mini.', deviceId: 'dev_a', deviceName: 'Mac mini',
    online: true, session: null, planned: null }, pullRequests: [{ threadId: created.threadId }] });
  // Merged on GitHub: done, worktree and local branch gone, the coordinator hears it.
  github.markMerged(1); await work.pulse(); await settle(work);
  expect(work.store.get(created.threadId)).toMatchObject({ state: 'done', pr: { state: 'merged' } });
  expect(existsSync(thread.cwd)).toBe(false);
  expect(kinds(queue(work))).toEqual(['thread-user-message', 'thread-published', 'pr:merged']);
  expect({ head: run(checkout, 'rev-parse', 'HEAD'), status: run(checkout, 'status', '--porcelain=v1') }).toEqual(before);
});

test('turns without reports are synthesized, the limit waits for the owner, and Allow 10 more turns runs the queued message once (D31, D73, D85)', { timeout: 120_000 }, async () => {
  await settings({ threadTurnCap: 5 });
  const work = app(); await work.ready; work.start();
  fake.enqueueTurn(({ say }) => { say('x'.repeat(1500)); return { status: 'completed' }; }, forThread());
  const { threadId } = await create(work, 'Long task');
  await settle(work);
  expect(work.store.get(threadId)).toMatchObject({ state: 'idle', turns: 1, lastReport: { status: 'progress', synthesized: true, summary: 'x'.repeat(1200) } });
  fake.enqueueTurn(() => ({ status: 'failed', error: { kind: 'other', message: 'The model went away.' } }), forThread());
  expect(await work.threadMessage('proj_a', threadId, { schema: 'thread-message-request-v1', clientMessageId: 'msg_1', text: 'Continue.', interrupt: false })).toEqual({ repeated: false });
  await settle(work);
  expect(work.store.get(threadId)).toMatchObject({ state: 'idle', turns: 2, lastReport: { status: 'blocked', synthesized: true, summary: 'The model went away.' } });
  // The same message id repeats without a turn; other text under it is refused.
  expect(await work.threadMessage('proj_a', threadId, { schema: 'thread-message-request-v1', clientMessageId: 'msg_1', text: 'Continue.', interrupt: false })).toEqual({ repeated: true });
  await expect(work.threadMessage('proj_a', threadId, { schema: 'thread-message-request-v1', clientMessageId: 'msg_1', text: 'Other.', interrupt: false })).rejects.toMatchObject({ status: 409 });
  for (const n of [3, 4, 5]) {
    fake.enqueueTurn(report({ status: 'progress', summary: `Step ${n}.` }), forThread());
    await work.threadMessage('proj_a', threadId, { schema: 'thread-message-request-v1', clientMessageId: `msg_${n}`, text: `Go ${n}.`, interrupt: false });
    await settle(work);
  }
  expect(fake.turnStarts.map((input) => input.prompt).slice(1)).toEqual(['Continue.', 'Go 3.', 'Go 4.', 'Go 5.']);
  expect(fake.turnStarts.slice(1).map((input) => input.resume?.sessionId)).toEqual(Array(4).fill(work.store.get(threadId)!.nativeSessionId));
  // Right after the fifth turn: waiting for the owner with the item, and the fifth report reached the coordinator.
  expect(work.store.get(threadId)).toMatchObject({ state: 'waiting-for-you', stateReason: TURN_LIMIT_REACHED, turns: 5 });
  const hubAccess = new HubProjectAccess(hub, 'dev_a');
  const [item] = (await hubAccess.decisions('proj_a')).filter((entry) => entry.threadId === threadId);
  expect(item).toMatchObject({ from: 'thread', question: turnLimitQuestion('Long task', 5), options: [{ label: ALLOW_MORE_TURNS }, { label: STOP_THE_THREAD }] });
  expect(kinds(queue(work)).slice(-1)).toEqual(['report:progress']);
  // A message at the limit waits.
  const userMessages = kinds(queue(work)).length;
  fake.enqueueTurn(report({ status: 'progress', summary: 'After the limit.' }), forThread());
  expect(await work.threads.message('proj_a', threadId, 'coordinator', 'One more thing.', false)).toMatchObject({ delivery: 'queued', state: 'waiting-for-you' });
  expect(fake.turnStarts).toHaveLength(5);
  // Allow 10 more turns: the item answers, the message runs, a repeated answer adds nothing.
  expect(await work.answerDecision('proj_a', item!.id, { schema: 'decision-answer-request-v1', clientRequestId: 'ans_1', optionLabel: ALLOW_MORE_TURNS })).toEqual({ repeated: false });
  await settle(work);
  expect(work.store.get(threadId)).toMatchObject({ state: 'idle', turnAllowance: 15, turns: 6 });
  expect(fake.turnStarts.at(-1)!.prompt).toBe('One more thing.');
  expect(await work.answerDecision('proj_a', item!.id, { schema: 'decision-answer-request-v1', clientRequestId: 'ans_1', optionLabel: ALLOW_MORE_TURNS })).toEqual({ repeated: true });
  await settle(work);
  expect(work.store.get(threadId)).toMatchObject({ turnAllowance: 15 });
  expect(kinds(queue(work)).length).toBe(userMessages + 1);
});

test('limits queue a start until a slot frees; stop keeps the worktree, discard removes it, and ended threads refuse messages (D9a, D28)', { timeout: 120_000 }, async () => {
  await settings({ maxRunningThreads: 1 });
  const work = app(); await work.ready; work.start();
  fake.enqueueTurn(hold(), forThread());
  const first = await create(work, 'First');
  await waitFor(() => work.store.get(first.threadId)!.state, (state) => state === 'running');
  const second = await create(work, 'Second');
  expect(second).toMatchObject({ state: 'queued' });
  expect(work.store.get(second.threadId)!.stateReason).toBe(queuedReason(1, null));
  fake.enqueueTurn(report({ status: 'done', summary: 'Nothing to change.' }), forThread());
  await work.stopThread('proj_a', first.threadId);
  const stopped = work.store.get(first.threadId)!;
  expect(stopped).toMatchObject({ state: 'stopped', stateReason: 'Stopped by you.' }); expect(stopped.endedAt).toBeDefined();
  expect(existsSync(stopped.cwd)).toBe(true);
  expect(queue(work).find((event) => event.kind === 'thread-interrupted')).toMatchObject({ threadId: first.threadId, reason: 'stopped', message: OWNER_STOPPED_THREAD });
  // The freed slot dispatches the queued thread, which concludes without changes.
  await waitFor(() => work.store.get(second.threadId)!.state, (state) => state === 'done');
  await settle(work);
  expect(work.store.get(second.threadId)).toMatchObject({ state: 'done', stateReason: NO_CHANGES });
  await expect(work.threadMessage('proj_a', first.threadId, { schema: 'thread-message-request-v1', clientMessageId: 'msg_x', text: 'Hello.', interrupt: false }))
    .rejects.toMatchObject({ message: THREAD_ENDED, status: 409 });
  await expect(work.discardThread('proj_a', second.threadId)).rejects.toMatchObject({ message: DISCARD_REFUSED, status: 409 });
  await work.discardThread('proj_a', first.threadId); await work.discardThread('proj_a', first.threadId);
  expect(work.store.get(first.threadId)!.stateReason).toBe('Stopped by you. Worktree discarded.');
  expect(existsSync(stopped.cwd)).toBe(false);
  expect(run(checkout, 'branch', '--list', 'jv/*')).toBe('');
});

test('a restart leaves a running thread idle with the restart reason, ends its process and resumes nothing; an unconfirmed orphan fails the thread (8.6, D24)', { timeout: 120_000 }, async () => {
  const work = app(); await work.ready; work.start();
  fake.enqueueTurn(hold(), forThread());
  const { threadId } = await create(work, 'Held');
  await waitFor(() => work.store.local(threadId).process, (process) => !!process);
  const pgid = fake.runs.at(-1)!.native.pgid;
  await work.close();
  // Shutdown never rewrites the state (D24).
  expect(work.store.get(threadId)!.state).toBe('running');
  expect(groupAlive(pgid)).toBe(false);
  const restarted = app(); await restarted.ready; restarted.start(); await restarted.pulse(); await settle(restarted);
  expect(restarted.store.get(threadId)).toMatchObject({ state: 'idle', stateReason: RESTARTED });
  expect(restarted.store.local(threadId).process).toBeUndefined();
  expect(fake.turnStarts).toHaveLength(1);
  expect(queue(restarted).filter((event) => event.kind === 'thread-interrupted')).toEqual([expect.objectContaining({ threadId, reason: 'restart', message: RESTARTED })]);
  await restarted.close();
  // A crash with a live orphan: killed and idle. A recorded identity that does not match: refused and failed.
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); sleeper.unref();
  const native = processIdentity(sleeper.pid!);
  const crash = (process: { pid: number; pgid: number; startIdentity?: string }) => {
    const path = homes.at('projects', 'proj_a', 'threads', threadId);
    writeFileSync(join(path, 'thread.json'), JSON.stringify({ ...restarted.store.get(threadId), state: 'running', stateReason: undefined }));
    writeFileSync(join(path, 'thread-local.json'), JSON.stringify({ ...restarted.store.local(threadId), process: { turn: 2, ...process, startedAt: at } }));
  };
  crash({ pid: native.pid, pgid: native.pgid, startIdentity: native.startIdentity! });
  const third = app(); await third.ready;
  expect(groupAlive(native.pgid)).toBe(false);
  expect(third.store.get(threadId)).toMatchObject({ state: 'idle', stateReason: RESTARTED });
  await third.close();
  const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); other.unref();
  try {
    const live = processIdentity(other.pid!);
    crash({ pid: live.pid, pgid: live.pgid, startIdentity: 'Thu Jan  1 00:00:00 1970' });
    const fourth = app(); await fourth.ready;
    expect(fourth.store.get(threadId)).toMatchObject({ state: 'failed', stateReason: RESTART_UNCONFIRMED });
    expect(fourth.store.local(threadId).process).toBeUndefined();
    expect(groupAlive(live.pgid)).toBe(true);
  } finally { try { process.kill(-other.pid!, 'SIGKILL'); } catch { /* gone */ } }
});

test('an interrupt steers the running turn into the next one, and a message sent while publishing runs right after it (2.6.9, D72, D160)', { timeout: 120_000 }, async () => {
  project = ProjectSchema.parse({ ...project, testCommand: 'sleep 1; test -f greeting.txt' });
  const work = app(); await work.ready; work.start();
  fake.enqueueTurn(hold(), forThread());
  const { threadId } = await create(work, 'Steered');
  await waitFor(() => work.store.local(threadId).process, (process) => !!process);
  fake.enqueueTurn(commit({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.txt.' }), forThread());
  expect(await work.threads.message('proj_a', threadId, 'coordinator', 'Change of plan.', true)).toMatchObject({ delivery: 'interrupting' });
  await waitFor(() => work.store.get(threadId)!.state, (state) => state === 'publishing');
  fake.enqueueTurn(report({ status: 'progress', summary: 'README next.' }), forThread());
  expect(await work.threads.message('proj_a', threadId, 'coordinator', 'Also add a README.', false)).toMatchObject({ delivery: 'queued', state: 'publishing' });
  await waitFor(() => work.store.get(threadId)!.turns, (turns) => turns === 3);
  await settle(work);
  expect(fake.turnStarts.map((input) => input.prompt)).toEqual(['Task: Steered\n\nDo Steered.', 'Change of plan.', 'Also add a README.']);
  const session = work.store.get(threadId)!.nativeSessionId; expect(session).toBeDefined();
  expect(fake.turnStarts.slice(1).map((input) => input.resume?.sessionId)).toEqual([session, session]);
  const ledger = work.ledgers.thread('proj_a', threadId);
  expect(ledger.events().filter((event) => event.type === 'thread-turn-end').map((event) => (event.data as { status: string }).status)).toEqual(['steered', 'completed', 'completed']);
  expect(work.store.get(threadId)).toMatchObject({ state: 'idle', turns: 3, queuedMessages: [], pr: { number: 1, state: 'open' }, lastReport: { status: 'progress', summary: 'README next.' } });
  expect(kinds(queue(work))).toEqual(['thread-user-message', 'thread-published', 'report:progress']);
});

test('an idle thread holds no slot; its next turn waits for one and starts by itself when the slot frees (D9)', { timeout: 120_000 }, async () => {
  await settings({ maxRunningThreads: 1 });
  const work = app(); await work.ready; work.start();
  fake.enqueueTurn(report({ status: 'progress', summary: 'Half way.' }), forThread((input) => input.prompt.startsWith('Task: First')));
  const first = await create(work, 'First');
  await settle(work);
  expect(work.store.get(first.threadId)).toMatchObject({ state: 'idle', turns: 1 });
  fake.enqueueTurn(hold(), forThread((input) => input.prompt.startsWith('Task: Second')));
  const second = await create(work, 'Second');
  expect(second.state).toBe('preparing');
  await waitFor(() => work.store.get(second.threadId)!.state, (state) => state === 'running');
  fake.enqueueTurn(report({ status: 'progress', summary: 'Finished.' }), forThread((input) => input.prompt === 'Finish it.'));
  expect(await work.threads.message('proj_a', first.threadId, 'coordinator', 'Finish it.', false)).toMatchObject({ delivery: 'queued', state: 'idle' });
  expect(work.store.get(first.threadId)).toMatchObject({ state: 'idle', stateReason: waitingForSlotReason(1, null), queuedMessages: [expect.objectContaining({ text: 'Finish it.' })] });
  await work.pulse();
  expect(work.store.get(first.threadId)!.turns).toBe(1);
  await work.threads.stop('proj_a', second.threadId, 'Not needed.', false);
  await waitFor(() => work.store.get(first.threadId)!.turns, (turns) => turns === 2);
  await settle(work);
  expect(work.store.get(first.threadId)).toMatchObject({ state: 'idle', turns: 2, queuedMessages: [], lastReport: { summary: 'Finished.' } });
  expect('stateReason' in work.store.get(first.threadId)!).toBe(false);
  // A coordinator stop tells the coordinator nothing (D28).
  expect(queue(work).some((event) => event.kind === 'thread-interrupted')).toBe(false);
});
