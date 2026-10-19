import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountSchema, AccountStatusSchema, DeviceRosterSchema, Homes, LifecycleGate, ProjectSchema, SecretRedactor, seedConfiguration, type Account,
} from '../packages/core/dist/index.js';
import { StretchBridges } from '../packages/conversations/dist/index.js';
import { JevClient, type DecisionClient } from '../packages/decisions/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import { FakeRuntime, forCoordinator, type FakeTurnStep, type TurnInput } from '../packages/runtime-contract/dist/index.js';
import { ProjectWork } from '../packages/projects/dist/index.js';

// Fix A (fix-051): a request classification whose Jev decision never settles cannot hold the coordinator or the lifecycle gate.
// The decision source mirrors the daemon's: a function that yields a client, reporting its overall deadline without a read.

const at = '2026-10-19T02:00:00.000Z';
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const UNINTERPRETED = 'Jev could not interpret this request.';
let root: string; let homes: Homes; let redactor: SecretRedactor; let hub: HubDatabase; let fake: FakeRuntime; let server: Server; let url: string;
let checkout: string; let project: ReturnType<typeof ProjectSchema.parse>; let works: ProjectWork[]; let bridges: StretchBridges; let accounts: Account[];
let gate: LifecycleGate | undefined; let operations: Map<string, number>;
const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const account = (id: string, label: string) => AccountSchema.parse({ schema: 'account-v1', id, runtime: 'fake', label, kind: 'subscription', enabled: true, credential: 'per-device' });
const base = () => ({ ...seedConfiguration()['x-jevellan'], menu: [{ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated model.',
  efforts: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[], enabled: true }], runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, fake: { enabled: true } } });
/** A source like the daemon's `decisionClient`: `deadlineMs` is the overall deadline it reports for each decision. */
const source = (client: () => Promise<DecisionClient>, deadlineMs: number) => Object.assign(client, { deadlineMs: () => deadlineMs });
const classifying = () => [...operations.keys()].some(id => id.startsWith('project_request_'));

function app(extra: Partial<ConstructorParameters<typeof ProjectWork>[0]> = {}): ProjectWork {
  fake.capabilities.readOnlyEnforced = true;
  const work = new ProjectWork({ homes, deviceId: 'dev_a', deviceName: 'Mac mini', redactor, hub: new HubProjectAccess(hub, 'dev_a'),
    projects: { get: async (id: string) => id === project.id ? { schema: 'project-view-v1', revision: 1, project } : null, list: async () => [{ schema: 'project-view-v1', revision: 1, project }] } as never,
    github: { credential: async () => undefined },
    accounts: { list: async () => accounts.map((entry) => ({ schema: 'account-view-v1', revision: 1, account: entry,
      statuses: [AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: entry.id, deviceId: 'dev_a', auth: 'ready', observedAt: new Date().toISOString() })] })),
    resolve: async (id: string) => ({ account: accounts.find((entry) => entry.id === id)!, home: homes.ensure('homes', 'fake', id), env: {} }), markUsed: async () => undefined,
    recordUsage: async () => undefined as never, recordError: async () => undefined as never } as never,
    runtimes: new Map([['fake', fake]]), accountRuns: new Set(), bridges,
    memory: { project: () => ({ search: async () => ({ schema: 'memory-search-v1', notes: [] }), read: async () => { throw new Error('No note.'); } }) } as never,
    settings: async () => base(), riggingItems: async () => [],
    roster: async () => DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: 'dev_a', devices: [{ schema: 'device-view-v1', status: 'online', heartbeat: null, revoked: false,
      device: { schema: 'device-v1', id: 'dev_a', name: 'Mac mini', role: 'hub', url: 'http://127.0.0.1:9771', os: 'darwin', version: '0.1.0', joinedAt: at } }] }),
    enterOperation: (id, title) => {
      const release = gate ? gate.enter({ kind: 'conversation', id, title }) : () => undefined;
      operations.set(id, (operations.get(id) ?? 0) + 1);
      return () => { const left = (operations.get(id) ?? 1) - 1; if (left > 0) operations.set(id, left); else operations.delete(id); release(); };
    },
    timers: { periodic: false, coordinatorStartMs: 0, coordinatorRetryMs: 50 }, ...extra });
  work.daemonUrl = url; works.push(work);
  return work;
}
async function started(extra: Partial<ConstructorParameters<typeof ProjectWork>[0]> = {}): Promise<ProjectWork> { const work = app(extra); await work.ready; work.start(); return work; }
const message = (work: ProjectWork, text: string) =>
  work.postMessage('proj_a', { schema: 'coordinator-message-request-v1', clientMessageId: `msg_${Math.random().toString(36).slice(2)}`, text });
const say = (text: string): FakeTurnStep => (turn) => { turn.say(text); return { status: 'completed' }; };
const turns = (): TurnInput[] => fake.turnStarts.filter((input) => input.owner.kind === 'coordinator');
async function until(check: () => boolean, timeoutMs: number, what: string): Promise<number> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`); await new Promise(resolve => setTimeout(resolve, 20)); }
  return Date.now() - start;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-deadline-'))); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); redactor = new SecretRedactor(); works = []; operations = new Map(); gate = undefined;
  checkout = join(root, 'project'); mkdirSync(checkout); run(checkout, 'init', '-b', 'main');
  writeFileSync(join(checkout, 'value.txt'), '1\n'); run(checkout, 'add', '-A'); run(checkout, 'commit', '-m', 'Seed');
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_a', name: 'Shop', paths: { dev_a: checkout }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  hub = new HubDatabase(homes, 'hub'); hub.put('projects', 'proj_a', ProjectSchema, project, 0);
  accounts = [account('acc_work', 'Work')]; fake = new FakeRuntime(); bridges = new StretchBridges(redactor);
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
  for (const work of works) await Promise.race([work.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 2000))]);
  try { gate?.close(); } catch { /* A failed test may leave work admitted. */ }
  await fake.close(); await new Promise((resolve) => server.close(resolve)); await bridges.close(); hub.close();
  rmSync(root, { recursive: true, force: true });
});

const DEADLINE = 1500;
const hangs: Array<[string, () => Partial<ConstructorParameters<typeof ProjectWork>[0]>]> = [
  ['the configuration read behind the client', () => ({ decisionClient: source(() => never(), DEADLINE) })],
  ['the key read', () => ({ decisionClient: source(async () => new JevClient({ key: () => never(), timeoutMs: 200 }), DEADLINE) })],
  ['the settings read for the decision model', () => ({ decisionClient: source(async () => new JevClient({ key: () => 'jev-test-key', timeoutMs: 200, fetch: async () => Response.json({}) }), DEADLINE),
    settings: async () => classifying() ? never() : base() })],
  ['an HTTP attempt that never settles and ignores its abort signal', () => ({ decisionClient: source(async () => new JevClient({ key: () => 'jev-test-key', timeoutMs: 200, fetch: () => never() }), DEADLINE) })],
];
for (const [what, extra] of hangs) {
  test(`when ${what} never settles, the coordinator still starts its turn within the deadline with the uninterpreted-request instruction`, { timeout: 30_000 }, async () => {
    fake.enqueueTurn(say('Looking into it.'), forCoordinator);
    const work = await started(extra());
    const sent = Date.now(); await message(work, 'Add a short Contributing section to the README.');
    await until(() => turns().length === 1, DEADLINE + 5000, 'the coordinator turn');
    expect(Date.now() - sent).toBeLessThan(DEADLINE + 4000);
    expect(turns()[0]!.prompt).toContain(UNINTERPRETED);
    await work.idle('proj_a');
    expect(classifying()).toBe(false);
    expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'idle', queue: [] });
  });
}

/** The first classification hangs for longer than any test; later ones answer at once without a key. */
const firstHangs = () => { let calls = 0; return source(async () => { calls += 1; if (calls === 1) return { decide: () => never() }; throw new Error('No key in this fixture.'); }, 120_000); };

test('Fresh session during a hung classification releases its operation, and the next turn runs fresh', { timeout: 30_000 }, async () => {
  fake.enqueueTurn(say('Fresh start.'), forCoordinator);
  const work = await started({ decisionClient: firstHangs() });
  await message(work, 'What is running right now?');
  await until(classifying, 5000, 'the classification');
  await work.freshCoordinator('proj_a');
  expect(await until(() => turns().length === 1, 5000, 'the next turn')).toBeLessThan(5000);
  await work.idle('proj_a');
  expect(classifying()).toBe(false);
  expect(work.coordinators.get('proj_a').state()).toMatchObject({ state: 'idle', queue: [], session: { turns: 1 } });
});

test('Stop during a hung classification releases its operation at once and keeps the owner message queued', { timeout: 30_000 }, async () => {
  const work = await started({ decisionClient: firstHangs() });
  await message(work, 'What is running right now?');
  await until(classifying, 5000, 'the classification');
  const stopping = Date.now(); await work.stopCoordinator('proj_a');
  expect(Date.now() - stopping).toBeLessThan(3000);
  expect(classifying()).toBe(false);
  expect(turns()).toHaveLength(0);
  expect(work.coordinators.get('proj_a').state().queue.map(event => event.kind)).toEqual(['user-message']);
});

test('a coordinator move during a hung classification hands the queue over without waiting for it', { timeout: 30_000 }, async () => {
  const work = await started({ decisionClient: firstHangs() });
  await message(work, 'What is running right now?');
  await until(classifying, 5000, 'the classification');
  const moving = Date.now(); await work.coordinators.get('proj_a').handover();
  expect(Date.now() - moving).toBeLessThan(3000);
  expect(classifying()).toBe(false);
  expect(turns()).toHaveLength(0);
});

test('shutdown during a hung classification completes and releases its operation', { timeout: 30_000 }, async () => {
  const work = await started({ decisionClient: firstHangs() });
  await message(work, 'What is running right now?');
  await until(classifying, 5000, 'the classification');
  const closing = Date.now(); let closed = false; void work.close().then(() => { closed = true; });
  await until(() => closed, 5000, 'the shutdown');
  expect(Date.now() - closing).toBeLessThan(3000);
  expect(classifying()).toBe(false);
});

test('a maintenance gate requested during a hung classification is granted within the deadline', { timeout: 30_000 }, async () => {
  gate = new LifecycleGate(homes);
  fake.enqueueTurn(say('Looking into it.'), forCoordinator);
  const work = await started({ decisionClient: source(async () => new JevClient({ key: () => 'jev-test-key', timeoutMs: 200, fetch: () => never() }), DEADLINE) });
  await message(work, 'Add a short Contributing section to the README.');
  await until(classifying, 5000, 'the classification');
  expect(gate.tryMaintenance()).toBeNull();
  const requested = Date.now(); let maintenance: (() => void) | null = null;
  await until(() => (maintenance = gate!.tryMaintenance()) !== null, DEADLINE + 5000, 'the maintenance gate');
  expect(Date.now() - requested).toBeLessThan(DEADLINE + 4000);
  maintenance!();
});
