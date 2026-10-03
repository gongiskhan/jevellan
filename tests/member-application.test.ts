import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AccountViewSchema, CheckpointBlockSchema, CheckoutClaimSchema, CheckoutStoreRequestSchema, ConversationChangesSchema, ConversationIndexSchema, ConversationPublicSchema, DeviceSchema, DeviceSwitchSchema, GitWorkspace, Homes, HubWaitSchema, MemoryAppliedSchema, ProjectSchema, RiggingApplicationSchema, SecretRedactor, UiSigningMaterialSchema, groupAlive, readDocument, type Action } from '../packages/core/dist/index.js';
import { HubUnavailable, joinMember } from '../packages/mesh/dist/index.js';
import { ConversationWork } from '../packages/conversations/dist/index.js';
import { ProjectContext } from '../packages/memory/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { FakeRuntime, type RuntimeAdapter, type StretchInput } from '../packages/runtime-contract/dist/index.js';
import { RiggingDelivery, parseConfiguration } from '../packages/core/dist/index.js';
import { ImproverJobViewSchema, ImproverRunSchema, ImproverStateSchema } from '../packages/core/dist/index.js';

let root: string; let hub: Application; let member: Application; let homes: Homes; let fake: FakeRuntime; let offline: boolean;
let hubBase: string; let memberBase: string; let hubCookie: string; let cookie: string; let passphrase: string; let path: string; let origin: string; let accountId: string;
const servers: Server[] = []; const streams: AbortController[] = []; const readers: Promise<void>[] = [];
let memberOptions: { application?: Application };
let hubOptions: { application?: Application };
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function checkoutClaims() {
  // Lifecycle activity snapshots share this directory but do not claim a checkout.
  return readdirSync(homes.at('locks')).filter(name => name.endsWith('.json')).flatMap(name => {
    const parsed = CheckoutClaimSchema.safeParse(JSON.parse(readFileSync(homes.at('locks', name), 'utf8')));
    return parsed.success ? [parsed.data] : [];
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function serve(options: { application?: Application }) { const server = createDaemon(options); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
function request(base: string, route: string, session?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') { return fetch(`${base}${route}`, { method, redirect: 'manual', headers: { Origin: base, ...(session ? { Cookie: session } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function body(response: Response, status = 200): Promise<unknown> { const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status); return value; }
function newMember() {
  const runtime: RuntimeAdapter = { id: 'claude', displayName: 'Simulated Claude provider', accountKinds: fake.accountKinds, riggingKinds: [], capabilities: fake.capabilities,
    probe: () => fake.probe(), listModels: () => fake.listModels(), beginLogin: () => fake.beginLogin(), materialiseRigging: () => fake.materialiseRigging(), startStretch: input => fake.startStretch(input) };
  const app = new Application({ homes, timers: false, repositoryVisibility: async () => 'PUBLIC', runtimes: () => new Map([['claude', runtime]]), hubFetch: async (...args) => { if (offline) throw new Error('Simulated hub outage'); return fetch(...args); } });
  app.conversations.daemonUrl = memberBase; memberOptions.application = app; return app;
}
test('a member forwards repeatable improver requests to the hub and never creates a local job', async () => {
  const input = { schema: 'improver-request-v1', operation: 'run', clientRequestId: 'member_improver' };
  const job = ImproverJobViewSchema.parse(await body(await request(memberBase, '/api/improver', cookie, input)));
  await hub.routingImprover!.wait(job.id);
  expect(ImproverJobViewSchema.parse(await body(await request(memberBase, '/api/improver', cookie, input))).id).toBe(job.id);
  const state = ImproverStateSchema.parse(await body(await request(memberBase, '/api/improver', cookie)));
  expect(state.jobs).toHaveLength(1); expect(state.jobs[0]).toMatchObject({ id: job.id, deviceId: hub.device.deviceId, status: 'complete' });
  expect(state.jobs[0]).not.toHaveProperty('token'); expect(member.routingImprover).toBeUndefined(); expect(fake.starts).toEqual([]);
  offline = true; const unavailable = await request(memberBase, '/api/improver', cookie, input);
  expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
});
test('the hub hands project memory care to the online member that has the checkout; the member runs it over the device protocol', async () => {
  const config = await hub.state.configuration.current(); const settings = config.configuration['x-jevellan'].improver;
  settings.schedule.enabled = false; settings.routing.enabled = false; settings.context.enabled = false;
  await hub.state.configuration.put({ schema: 'config-write-v1', revision: config.revision, configuration: config.configuration });
  await member.member!.heartbeat({ schema: 'heartbeat-v1', deviceId: member.device.deviceId, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  const run = ImproverRunSchema.parse(await body(await request(memberBase, '/api/improver', cookie, { schema: 'improver-request-v1', operation: 'run-now', clientRequestId: 'member_care' })));
  expect(run).toMatchObject({ routing: null, projects: [{ kind: 'memory', projectId: 'project' }] });
  await hub.projectImprover.tick(); await hub.projectImprover.idle();
  expect(ImproverStateSchema.parse(await body(await request(hubBase, '/api/improver', hubCookie))).lastRuns).toEqual([expect.objectContaining({ kind: 'memory', status: 'waiting', result: 'Not run yet.' })]);
  await member.projectImprover.tick(); await member.projectImprover.idle();
  const state = ImproverStateSchema.parse(await body(await request(memberBase, '/api/improver', cookie)));
  expect(state.lastRuns).toEqual([expect.objectContaining({ kind: 'memory', projectId: 'project', deviceId: member.device.deviceId, status: 'complete', result: 'Nothing to tidy.' })]);
  const log = await body(await request(memberBase, '/api/improver', cookie, { schema: 'improver-request-v1', operation: 'log', jobId: state.lastRuns[0]!.jobId }));
  expect(log).toMatchObject({ schema: 'project-improver-log-v1', entries: [expect.objectContaining({ stage: 'started' }), expect.objectContaining({ stage: 'synchronized' }), expect.objectContaining({ stage: 'collected' }), expect.objectContaining({ stage: 'complete', note: 'Nothing to tidy.' })] });
  expect(checkoutClaims().every(claim => !claim.held)).toBe(true); expect(git(path, 'status', '--porcelain')).toBe('');
});
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-member-app-'))); mkdirSync(join(root, 'user')); offline = false;
  hub = new Application({ homes: new Homes(join(root, 'hub-home'), join(root, 'user')), timers: false, runtimes: () => new Map() }); hubOptions = { application: hub }; hubBase = await serve(hubOptions);
  const row = hub.hub.get('devices', hub.device.deviceId, DeviceSchema)!; hub.hub.put('devices', hub.device.deviceId, DeviceSchema, { ...row.document, name: 'Fixture hub', url: hubBase }, row.revision);
  passphrase = `fixture-${randomUUID()}`; const setup = await request(hubBase, '/api/auth/setup', undefined, { schema: 'passphrase-input-v1', passphrase }); await body(setup); hubCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  memberOptions = {}; memberBase = await serve(memberOptions); homes = new Homes(join(root, 'member-home'), join(root, 'user')); fake = new FakeRuntime(); fake.capabilities.readOnlyEnforced = true;
  await joinMember(homes, { schema: 'member-join-input-v1', hubUrl: hubBase, code: hub.mesh.invite().code, device: { name: 'Fixture member', url: memberBase, os: 'linux', version: '0.1.0' } }, { redactor: new SecretRedactor() });
  member = newMember(); await member.conversations.ready;
  const login = await request(memberBase, '/api/auth/login', undefined, { schema: 'passphrase-input-v1', passphrase }); await body(login); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const config = await hub.state.configuration.current(); config.configuration['x-jevellan'].runtimes.claude = { enabled: true };
  config.configuration['x-jevellan'].menu = [{ id: 'fixture', runtime: 'claude', model: 'scripted-model', label: 'Fixture', description: 'Simulated provider', efforts: ['high'], enabled: true }];
  await hub.state.configuration.put({ schema: 'config-write-v1', revision: config.revision, configuration: config.configuration });
  const account = AccountViewSchema.parse(await body(await request(memberBase, '/hub/accounts', cookie, { schema: 'add-account-v1', runtime: 'claude', label: 'Member account', kind: 'api-key', paidUse: 'always', secret: `fixture-${randomUUID()}` }), 201)); accountId = account.account.id;
  await body(await request(memberBase, `/api/accounts/${accountId}/check`, cookie, { schema: 'empty-request-v1' }));
  origin = join(root, 'origin.git'); git(root, 'init', '--bare', '-b', 'main', origin); path = join(root, 'checkout'); git(root, 'clone', origin, path);
  git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(path, 'value.txt'), '1\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed'); git(path, 'push', '-u', 'origin', 'main');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Member project', paths: { [member.device.deviceId]: path }, branchPolicy: 'main', testCommand: 'test "$(cat value.txt)" = 2', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  await body(await request(memberBase, '/hub/projects', cookie, { schema: 'project-write-v1', revision: 0, project }, 'PUT'));
});
afterEach(async () => {
  offline = false; for (const stream of streams.splice(0)) stream.abort(); await Promise.allSettled(readers.splice(0));
  await member?.close(); await fake?.close(); await hub?.close();
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  rmSync(root, { recursive: true, force: true });
});
async function create() { return ConversationPublicSchema.parse(await body(await request(memberBase, '/api/conversations', cookie, { schema: 'start-conversation-v1', id: 'member_work', title: 'Member work', projectId: 'project', clientMessageId: 'first', message: 'Private member request: change the value to two.' }), 201)); }
async function choose(action: Exclude<Action, 'integrate'>) { const current = await member.conversations.view('member_work'); return body(await request(memberBase, '/api/conversations/member_work/manual', cookie, { schema: 'manual-step-v1', generation: current.conversation.generation, action, modelId: 'fixture', effort: 'high' }), 202); }
async function handoff(input: StretchInput, extra: Record<string, unknown> = {}) {
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Finished on the member.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: input.action === 'implement' ? ['value.txt'] : [], ...extra } }) }); expect(response.status, await response.text()).toBe(200);
}
async function watch(from = memberBase, session = cookie, after?: string) {
  const controller = new AbortController(); streams.push(controller); const response = await fetch(`${from}/api/conversations/member_work/events`, { headers: { Cookie: session, ...(after === undefined ? {} : { 'Last-Event-ID': after }) }, signal: controller.signal }); expect(response.status).toBe(200);
  let text = ''; const read = (async () => { try { for await (const chunk of response.body!) text += Buffer.from(chunk).toString(); } catch (error) { if (!controller.signal.aborted) throw error; } })(); readers.push(read);
  return { text: () => text, read, close: () => controller.abort() };
}

test('periodic member synchronization applies configuration and Rigging updates with real APM and recovers after hub loss', async () => {
  const native = join(homes.userHome, '.claude'); mkdirSync(native); writeFileSync(join(native, 'sentinel'), 'Native fixture unchanged.');
  const pkg = join(root, 'sync-package'); mkdirSync(join(pkg, '.apm', 'skills', 'sync-fixture'), { recursive: true });
  writeFileSync(join(pkg, 'apm.yml'), 'name: sync-package\nversion: 1.0.0\ndescription: Synchronization fixture\n');
  writeFileSync(join(pkg, '.apm', 'skills', 'sync-fixture', 'SKILL.md'), '---\nname: sync-fixture\ndescription: Synchronization fixture\n---\nRead the current project instructions.\n');
  const installed = new RiggingDelivery(homes); const runner = vi.fn(installed.runner); const delivery = new RiggingDelivery(homes, runner);
  vi.spyOn(member.runtimes.get('claude')!, 'materialiseRigging').mockImplementation((home, items) => delivery.materialise('claude', home, items));
  const config = await hub.state.configuration.current(); config.configuration.dependencies.apm = [{ path: pkg }];
  await hub.state.configuration.put({ schema: 'config-write-v1', revision: config.revision, configuration: config.configuration });
  expect((await member.settingsSync.pulse())?.status).toBe('applied');
  expect(parseConfiguration(readFileSync(homes.at('apm.yml'), 'utf8')).dependencies.apm).toEqual([{ path: pkg }]);
  const home = homes.account('claude', accountId); expect(readFileSync(join(home, 'skills', 'sync-fixture', 'SKILL.md'), 'utf8')).toContain('Read the current project instructions.');
  const count = runner.mock.calls.length; await Promise.all([member.settingsSync.pulse(), member.settingsSync.pulse(), member.applyRigging()]); expect(runner).toHaveBeenCalledTimes(count);
  const rule = await member.state.rigging.add({ schema: 'add-rigging-v1', name: 'Synchronized rule', kind: 'rule', content: 'Keep the synchronized rule.', runtimes: { claude: true } });
  offline = true; expect((await member.settingsSync.pulse())?.status).toBe('waiting'); expect(runner).toHaveBeenCalledTimes(count);
  offline = false; expect((await member.settingsSync.pulse())?.status).toBe('applied'); expect(runner.mock.calls.length).toBeGreaterThan(count);
  expect(member.riggingApplication()?.accounts.find(row => row.accountId === accountId)?.results).toContainEqual(expect.objectContaining({ itemId: rule.item.id, applied: true }));
  const configured = await hub.state.configuration.current(); configured.configuration.dependencies.apm = [];
  await hub.state.configuration.put({ schema: 'config-write-v1', revision: configured.revision, configuration: configured.configuration });
  expect((await member.settingsSync.pulse())?.status).toBe('applied'); expect(existsSync(join(home, 'skills', 'sync-fixture', 'SKILL.md'))).toBe(false);
  expect(readdirSync(native)).toEqual(['sentinel']); expect(readFileSync(join(native, 'sentinel'), 'utf8')).toBe('Native fixture unchanged.');
}, 120_000);

test('an owner proxy lets the hub watch and correct a member stretch, then replay without another launch', async () => {
  await create(); await member.conversations.list();
  const remote = ConversationPublicSchema.parse(await body(await request(hubBase, '/api/conversations/member_work', hubCookie)));
  expect(remote.conversation.ownerDeviceId).toBe(member.device.deviceId); expect(fake.starts).toHaveLength(0);
  const stream = await watch(hubBase, hubCookie); const localStream = await watch(); const started = deferred(); let interrupted = false;
  fake.enqueue(async ({ emit, signal }) => {
    emit({ type: 'text', delta: 'The member is working while the hub watches.' }); started.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { interrupted = true; resolve(); }, { once: true })); return { status: 'interrupted' };
  }, async ({ input }) => { await handoff(input, { status: 'partial', summary: 'Stopped for the remote correction.' }); return { status: 'completed' }; });
  await body(await request(hubBase, '/api/conversations/member_work/manual', hubCookie, { schema: 'manual-step-v1', generation: remote.conversation.generation, action: 'reply', modelId: 'fixture', effort: 'high' }), 202);
  await started.promise; await vi.waitFor(() => expect(stream.text()).toContain('The member is working'), { timeout: 5000 });
  await body(await request(hubBase, '/api/conversations/member_work/messages', hubCookie, { schema: 'conversation-message-v1', clientMessageId: 'remote_correction', text: 'Keep the value unchanged and explain it.' }));
  await member.conversations.wait('member_work'); const completed = await member.conversations.view('member_work');
  expect(interrupted).toBe(true); expect(completed.stretches[0]?.status).toBe('interrupted'); expect(completed.handoffs[0]?.status).toBe('partial');
  expect(completed.messages.some(message => JSON.stringify(message).includes('Keep the value unchanged'))).toBe(true);
  const ids = () => [...stream.text().matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
  const events = member.conversations.ledger('member_work').events().map(event => event.id);
  await vi.waitFor(() => expect(ids()).toEqual(events), { timeout: 5000 });
  await vi.waitFor(() => expect([...localStream.text().matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual(events), { timeout: 5000 });
  stream.close(); localStream.close(); await Promise.all([stream.read, localStream.read]);
  const cursor = events[Math.floor(events.length / 2)]!; const replay = await watch(hubBase, hubCookie, String(cursor));
  await vi.waitFor(() => expect([...replay.text().matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual(events.filter(id => id > cursor)), { timeout: 5000 });
  replay.close(); await replay.read; expect(fake.starts).toHaveLength(1);
  expect(existsSync(hub.homes.at('conversations', 'member_work'))).toBe(false); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
}, 60_000);

test('an owner proxy serves hub history on a member without a local project path and preserves stale-control conflicts', async () => {
  const hubPath = join(root, 'hub-project'); git(root, 'clone', origin, hubPath);
  await hub.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: 'hub_project', name: 'Hub project', paths: { [hub.device.deviceId]: hubPath }, branchPolicy: 'main', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
  await body(await request(hubBase, '/api/conversations', hubCookie, { schema: 'start-conversation-v1', id: 'hub_work', title: 'Hub history', projectId: 'hub_project', clientMessageId: 'first', message: 'Read this on another device.' }), 201); await hub.conversations.list();
  const read = ConversationPublicSchema.parse(await body(await request(memberBase, '/api/conversations/hub_work', cookie))); expect(read.conversation.ownerDeviceId).toBe(hub.device.deviceId);
  const rename = { schema: 'rename-conversation-v1', clientRequestId: 'remote_rename', previousTitle: 'Hub history', title: 'Renamed from the member' };
  await body(await request(memberBase, '/api/conversations/hub_work/rename', cookie, rename));
  expect((await hub.conversations.view('hub_work')).conversation.title).toBe(rename.title);
  await body(await request(memberBase, '/api/conversations/hub_work/rename', cookie, { ...rename, clientRequestId: 'stale_rename' }), 409);
  expect((await request(memberBase, '/api/conversations/hub_work', cookie, undefined, 'DELETE')).status).toBe(405);
  expect((await request(hubBase, '/api/mesh/owner/hub_work', hubCookie)).status).toBe(403);
  expect(existsSync(homes.at('conversations', 'hub_work'))).toBe(false); expect(fake.starts).toHaveLength(0);
}, 60_000);

test('an owner proxy also resolves member-to-member views through the hub authority', async () => {
  await create(); await member.conversations.list(); const options: { application?: Application } = {}; const base = await serve(options);
  const otherHomes = new Homes(join(root, 'other-member-home'), join(root, 'user'));
  await joinMember(otherHomes, { schema: 'member-join-input-v1', hubUrl: hubBase, code: hub.mesh.invite().code, device: { name: 'Other member', url: base, os: 'linux', version: '0.1.0' } }, { redactor: new SecretRedactor() });
  const other = new Application({ homes: otherHomes, timers: false, runtimes: () => new Map() }); options.application = other;
  try {
    const login = await request(base, '/api/auth/login', undefined, { schema: 'passphrase-input-v1', passphrase }); await body(login); const session = login.headers.get('set-cookie')!.split(';')[0]!;
    const remote = ConversationPublicSchema.parse(await body(await request(base, '/api/conversations/member_work', session)));
    expect(remote.conversation.ownerDeviceId).toBe(member.device.deviceId); expect(existsSync(otherHomes.at('conversations', 'member_work'))).toBe(false); expect(fake.starts).toHaveLength(0);
  } finally { await other.close(); }
}, 60_000);

test('the joined application signs in, shares Settings and records local delivery without creating a hub database', async () => {
  expect(member.device.role).toBe('member'); expect(() => member.hub).toThrow('no authoritative hub'); expect(existsSync(homes.at('hub'))).toBe(false);
  const signing = readDocument(homes.at('ui-auth.json'), UiSigningMaterialSchema); const token = readFileSync(homes.at('device.token'), 'utf8').trim();
  expect(member.redactor.text(signing.key) === signing.key).toBe(false); expect(member.redactor.text(token) === token).toBe(false);
  const config = await member.configuration(); expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('scripted-model'); expect(config).toEqual(await hub.state.configuration.current());
  const account = await hub.accounts.get(accountId); expect(account.statuses).toContainEqual(expect.objectContaining({ deviceId: member.device.deviceId, auth: 'ready' }));
  await member.applyRigging(); expect(member.riggingApplication()?.accounts).toContainEqual(expect.objectContaining({ accountId }));
  expect(hub.hub.db.prepare("SELECT id FROM documents WHERE namespace='rigging-application'").all()).toEqual([]);
  expect((await request(memberBase, '/hub/mesh/devices', cookie)).status).toBe(404);
  await body(await request(memberBase, '/api/auth/logout', cookie, { schema: 'empty-request-v1' })); expect((await request(memberBase, '/hub/config', cookie)).status).toBe(401);
});

test('member HTTP starts local work, streams its output, verifies and publishes using hub coordination', async () => {
  await create(); const stream = await watch();
  fake.enqueue(async ({ input, emit }) => { expect(input.cwd).toBe(path); expect(input.account.home).toBe(homes.account('claude', accountId)); writeFileSync(join(input.cwd, 'value.txt'), '2\n'); emit({ type: 'text', delta: 'Implementation ran on the joined member.' }); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); expect((await member.conversations.view('member_work')).stretches[0]?.status).toBe('completed'); await choose('done'); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(fake.starts).toHaveLength(1);
  await vi.waitFor(() => expect(stream.text().includes('Implementation ran on the joined member.')).toBe(true));
  expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main')); expect(git(path, 'status', '--porcelain')).toBe('');
  expect((await member.conversations.changes('member_work', 1)).verifications).toEqual(expect.arrayContaining([expect.objectContaining({ passed: true, treeClean: true })]));
  const index = hub.hub.get('conversations', 'member_work', ConversationIndexSchema)!.document; expect(index.ownerDeviceId).toBe(member.device.deviceId); expect(index.state).toBe('done');
  expect(JSON.stringify(hub.hub.db.prepare('SELECT document FROM documents').all())).not.toContain('Private member request'); expect(existsSync(hub.homes.at('conversations', 'member_work'))).toBe(false); expect(existsSync(homes.at('hub'))).toBe(false);
}, 90_000);

test('an existing member stream and local handoff survive a hub outage while new UI work waits', async () => {
  await create(); const stream = await watch(); const running = deferred(); const finish = deferred();
  fake.enqueue(async ({ input, emit }) => { running.resolve(); await finish.promise; emit({ type: 'text', delta: 'Streamed while the hub was unreachable.' }); await handoff(input); return { status: 'completed' }; });
  try {
    await choose('reply'); await vi.waitFor(() => expect(fake.starts).toHaveLength(1), { timeout: 20_000 }); await running.promise; offline = true; finish.resolve();
    await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
    const local = new ConversationWork(member.conversations.ledger('member_work')).load(); expect(local.stretches[0]?.status).toBe('completed'); expect(local.handoffs).toHaveLength(1); expect(local.pause?.reason).toContain("Can't reach the hub");
    await vi.waitFor(() => expect(stream.text()).toContain('Streamed while the hub was unreachable.'), { timeout: 5000 });
    expect((await request(memberBase, '/hub/config', cookie)).status).toBe(503); expect((await request(memberBase, '/api/conversations', cookie, { schema: 'start-conversation-v1', id: 'offline_work', title: 'Offline', projectId: 'project', clientMessageId: 'new', message: 'Must wait.' })).status).toBe(503);
    expect(existsSync(homes.at('conversations', 'offline_work'))).toBe(false); expect(fake.starts).toHaveLength(1);
    offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
    const token = cookie.slice(cookie.indexOf('=') + 1); hub.hubAuth.logout(token, member.device.deviceId);
    member.conversations.ledger('member_work').append({ type: 'notice', data: { schema: 'conversation-notice-v1', kind: 'info', text: 'This must not reach the revoked stream.' } });
    await stream.read; expect(stream.text()).not.toContain('This must not reach the revoked stream.');
  } finally { offline = false; finish.resolve(); }
}, 90_000);

test('member restart reopens local history and authentication without opening a local hub or launching work', async () => {
  await create(); const before = new ConversationWork(member.conversations.ledger('member_work')).load(); await member.applyRigging(); const receipt = member.riggingApplication();
  await member.close(); offline = true; member = newMember(); await member.conversations.ready;
  const reopened = new ConversationWork(member.conversations.ledger('member_work')).load(); expect(reopened.messages).toEqual(before.messages); expect(member.riggingApplication()).toEqual(receipt); expect(fake.starts).toHaveLength(0); expect(existsSync(homes.at('hub'))).toBe(false);
  expect((await request(memberBase, '/hub/config', cookie)).status).toBe(503); offline = false; expect((await request(memberBase, '/hub/config', cookie)).status).toBe(200);
});

test('member UI retries authentication and configuration without replaying an already saved revision', async () => {
  const initial = await member.state.configuration.current(); const input = { schema: 'config-write-v1' as const, revision: initial.revision, configuration: initial.configuration, clientRequestId: 'member_save' };
  offline = true;
  for (const response of [
    await request(memberBase, '/api/auth/login', undefined, { schema: 'passphrase-input-v1', passphrase }),
    await request(memberBase, '/hub/config', cookie, input, 'PUT'),
  ]) expect(await body(response, 503)).toMatchObject({ code: 'hub-unavailable', retryable: true });
  expect((await hub.state.configuration.current()).revision).toBe(initial.revision);
  offline = false;
  const save = member.state.configuration.put.bind(member.state.configuration);
  vi.spyOn(member.state.configuration, 'put').mockImplementationOnce(async raw => { await save(raw); offline = true; throw new HubUnavailable('Fixture hub'); });
  expect(await body(await request(memberBase, '/hub/config', cookie, input, 'PUT'), 503)).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const saved = await hub.state.configuration.current(); expect(saved.revision).toBe(initial.revision + 1);
  const newer = structuredClone(saved.configuration); newer['x-jevellan'].guards.pauseAfterPlan = false;
  const latest = await hub.state.configuration.put({ schema: 'config-write-v1', revision: saved.revision, configuration: newer });
  offline = false; expect(await body(await request(memberBase, '/hub/config', cookie, input, 'PUT'))).toEqual(saved);
  expect(await member.state.configuration.current()).toEqual(latest);
  const login = await request(memberBase, '/api/auth/login', undefined, { schema: 'passphrase-input-v1', passphrase }); expect(await body(login)).toMatchObject({ authenticated: true });
  expect(fake.starts).toHaveLength(0); expect(existsSync(homes.at('hub'))).toBe(false);
});

test('switching between the two actual daemons uses their UI endpoints and a one-time hub grant', async () => {
  const heartbeat = (deviceId: string) => ({ schema: 'heartbeat-v1', deviceId, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  hub.devices.heartbeat(hub.device.deviceId, heartbeat(hub.device.deviceId)); await member.member!.heartbeat(heartbeat(member.device.deviceId));
  const out = DeviceSwitchSchema.parse(await body(await request(memberBase, '/api/devices/switch', cookie, { schema: 'device-switch-input-v1', targetDeviceId: hub.device.deviceId, route: '/settings/projects' })));
  const arrived = await request(hubBase, `/switch?token=${encodeURIComponent(out.token)}`); expect(arrived.status).toBe(303); expect(arrived.headers.get('location')).toBe('/settings/projects');
  const arrivedCookie = arrived.headers.get('set-cookie')!.split(';')[0]!; expect((await request(hubBase, '/hub/config', arrivedCookie)).status).toBe(200);
  expect((await request(hubBase, `/switch?token=${encodeURIComponent(out.token)}`)).status).toBe(401);
  const back = DeviceSwitchSchema.parse(await body(await request(hubBase, '/api/devices/switch', hubCookie, { schema: 'device-switch-input-v1', targetDeviceId: member.device.deviceId, route: '/settings' })));
  const returned = await request(memberBase, `/switch?token=${encodeURIComponent(back.token)}`); expect(returned.status).toBe(303); expect((await request(memberBase, '/hub/config', returned.headers.get('set-cookie')!.split(';')[0]!)).status).toBe(200);
});

test('a partial join cannot silently create a new hub in the pending member home', () => {
  const pending = new Homes(join(root, 'partial'), join(root, 'user')); pending.ensure(); writeFileSync(pending.at('join-pending.json'), 'Interrupted fixture registration.');
  for (let attempt = 0; attempt < 2; attempt++) expect(() => new Application({ homes: pending, timers: false, runtimes: () => new Map() })).toThrow('Finish the pending member join');
  expect(existsSync(pending.at('hub'))).toBe(false); expect(existsSync(pending.at('device.json'))).toBe(false);
});

test('a delayed older configuration response cannot replace a newer materialised manifest', async () => {
  const current = member.state.configuration.current.bind(member.state.configuration); const entered = deferred(); const release = deferred();
  vi.spyOn(member.state.configuration, 'current').mockImplementationOnce(async () => { const value = await current(); entered.resolve(); await release.promise; return value; });
  const delayed = member.configuration();
  try {
    await entered.promise; const before = await hub.state.configuration.current(); before.configuration['x-jevellan'].guards.maxStretchesPerWork = 9;
    const saved = await hub.state.configuration.put({ schema: 'config-write-v1', revision: before.revision, configuration: before.configuration });
    expect((await member.configuration()).revision).toBe(saved.revision); release.resolve(); expect((await delayed).revision).toBe(saved.revision);
    expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('maxStretchesPerWork: 9');
  } finally { release.resolve(); }
});

test('rigging delivery refreshes the shared manifest before preparing an account', async () => {
  const before = await hub.state.configuration.current(); before.configuration['x-jevellan'].routingProfile = 'Changed on the hub before member delivery.';
  await hub.state.configuration.put({ schema: 'config-write-v1', revision: before.revision, configuration: before.configuration });
  const delivered = vi.spyOn(fake, 'materialiseRigging').mockImplementation(async () => { expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('Changed on the hub before member delivery.'); return []; });
  await member.applyRigging(); expect(delivered).toHaveBeenCalledOnce();
});

test('delayed model discovery cannot overwrite a newer shared configuration on the member', async () => {
  const call = member.member!.accountData.bind(member.member!); const entered = deferred(); const release = deferred();
  vi.spyOn(member.member!, 'accountData').mockImplementation(async input => {
    const result = await call(input);
    if (input && typeof input === 'object' && 'operation' in input && input.operation === 'record-models') { entered.resolve(); await release.promise; }
    return result;
  });
  const discovery = member.accounts.discover(accountId);
  try {
    await entered.promise; const current = await hub.state.configuration.current(); current.configuration['x-jevellan'].routingProfile = 'Keep the newer hub guidance.';
    await hub.state.configuration.put({ schema: 'config-write-v1', revision: current.revision, configuration: current.configuration }); await member.configuration();
    release.resolve(); await discovery; expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('Keep the newer hub guidance.');
  } finally { release.resolve(); }
});

test('shutdown during a hub outage stops the member runtime and permits local recovery without a second launch', async () => {
  await create(); const entered = deferred();
  fake.enqueue(async ({ signal }) => { entered.resolve(); await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve(); }); return { status: 'interrupted' }; });
  await choose('reply'); await vi.waitFor(() => expect(fake.starts).toHaveLength(1), { timeout: 20_000 }); await entered.promise;
  offline = true; await member.close(); expect(groupAlive(fake.runs[0]!.native.pgid)).toBe(false);
  member = newMember(); await member.conversations.ready;
  const local = new ConversationWork(member.conversations.ledger('member_work')).load(); expect(local.conversation.state).not.toBe('running'); expect(fake.starts).toHaveLength(1); expect(existsSync(homes.at('hub'))).toBe(false);
}, 60_000);

test.each(['reply', 'implement'] as const)('a member %s resumes its waiting boundary after the hub returns without launching the step twice', async action => {
  await create(); const stream = await watch(); const started = deferred(); const finish = deferred(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => {
    started.resolve(); await finish.promise;
    if (action === 'implement') writeFileSync(join(path, 'value.txt'), '2\n');
    await handoff(input); return { status: 'completed' };
  });
  await choose(action); await started.promise; offline = true; finish.resolve();
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(new ConversationWork(member.conversations.ledger('member_work')).load().handoffs).toHaveLength(1); expect(fake.starts).toHaveLength(1);
  offline = false; await member.presence.pulse();
  // A reachable heartbeat wakes the continuation; its checkpoint and cleanup still have to finish.
  await member.conversations.wait('member_work');
  const resumed = await member.conversations.view('member_work');
  expect(resumed.conversation.state, resumed.pause?.reason).toBe('waiting-for-you'); expect(resumed.stretches[0]?.status).toBe('completed');
  expect(fake.starts).toHaveLength(1);
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  if (action === 'reply') expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); else expect(git(path, 'rev-parse', 'HEAD')).not.toBe(initial);
}, 60_000);

test('an outside edit during a hub wait requires review instead of entering the deferred checkpoint', async () => {
  await create(); const stream = await watch(); const started = deferred(); const finish = deferred(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { started.resolve(); await finish.promise; writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await started.promise; offline = true; finish.resolve();
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  writeFileSync(join(path, 'value.txt'), 'outside edit\n'); offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.conversation.state).toBe('blocked');
  expect(result.checkpointBlocks[0]?.reason).toContain('checkout changed while waiting'); expect(result.stretches[0]?.status).toBe('failed');
  expect(fake.starts).toHaveLength(1); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('outside edit\n');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test.each(['launch', 'decision', 'account-report'] as const)('a member resumes a disconnected %s authority without repeating native work', async boundary => {
  await create(); const stream = await watch(); let reachable = false; let finished = false;
  if (boundary === 'launch') {
    const original = member.accounts.markUsed.bind(member.accounts);
    vi.spyOn(member.accounts, 'markUsed').mockImplementation(async (...args) => { if (!reachable) throw new HubUnavailable('Fixture hub'); return original(...args); });
  } else if (boundary === 'decision') {
    const original = member.conversations.options.jevAvailable!;
    vi.spyOn(member.conversations.options, 'jevAvailable').mockImplementation(async () => { if (finished && !reachable) throw new HubUnavailable('Fixture hub'); return original(); });
  } else {
    const original = member.accounts.recordUsage.bind(member.accounts);
    vi.spyOn(member.accounts, 'recordUsage').mockImplementation(async (...args) => { if (!reachable) throw new HubUnavailable('Fixture hub'); return original(...args); });
  }
  fake.enqueue(async ({ input, emit }) => { if (boundary === 'account-report') emit({ type: 'rate-limit', fiveHourPct: 12 }); await handoff(input); finished = true; return { status: 'completed' }; });
  await choose('reply'); await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(fake.starts).toHaveLength(boundary === 'launch' ? 0 : 1); reachable = true;
  await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.conversation.state).toBe('waiting-for-you'); expect(result.stretches[0]?.status).toBe('completed');
  expect(fake.starts).toHaveLength(1); expect(result.handoffs).toHaveLength(1); expect(git(path, 'status', '--porcelain')).toBe('');
  if (boundary === 'account-report') expect((await member.accounts.list()).find(entry => entry.account.id === accountId)?.statuses[0]?.usage?.fiveHourPct).toBe(12);
}, 60_000);

test('stopping a member at a waiting checkpoint retains the files and never resumes them after restart', async () => {
  await create(); const stream = await watch(); const started = deferred(); const finish = deferred(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { started.resolve(); await finish.promise; writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await started.promise; offline = true; finish.resolve();
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  await member.close(); member = newMember(); await member.conversations.ready; offline = false; await member.presence.pulse();
  const result = await member.conversations.view('member_work'); expect(result.busy).toBe(false); expect(result.stretches[0]?.status).toBe('interrupted');
  expect(result.checkpointBlocks).toHaveLength(1); expect(result.handoffs).toHaveLength(1); expect(fake.starts).toHaveLength(1);
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
}, 60_000);

test.each([false, true])('queued memory continues after an outage following its note write without writing or launching twice; outside edit: %s', async outsideEdit => {
  await create(); const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD'); const noteWritten = deferred(); let writes = 0;
  const projectMemory = member.memory.project.bind(member.memory);
  vi.spyOn(member.memory, 'project').mockImplementation((...args) => {
    const memory = projectMemory(...args); const write = memory.write.bind(memory);
    vi.spyOn(memory, 'write').mockImplementation(async (...input) => { const result = await write(...input); writes++; offline = true; noteWritten.resolve(); return result; });
    return memory;
  });
  fake.enqueue(async ({ input }) => { await handoff(input, { findings: [{ claim: 'memory: Keep the useful finding', pointer: 'value.txt' }] }); return { status: 'completed' }; });
  await choose('reply'); await noteWritten.promise;
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(writes).toBe(1); expect(fake.starts).toHaveLength(1);
  if (outsideEdit) writeFileSync(join(path, 'outside.txt'), 'Preserve the outside contribution.\n');
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  if (outsideEdit) {
    const blocked = await member.conversations.view('member_work'); expect(blocked.conversation.state).toBe('blocked'); expect(blocked.checkpointBlocks[0]?.reason).toContain('checkout changed while waiting');
    expect(writes).toBe(1); expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
    expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Preserve the outside contribution.\n'); return;
  }
  const result = await member.conversations.view('member_work'); expect(result.conversation.state, result.pause?.reason).toBe('waiting-for-you');
  expect(writes).toBe(1); expect(fake.starts).toHaveLength(1); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(git(path, 'rev-parse', 'HEAD')).not.toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  const ledger = member.conversations.ledger('member_work'); const receipts = ledger.events().flatMap(event => { const parsed = MemoryAppliedSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; });
  expect(receipts).toHaveLength(1); expect(receipts[0]?.notes).toMatchObject([{ title: 'Keep the useful finding', outcome: 'written' }]);
}, 90_000);

test.each(['acquire', 'assert', 'release', 'checkout-release'] as const)('publication reconciles a lost successful %s response and finishes without repeating the step or push', async boundary => {
  await create(); const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const checkpoint = git(path, 'rev-parse', 'HEAD'); const push = vi.spyOn(GitWorkspace.prototype, 'push'); let lost = false; const tokens: string[] = [];
  if (boundary === 'checkout-release') {
    const checkout = member.member!.checkout.bind(member.member!);
    vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
      const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
      if (!lost && request.operation === 'put' && !request.claim.held) { lost = true; offline = true; throw new HubUnavailable('Fixture hub'); }
      return result;
    });
  } else {
    const publication = member.member!.publication.bind(member.member!);
    vi.spyOn(member.member!, 'publication').mockImplementation(async input => {
      const result = await publication(input);
      if (result.lease && input && typeof input === 'object' && 'operation' in input && input.operation === 'acquire') tokens.push(result.lease.token);
      if (!lost && input && typeof input === 'object' && 'operation' in input && input.operation === boundary) { lost = true; offline = true; throw new HubUnavailable('Fixture hub'); }
      return result;
    });
  }
  await choose('done'); await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(lost).toBe(true); expect(git(origin, 'rev-parse', 'main')).toBe(['acquire', 'assert'].includes(boundary) ? initial : checkpoint);
  if (boundary === 'checkout-release') expect(checkoutClaims()).toHaveLength(1);
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(result.busy).toBe(false);
  expect(fake.starts).toHaveLength(1); expect(push).toHaveBeenCalledOnce(); expect(git(origin, 'rev-parse', 'main')).toBe(checkpoint); expect(git(path, 'status', '--porcelain')).toBe('');
  const ledger = member.conversations.ledger('member_work'); const waits = ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; });
  expect(waits.at(-1)?.status).toBe('completed'); expect(result.closedWorks).toHaveLength(1);
  expect(ledger.events().filter(event => event.type === 'verification')).toHaveLength(1); expect(checkoutClaims()).toHaveLength(0);
  if (boundary === 'acquire') expect(new Set(tokens).size).toBe(1);
  if (boundary === 'assert') expect(new Set(tokens).size).toBe(2);
}, 90_000);

test.each([
  ['project', 'unchanged'], ['ownership', 'unchanged'], ['files', 'unchanged'], ['metadata', 'unchanged'],
  ['plan', 'unchanged'], ['prepared', 'unchanged'], ['applied-result', 'unchanged'], ['release', 'unchanged'],
  ['files', 'outside-files'], ['files', 'context-files'], ['files', 'settings-refused'], ['plan', 'history'],
  ['files', 'reviewed-prepared'], ['files', 'reviewed-result'], ['files', 'reviewed-stale'],
  ['prepared', 'ref'], ['prepared', 'cancel'], ['prepared', 'restart'], ['applied-result', 'restart'], ['release', 'restart'], ['project', 'message'],
] as const)('context recovery at %s preserves the applied boundary: %s', async (boundary, continuation) => {
  writeFileSync(join(path, 'AGENTS.md'), '# Instructions\nKeep the tests.\n'); writeFileSync(join(path, 'CLAUDE.md'), '# Other instructions\nRun the formatter.\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Instruction files'); git(path, 'push'); const initial = git(path, 'rev-parse', 'HEAD');
  const row = (await member.conversations.projects()).projects[0]!;
  await member.conversations.saveProject({ schema: 'project-write-v1', revision: row.revision, project: { ...row.project, testCommand: 'test -f value.txt' } });
  const before = await member.conversations.contextPanel('project');
  let interrupted = false; const lose = () => { interrupted = true; offline = true; return new HubUnavailable('Fixture hub'); };
  const choose = ProjectContext.prototype.choose;
  const applying = vi.spyOn(ProjectContext.prototype, 'choose').mockImplementation(async function (this: ProjectContext, ...args) {
    const result = await choose.apply(this, args); if (boundary === 'files' && !interrupted) lose(); return result;
  });
  const metadata = member.conversations.options.projects.context.bind(member.conversations.options.projects);
  const metadataWrites = vi.spyOn(member.conversations.options.projects, 'context').mockImplementation(async (...args) => {
    const result = await metadata(...args); if (boundary === 'metadata' && !interrupted && member.conversations.options.contexts.get('context_wait')?.applied) throw lose(); return result;
  });
  if (boundary === 'project') {
    const get = member.conversations.options.projects.get.bind(member.conversations.options.projects);
    vi.spyOn(member.conversations.options.projects, 'get').mockImplementation(async (...args) => { if (!interrupted && member.conversations.options.contexts.get('context_wait')) throw lose(); return get(...args); });
  }
  if (boundary === 'ownership' || boundary === 'release') {
    const checkout = member.member!.checkout.bind(member.member!);
    vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
      const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
      if (!interrupted && request.operation === 'put' && request.claim.held === (boundary === 'ownership')) throw lose(); return result;
    });
  }
  const prepare = GitWorkspace.prototype.planCheckpoint;
  const planning = vi.spyOn(GitWorkspace.prototype, 'planCheckpoint').mockImplementation(async function (this: GitWorkspace, ...args) {
    if (boundary === 'plan' && !interrupted) lose(); const result = await prepare.apply(this, args); if (boundary === 'prepared' && !interrupted) lose(); return result;
  });
  const checkpoint = GitWorkspace.prototype.applyCheckpoint;
  const checkpointing = vi.spyOn(GitWorkspace.prototype, 'applyCheckpoint').mockImplementation(async function (this: GitWorkspace, ...args) {
    const result = await checkpoint.apply(this, args); if (boundary === 'applied-result' && !interrupted) throw lose(); return result;
  });
  const input = { schema: 'context-request-v1', clientRequestId: 'context_wait', revision: before.revision, fingerprint: before.context.fingerprint, choice: boundary === 'release' ? 'leave' : 'keep-agents' };
  await member.conversations.configureContext('project', input).catch(error => expect(error).toBeInstanceOf(HubUnavailable));
  const record = member.conversations.options.contexts.get('context_wait')!; const ledger = member.conversations.ledger(record.conversationId);
  const waits = () => ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; });
  await vi.waitFor(() => {
    const current = member.conversations.options.contexts.get(record.id)!;
    expect(waits().at(-1), `${current.status}: ${current.reason ?? 'awaiting the injected boundary'}`).toMatchObject({ boundary: boundary === 'release' ? 'checkout-release' : 'context', status: 'waiting' });
  }, { timeout: 30_000 });
  expect(interrupted).toBe(true); const prepared = member.conversations.options.contexts.get(record.id)!.checkpointPlan;
  if (boundary !== 'applied-result') expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); else expect(git(path, 'rev-parse', 'HEAD')).toBe(prepared!.after);
  if (continuation === 'outside-files' || continuation.startsWith('reviewed-')) writeFileSync(join(path, 'outside.txt'), 'An outside contribution.\n');
  if (continuation === 'context-files') writeFileSync(join(path, 'AGENTS.md'), '# New outside instructions\n');
  if (continuation === 'history') { writeFileSync(join(path, 'outside.txt'), 'Outside history.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside change'); }
  if (continuation === 'ref') git(path, 'update-ref', `refs/jevellan/checkpoints/${record.conversationId}/${prepared!.id}`, initial);
  if (continuation === 'settings-refused') { const current = (await hub.state.projects.get('project'))!; await expect(Promise.resolve().then(() => hub.state.projects.put({ ...current.project, name: 'Changed project' }, current.revision))).rejects.toThrow('This project is in use.'); }
  const preserved = () => ({ refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage'), status: git(path, 'status', '--porcelain'), instructions: readFileSync(join(path, 'AGENTS.md'), 'utf8') }); const waiting = preserved();
  if (continuation === 'cancel') await member.conversations.cancel(record.conversationId);
  if (continuation === 'restart') { await member.close(); member = newMember(); await member.conversations.ready; }
  if (continuation === 'message') { offline = false; await member.conversations.message(record.conversationId, { schema: 'conversation-message-v1', clientMessageId: 'new_context_message', text: 'Keep this later request before changing the files.' }); }
  offline = false; await member.presence.pulse(); await member.conversations.wait(record.conversationId);
  const completed = member.conversations.options.contexts.get(record.id)!; expect(fake.starts).toHaveLength(0);
  if (!['unchanged', 'settings-refused'].includes(continuation)) {
    expect(completed.status).not.toBe('completed'); expect(preserved()).toEqual(waiting); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
    if (['outside-files', 'context-files'].includes(continuation)) expect(completed.activityReason).toContain('Review');
    if (continuation.startsWith('reviewed-')) {
      expect(completed.activityReason).toContain('Review'); const review = await member.conversations.reviewContext('project', record.id); const previousWait = waits().at(-1)!.id;
      checkpointing.mockImplementationOnce(async function (this: GitWorkspace, ...args) {
        if (continuation === 'reviewed-result') await checkpoint.apply(this, args);
        offline = true; throw new HubUnavailable('Fixture hub');
      });
      await member.conversations.continueContext('project', { schema: 'context-continue-v1', clientRequestId: 'accept_context_wait', operationId: record.id, generation: review.generation, action: 'accept-changes', fingerprint: review.fingerprint }).catch(error => expect(error).toBeInstanceOf(HubUnavailable));
      await vi.waitFor(() => { expect(waits().at(-1)?.id).not.toBe(previousWait); expect(waits().at(-1)).toMatchObject({ boundary: 'context', status: 'waiting' }); }, { timeout: 30_000 });
      const reviewedPlan = member.conversations.options.contexts.get(record.id)!.checkpointPlan!; expect(reviewedPlan.id).toBe('accept_context_wait');
      if (continuation === 'reviewed-stale') writeFileSync(join(path, 'outside.txt'), 'Changed after review.\n');
      const beforeResume = preserved(); offline = false; await member.presence.pulse(); await member.conversations.wait(record.conversationId);
      const accepted = member.conversations.options.contexts.get(record.id)!; expect(accepted.checkpointPlan).toEqual(reviewedPlan); expect(applying).toHaveBeenCalledTimes(1);
      if (continuation === 'reviewed-stale') { expect(accepted.status).toBe('blocked'); expect(preserved()).toEqual(beforeResume); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Changed after review.\n'); expect(git(origin, 'rev-parse', 'main')).toBe(initial); }
      else { expect(accepted, accepted.reason).toMatchObject({ status: 'completed', commit: reviewedPlan.after }); expect(git(origin, 'show', 'main:outside.txt')).toBe('An outside contribution.'); expect(git(origin, 'rev-parse', 'main')).toBe(reviewedPlan.after); }
    }
    if (boundary === 'release') {
      expect(checkoutClaims()).toHaveLength(1);
      const current = await member.conversations.view(record.conversationId);
      await member.conversations.continueContext('project', { schema: 'context-continue-v1', clientRequestId: 'cleanup_after_restart', operationId: record.id, generation: current.conversation.generation, action: 'retry' }); await member.conversations.wait(record.conversationId);
      expect(member.conversations.options.contexts.get(record.id)).toMatchObject({ status: 'completed' }); expect(applying).toHaveBeenCalledTimes(1);
      expect(checkoutClaims()).toHaveLength(0); expect(preserved()).toEqual(waiting);
    }
    return;
  }
  expect(completed, completed.reason).toMatchObject({ status: 'completed', applied: true }); expect(applying).toHaveBeenCalledTimes(1);
  if (boundary === 'release') { expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(completed.commit).toBeUndefined(); }
  else {
    expect(git(path, 'rev-parse', 'HEAD')).toBe(completed.commit); expect(git(origin, 'rev-parse', 'main')).toBe(completed.commit);
    expect(git(path, 'ls-files', '--stage', 'CLAUDE.md')).toContain('120000'); expect(git(origin, 'show', 'main:CLAUDE.md')).toBe('AGENTS.md');
    expect(planning).toHaveBeenCalledTimes(boundary === 'plan' ? 2 : 1); expect(checkpointing).toHaveBeenCalledTimes(boundary === 'prepared' ? 2 : 1);
  }
  expect(metadataWrites).toHaveBeenCalledTimes(1); expect(checkoutClaims()).toHaveLength(0);
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(waits().at(-1)?.status).toBe('completed');
  const head = git(path, 'rev-parse', 'HEAD'); await member.conversations.configureContext('project', input); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(applying).toHaveBeenCalledTimes(1);
}, 60_000);

test.each(['unchanged', 'files', 'cancel', 'restart'] as const)('a context draft waits before launch and retains its request: %s', async continuation => {
  writeFileSync(join(path, 'AGENTS.md'), '# Instructions\nKeep the tests.\n'); writeFileSync(join(path, 'CLAUDE.md'), '# Other instructions\nRun the formatter.\n');
  git(path, 'add', '-A'); git(path, 'commit', '-m', 'Instruction files'); git(path, 'push'); const initial = git(path, 'rev-parse', 'HEAD');
  const row = (await member.conversations.projects()).projects[0]!;
  await member.conversations.saveProject({ schema: 'project-write-v1', revision: row.revision, project: { ...row.project, testCommand: 'test -f value.txt' } });
  const before = await member.conversations.contextPanel('project'); const merged = '# Shared instructions\nKeep the tests.\nRun the formatter.\n';
  fake.enqueue(async ({ input }) => { expect(input.permissions).toBe('read-only'); expect(input.memoryWrite).toBe(false); await handoff(input, { changedFiles: [], result: { type: 'merge-draft', content: merged } }); return { status: 'completed' }; });
  const resolve = member.accounts.resolve.bind(member.accounts); let interrupted = false;
  vi.spyOn(member.accounts, 'resolve').mockImplementation(async (...args) => { if (!interrupted) { interrupted = true; offline = true; throw new HubUnavailable('Fixture hub'); } return resolve(...args); });
  await member.conversations.configureContext('project', { schema: 'context-request-v1', clientRequestId: 'draft_wait', revision: before.revision, fingerprint: before.context.fingerprint, choice: 'merge', modelId: 'fixture' }).catch(error => expect(error).toBeInstanceOf(HubUnavailable));
  const record = member.conversations.options.contexts.get('draft_wait')!; const ledger = member.conversations.ledger(record.conversationId);
  await vi.waitFor(() => expect(ledger.events().some(event => { const value = HubWaitSchema.safeParse(ledger.data(event)); return value.success && value.data.boundary === 'context' && value.data.status === 'waiting'; })).toBe(true), { timeout: 5000 });
  expect(fake.starts).toHaveLength(0); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial);
  if (continuation === 'files') writeFileSync(join(path, 'AGENTS.md'), '# Outside instructions\n');
  if (continuation === 'cancel') await member.conversations.cancel(record.conversationId);
  if (continuation === 'restart') { await member.close(); member = newMember(); await member.conversations.ready; }
  offline = false; await member.presence.pulse(); await member.conversations.wait(record.conversationId);
  if (continuation !== 'unchanged') {
    expect(fake.starts).toHaveLength(0); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(member.conversations.options.contexts.get(record.id)!.status).toMatch(/blocked|cancelled/); return;
  }
  expect(member.conversations.options.contexts.get(record.id)).toMatchObject({ status: 'draft-ready', draft: merged, applied: false }); expect(fake.starts).toHaveLength(1);
  const view = await member.conversations.view(record.conversationId);
  await member.conversations.continueContext('project', { schema: 'context-continue-v1', clientRequestId: 'apply_waited_draft', operationId: record.id, generation: view.conversation.generation, action: 'apply' }); await member.conversations.wait(record.conversationId);
  const result = member.conversations.options.contexts.get(record.id)!; expect(result, result.reason).toMatchObject({ status: 'completed', draft: merged, applied: true });
  expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toBe(merged); expect(git(origin, 'rev-parse', 'main')).toBe(result.commit); expect(fake.starts).toHaveLength(1);
}, 60_000);

test.each([
  ['reset', 'ownership', 'unchanged'], ['reset', 'plan', 'unchanged'], ['reset', 'saved', 'unchanged'], ['reset', 'applied', 'unchanged'], ['reset', 'guard', 'unchanged'],
  ['revert', 'saved', 'unchanged'], ['revert', 'applied', 'unchanged'], ['following', 'ownership', 'unchanged'],
  ['reset', 'saved', 'files'], ['reset', 'saved', 'history'], ['reset', 'saved', 'ref'], ['reset', 'saved', 'cancel'], ['reset', 'saved', 'message'], ['reset', 'saved', 'restart'], ['reset', 'applied', 'restart'],
] as const)('undo waits at %s/%s and preserves its boundary: %s', async (mode, boundary, continuation) => {
  const project = (await member.state.projects.get('project'))!;
  await member.conversations.saveProject({ schema: 'project-write-v1', revision: project.revision, project: { ...project.project, testCommand: 'test -f value.txt' } });
  const created = await create(); const originalWork = created.conversation.work!.id; const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work');
  if (mode !== 'reset') { await choose('done'); await member.conversations.wait('member_work'); }
  if (mode === 'following') {
    await body(await request(memberBase, '/api/conversations/member_work/messages', cookie, { schema: 'conversation-message-v1', clientMessageId: 'following', text: 'Make a second change to three.' }));
    fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '3\n'); await handoff(input); return { status: 'completed' }; });
    await choose('implement'); await member.conversations.wait('member_work');
  }
  const checkpoint = git(path, 'rev-parse', 'HEAD'); const launches = fake.starts.length; const ledger = member.conversations.ledger('member_work');
  const original = GitWorkspace.prototype.applyUndo; let saved = ''; let interrupted = false;
  const applying = vi.spyOn(GitWorkspace.prototype, 'applyUndo').mockImplementation(async function (this: GitWorkspace, plan, current, record) {
    const result = await original.call(this, plan, current, prepared => { record(prepared); saved = prepared.savedRef; if (boundary === 'saved' && !interrupted) { interrupted = true; offline = true; } });
    if (boundary === 'applied' && !interrupted) { interrupted = true; offline = true; throw new HubUnavailable('Fixture hub'); } return result;
  });
  const originalPlan = GitWorkspace.prototype.planUndo;
  const planning = vi.spyOn(GitWorkspace.prototype, 'planUndo').mockImplementation(async function (this: GitWorkspace, ...args) {
    if (boundary === 'plan' && !interrupted) { interrupted = true; offline = true; } return originalPlan.apply(this, args);
  });
  let released = 0; const checkout = member.member!.checkout.bind(member.member!);
  vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
    const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
    if (request.operation === 'put' && !request.claim.held) released++;
    if (boundary === 'ownership' && !interrupted && request.operation === 'put' && request.claim.held && request.claim.workId === originalWork) { interrupted = true; offline = true; throw new HubUnavailable('Fixture hub'); } return result;
  });
  const originalView = member.conversations.view.bind(member.conversations);
  vi.spyOn(member.conversations, 'view').mockImplementation(async id => {
    if (boundary === 'guard' && !interrupted && ledger.events().some(event => event.type === 'undo')) { interrupted = true; offline = true; } return originalView(id);
  });
  fake.enqueue(async ({ input }) => { expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); await handoff(input); return { status: 'completed' }; });
  const view = await member.conversations.view('member_work');
  const input = { schema: 'correct-step-v1', clientRequestId: 'undo_wait', generation: view.conversation.generation, stretch: 1, mode: 'redo', choices: { action: 'reply' } };
  await body(await request(memberBase, '/api/conversations/member_work/correct', cookie, input), 202);
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(interrupted).toBe(true); expect(fake.starts).toHaveLength(launches);
  if (saved) expect(git(path, 'rev-parse', saved)).toBe(checkpoint);
  const prepared = applying.mock.calls[0]?.[0];
  expect(git(path, 'rev-parse', 'HEAD')).toBe(['applied', 'guard'].includes(boundary) ? prepared!.resultCommit : checkpoint);
  expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)).toMatchObject({ boundary: 'undo', status: 'waiting' });
  if (continuation === 'files') writeFileSync(join(path, 'value.txt'), 'An outside edit\n');
  if (continuation === 'history') { writeFileSync(join(path, 'outside.txt'), 'An outside commit\n'); git(path, 'add', 'outside.txt'); git(path, 'commit', '-m', 'Outside change'); }
  if (continuation === 'ref') git(path, 'update-ref', saved, initial);
  const preserved = () => ({ refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage'), status: git(path, 'status', '--porcelain'), value: readFileSync(join(path, 'value.txt'), 'utf8') }); const waiting = preserved();
  if (continuation === 'restart') { await member.close(); member = newMember(); await member.conversations.ready; }
  if (continuation === 'cancel') { offline = false; await member.conversations.cancel('member_work'); }
  if (continuation === 'message') { offline = false; await body(await request(memberBase, '/api/conversations/member_work/messages', cookie, { schema: 'conversation-message-v1', clientMessageId: 'message_during_undo', text: 'Keep this newer message before changing the checkout.' })); }
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.busy).toBe(false); expect(released).toBe(0);
  if (continuation !== 'unchanged') {
    expect(result.redos.at(-1)).toMatchObject({ status: 'blocked' }); expect(fake.starts).toHaveLength(launches); expect(preserved()).toEqual(waiting); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
    if (continuation === 'message') expect(result.messages.some(message => JSON.stringify(message).includes('Keep this newer message'))).toBe(true);
    expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)?.status).toBe('interrupted'); return;
  }
  expect(result.redos.at(-1), result.pause?.reason).toMatchObject({ status: 'completed', plan: { mode: mode === 'reset' ? 'reset' : 'revert' }, result: { after: git(path, 'rev-parse', 'HEAD') } });
  expect(result.stretches.map(step => step.status)).toEqual([...Array(launches).fill('undone'), 'completed']); expect(fake.starts).toHaveLength(launches + 1);
  expect(git(path, 'rev-parse', saved)).toBe(checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(mode === 'reset' ? initial : git(path, 'rev-parse', 'HEAD')); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(planning).toHaveBeenCalledTimes(boundary === 'plan' ? 2 : 1);
  if (prepared) for (const call of applying.mock.calls) expect(call[0]).toEqual(prepared);
  expect(ledger.events().filter(event => event.type === 'undo')).toHaveLength(1);
  expect(await member.conversations.ownership.current(project.project)).toMatchObject({ held: true, workId: originalWork });
  const count = ledger.events().length; await body(await request(memberBase, '/api/conversations/member_work/correct', cookie, input), 202); expect(ledger.events()).toHaveLength(count);
}, 90_000);

test.each([
  ['project', 'unchanged'], ['ownership', 'unchanged'], ['release', 'unchanged'], ['after-release', 'unchanged'],
  ['project', 'files'], ['project', 'history'], ['project', 'unpublished'], ['project', 'repeat'],
  ['release', 'files'], ['release', 'newer-owner'], ['project', 'restart'], ['release', 'restart'],
] as const)('cancellation cleanup at %s preserves closed work: %s', async (boundary, continuation) => {
  await create(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { if (continuation === 'unpublished') writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input, { changedFiles: continuation === 'unpublished' ? ['value.txt'] : [] }); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work');
  const original = (await member.conversations.view('member_work')).conversation.work!; const project = (await member.conversations.projects()).projects.find(entry => entry.project.id === 'project')!;
  const ledger = member.conversations.ledger('member_work');
  const waits = () => ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; });
  const release = member.conversations.ownership.release.bind(member.conversations.ownership); let released = false; let interrupted = false;
  const releasing = vi.spyOn(member.conversations.ownership, 'release').mockImplementation(async (...args) => { await release(...args); released = true; });
  if (boundary === 'project') offline = true;
  if (boundary === 'ownership' || boundary === 'after-release') {
    const current = member.conversations.ownership.current.bind(member.conversations.ownership);
    vi.spyOn(member.conversations.ownership, 'current').mockImplementation(async (...args) => {
      if (!interrupted && (boundary === 'ownership' || released)) { interrupted = true; offline = true; throw new HubUnavailable('Fixture hub'); }
      return current(...args);
    });
  }
  if (boundary === 'release') {
    const checkout = member.member!.checkout.bind(member.member!);
    vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
      const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
      if (!interrupted && request.operation === 'put' && !request.claim.held) { interrupted = true; offline = true; throw new HubUnavailable('Fixture hub'); }
      return result;
    });
  }
  const cancelled = boundary === 'project' ? await member.conversations.cancel('member_work') : ConversationPublicSchema.parse(await body(await request(memberBase, '/api/conversations/member_work/cancel', cookie, { schema: 'empty-request-v1' })));
  expect(cancelled.conversation).toMatchObject({ state: 'cancelled', work: null });
  expect(cancelled.closedWorks).toEqual([expect.objectContaining({ id: original.id, closedAs: 'cancelled' })]);
  expect(cancelled.allowed).toEqual([]); expect(cancelled.busy).toBe(true);
  await vi.waitFor(() => expect(waits().at(-1)).toMatchObject({ boundary: 'checkout-release', status: 'waiting', workId: original.id }));
  expect(checkoutClaims()).toHaveLength(boundary === 'after-release' ? 0 : 1);
  if (continuation === 'repeat') {
    const repeated = await member.conversations.cancel('member_work'); expect(repeated.busy).toBe(true); expect(repeated.closedWorks).toEqual(cancelled.closedWorks);
    expect(waits()).toHaveLength(1); expect(waits()[0]?.status).toBe('waiting');
  }
  if (continuation === 'files') writeFileSync(join(path, 'value.txt'), 'Outside edits\n');
  if (continuation === 'history') { writeFileSync(join(path, 'outside.txt'), 'Outside commit\n'); git(path, 'add', 'outside.txt'); git(path, 'commit', '-m', 'Outside change'); }
  if (continuation === 'newer-owner') {
    offline = false;
    await member.conversations.ownership.acquire(project.project, { conversationId: 'other_conversation', conversationTitle: 'Other conversation', workId: 'other_work' });
  }
  const preserved = () => ({ refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage'), status: git(path, 'status', '--porcelain'), value: readFileSync(join(path, 'value.txt'), 'utf8') }); const waiting = preserved();
  if (continuation === 'restart') { await member.close(); member = newMember(); await member.conversations.ready; }
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work');
  expect(result.conversation).toEqual({ ...cancelled.conversation, updatedAt: expect.any(String) }); expect(result.closedWorks).toEqual(cancelled.closedWorks); expect(result.busy).toBe(false);
  expect(waits().at(-1)?.status).toBe(continuation === 'restart' ? 'interrupted' : 'completed'); expect(fake.starts).toHaveLength(1);
  expect(preserved()).toEqual(waiting); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  const retained = continuation === 'restart' || continuation === 'newer-owner' || boundary === 'project' && ['files', 'history', 'unpublished'].includes(continuation);
  expect(checkoutClaims()).toHaveLength(retained ? 1 : 0);
  if (continuation === 'newer-owner') expect(await member.conversations.ownership.current(project.project)).toMatchObject({ held: true, workId: 'other_work', conversationId: 'other_conversation' });
  if (boundary === 'project' && ['files', 'history', 'unpublished', 'restart'].includes(continuation)) expect(releasing).not.toHaveBeenCalled();
}, 60_000);

test.each([false, true])('cancelling a writing member settles its files once without waiting offline: %s', async disconnect => {
  await create(); const initial = git(path, 'rev-parse', 'HEAD'); const started = deferred();
  fake.enqueue(async ({ signal }) => {
    writeFileSync(join(path, 'value.txt'), '2\n'); started.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { status: 'interrupted' };
  });
  await choose('implement'); await started.promise; const pgid = fake.runs[0]!.native.pgid; offline = disconnect;
  const cancelled = await member.conversations.cancel('member_work');
  expect(cancelled.conversation).toMatchObject({ state: 'cancelled', work: null });
  expect(groupAlive(pgid)).toBe(false); expect(fake.starts).toHaveLength(1);
  const ledger = member.conversations.ledger('member_work'); const view = new ConversationWork(ledger).load(); const head = git(path, 'rev-parse', 'HEAD');
  const blocks = ledger.events().flatMap(event => { const parsed = CheckpointBlockSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data.reason] : []; });
  expect(view.conversation.work).toBeNull(); expect(view.closedWorks).toMatchObject([{ closedAs: 'cancelled' }]);
  expect(view.stretches[0]?.status).toBe('interrupted'); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n'); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  if (disconnect) { expect(head).toBe(initial); expect(view.stretches[0]?.gitAfter).toBeUndefined(); expect(git(path, 'status', '--porcelain')).not.toBe(''); }
  else { expect(head, blocks.join('\n')).not.toBe(initial); expect(view.stretches[0]?.gitAfter).toBe(head); expect(git(path, 'status', '--porcelain')).toBe(''); }
  await member.close(); offline = false; member = newMember(); await member.conversations.ready; await member.presence.pulse();
  expect(fake.starts).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(head); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
  expect(checkoutClaims()).toHaveLength(1);
}, 60_000);

test.each(['unchanged', 'closed', 'files', 'head', 'ref', 'published', 'cancel', 'restart'] as const)('discard waits after saving its recovery ref and preserves the boundary: %s', async continuation => {
  await create(); const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  if (continuation === 'closed') {
    const current = await member.conversations.view('member_work');
    await body(await request(memberBase, '/api/conversations/member_work/settle', cookie, { schema: 'settle-work-v1', clientRequestId: 'keep_first', workId: current.conversation.work!.id, generation: current.conversation.generation, choice: 'keep' }), 202);
    await member.conversations.wait('member_work');
  }
  const original = GitWorkspace.prototype.discard; let saved = ''; let interrupted = false;
  vi.spyOn(GitWorkspace.prototype, 'discard').mockImplementation(function (this: GitWorkspace, base, head, n, current, record, ...rest) {
    return original.call(this, base, head, n, current, ref => { record?.(ref); saved = ref; if (!interrupted) { interrupted = true; offline = true; } }, ...rest);
  });
  const view = await member.conversations.view('member_work');
  const input = { schema: 'settle-work-v1', clientRequestId: 'discard_wait', workId: (view.conversation.work ?? view.closedWorks.at(-1))!.id, generation: view.conversation.generation, choice: 'discard' };
  await body(await request(memberBase, '/api/conversations/member_work/settle', cookie, input), 202);
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 });
  expect(interrupted).toBe(true); expect(git(path, 'rev-parse', saved)).toBe(checkpoint); expect(git(path, 'rev-parse', 'HEAD')).toBe(checkpoint);
  const ledger = member.conversations.ledger('member_work');
  expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)).toMatchObject({ boundary: 'settlement', status: 'waiting' });
  if (continuation === 'files') writeFileSync(join(path, 'value.txt'), 'An outside edit\n');
  if (continuation === 'head') { writeFileSync(join(path, 'outside.txt'), 'An outside commit\n'); git(path, 'add', 'outside.txt'); git(path, 'commit', '-m', 'Outside change'); }
  if (continuation === 'ref') git(path, 'update-ref', saved, initial);
  if (continuation === 'published') git(path, 'push');
  const beforeResume = { refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage'), status: git(path, 'status', '--porcelain'), value: readFileSync(join(path, 'value.txt'), 'utf8') };
  if (continuation === 'restart') { await member.close(); delete memberOptions.application; member = newMember(); await member.conversations.ready; }
  if (continuation === 'cancel') { offline = false; await member.conversations.cancel('member_work'); }
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work');
  if (!['unchanged', 'closed'].includes(continuation)) {
    expect(result.settlements.at(-1)).toMatchObject({ status: 'blocked', savedRef: saved }); expect(result.busy).toBe(false); expect(fake.starts).toHaveLength(1);
    expect({ refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage'), status: git(path, 'status', '--porcelain'), value: readFileSync(join(path, 'value.txt'), 'utf8') }).toEqual(beforeResume);
    expect(git(origin, 'rev-parse', 'main')).toBe(continuation === 'published' ? checkpoint : initial); expect(checkoutClaims()).toHaveLength(1);
    expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)?.status).toBe('interrupted'); return;
  }
  expect(result.settlements.at(-1), result.pause?.reason).toMatchObject({ status: 'completed', retained: false, savedRef: saved });
  expect(result.closedWorks).toHaveLength(1); expect(result.conversation.work).toBeNull(); expect(result.busy).toBe(false); expect(fake.starts).toHaveLength(1);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'rev-parse', saved)).toBe(checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('1\n'); expect(checkoutClaims()).toHaveLength(0);
  const count = ledger.events().length; await body(await request(memberBase, '/api/conversations/member_work/settle', cookie, input), 202); expect(ledger.events()).toHaveLength(count);
}, 90_000);

test.each(['keep', 'discard', 'publish'] as const)('closing work with %s waits for lost checkout admission without repeating the runtime', async choice => {
  await create(); const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  const checkout = member.member!.checkout.bind(member.member!); let lost = false;
  vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
    const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
    if (!lost && request.operation === 'put' && request.claim.held) { lost = true; offline = true; throw new HubUnavailable('Fixture hub'); }
    return result;
  });
  const view = await member.conversations.view('member_work');
  await body(await request(memberBase, '/api/conversations/member_work/settle', cookie, { schema: 'settle-work-v1', clientRequestId: 'close_wait', workId: view.conversation.work!.id, generation: view.conversation.generation, choice }), 202);
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 }); expect(lost).toBe(true);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(initial);
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.settlements.at(-1), result.pause?.reason).toMatchObject({ status: 'completed', retained: choice === 'keep' });
  expect(fake.starts).toHaveLength(1); expect(result.closedWorks).toHaveLength(1); expect(result.conversation.work).toBeNull(); expect(result.busy).toBe(false);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(choice === 'discard' ? initial : checkpoint); expect(git(origin, 'rev-parse', 'main')).toBe(choice === 'publish' ? checkpoint : initial);
  expect(checkoutClaims()).toHaveLength(choice === 'keep' ? 1 : 0);
}, 90_000);

test.each(['keep', 'discard'] as const)('closing work with %s reconciles a lost release after closure without repeating Git changes', async choice => {
  await create(); const stream = await watch(); const initial = git(path, 'rev-parse', 'HEAD');
  fake.enqueue(async ({ input }) => { if (choice === 'discard') writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input, { changedFiles: choice === 'discard' ? ['value.txt'] : [] }); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work');
  const discard = vi.spyOn(GitWorkspace.prototype, 'discard'); const checkout = member.member!.checkout.bind(member.member!); let lost = false;
  vi.spyOn(member.member!, 'checkout').mockImplementation(async input => {
    const result = await checkout(input); const request = CheckoutStoreRequestSchema.parse(input);
    if (!lost && request.operation === 'put' && !request.claim.held) { lost = true; offline = true; throw new HubUnavailable('Fixture hub'); }
    return result;
  });
  const view = await member.conversations.view('member_work');
  await body(await request(memberBase, '/api/conversations/member_work/settle', cookie, { schema: 'settle-work-v1', clientRequestId: 'close_release', workId: view.conversation.work!.id, generation: view.conversation.generation, choice }), 202);
  await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 20_000 }); expect(lost).toBe(true);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(checkoutClaims()).toHaveLength(1);
  const ledger = member.conversations.ledger('member_work'); expect(new ConversationWork(ledger).load().closedWorks).toHaveLength(1);
  expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)).toMatchObject({ boundary: 'checkout-release', status: 'waiting' });
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(result.settlements.at(-1)).toMatchObject({ status: 'completed', retained: false });
  expect(fake.starts).toHaveLength(1); expect(discard).toHaveBeenCalledTimes(choice === 'discard' ? 1 : 0); expect(result.closedWorks).toHaveLength(1); expect(result.busy).toBe(false);
  expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(checkoutClaims()).toHaveLength(0);
}, 90_000);

test.each(['unchanged', 'files', 'index', 'metadata', 'restart'] as const)('an outage inside a conflicted memory rebase preserves its boundary: %s', async continuation => {
  const note = '.jevellan/memory/convention.md'; mkdirSync(join(path, '.jevellan/memory'), { recursive: true });
  const content = (text: string) => `---\ntitle: Convention\npermalink: convention\n---\n${text}\n`;
  writeFileSync(join(path, note), content('Base convention.')); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Seed memory'); git(path, 'push');
  await create(); const stream = await watch();
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, note), content('Local convention.')); await handoff(input, { changedFiles: [note] }); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const checkpoint = git(path, 'rev-parse', 'HEAD');
  const other = join(root, 'upstream'); git(root, 'clone', origin, other); writeFileSync(join(other, note), content('Upstream quartz convention.')); git(other, 'add', '-A'); git(other, 'commit', '-m', 'Update upstream memory'); git(other, 'push');
  const upstream = git(origin, 'rev-parse', 'main'); const rebase = GitWorkspace.prototype.rebase; const acquire = vi.spyOn(member.conversations.leases, 'acquire'); let lost = false;
  vi.spyOn(GitWorkspace.prototype, 'rebase').mockImplementation(function (this: GitWorkspace, options = {}) {
    return rebase.call(this, { ...options, resolveConflicts: async files => {
      if (!lost) { lost = true; offline = true; }
      return options.resolveConflicts ? options.resolveConflicts(files) : null;
    } });
  });
  await choose('done'); await vi.waitFor(() => expect(stream.text()).toContain("Can't reach the hub"), { timeout: 15_000 });
  expect(lost).toBe(true); expect(existsSync(join(path, '.git/rebase-merge'))).toBe(true); expect(git(origin, 'rev-parse', 'main')).toBe(upstream);
  const ledger = member.conversations.ledger('member_work');
  expect(ledger.events().flatMap(event => { const parsed = HubWaitSchema.safeParse(ledger.data(event)); return parsed.success ? [parsed.data] : []; }).at(-1)?.boundary).toBe('integration-abort');
  const todo = join(path, '.git/rebase-merge/git-rebase-todo');
  if (continuation === 'files') writeFileSync(join(path, note), content('Preserve this outside resolution.'));
  if (continuation === 'index') git(path, 'add', '--', note);
  if (continuation === 'metadata') writeFileSync(todo, readFileSync(todo, 'utf8') + '\n# Preserve this outside instruction.\n');
  const preserved = () => ({ head: git(path, 'rev-parse', 'HEAD'), refs: git(path, 'show-ref'), index: git(path, 'ls-files', '--stage', '-z'), note: readFileSync(join(path, note), 'utf8'), todo: readFileSync(todo, 'utf8') });
  const waiting = preserved();
  if (continuation === 'restart') { await member.close(); member = newMember(); await member.conversations.ready; }
  offline = false; await member.presence.pulse(); await member.conversations.wait('member_work');
  const result = await member.conversations.view('member_work'); expect(fake.starts).toHaveLength(1); expect(result.busy).toBe(false);
  if (continuation !== 'unchanged') {
    expect(result.conversation.state).not.toBe('done');
    if (continuation !== 'restart') expect(result.pause?.reason).toContain('checkout changed while waiting');
    expect(existsSync(join(path, '.git/rebase-merge'))).toBe(true); expect(preserved()).toEqual(waiting); expect(git(origin, 'rev-parse', 'main')).toBe(upstream); return;
  }
  expect(result.conversation.state, result.pause?.reason).toBe('done'); expect(acquire).toHaveBeenCalledTimes(2);
  expect(git(path, 'status', '--porcelain')).toBe(''); expect(existsSync(join(path, '.git/rebase-merge'))).toBe(false); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
  expect(readFileSync(join(path, note), 'utf8')).toContain('Local convention.'); expect(readFileSync(join(path, note), 'utf8')).toContain('Upstream quartz convention.');
  expect(git(path, 'show', `${checkpoint}:${note}`)).toContain('Local convention.');
}, 90_000);

test('legacy hub rigging receipts migrate to the device file and survive another startup', async () => {
  const receipt = await hub.applyRigging(); hub.hub.put('rigging-application', hub.device.deviceId, RiggingApplicationSchema, receipt, 0);
  const hubHomes = hub.homes; await hub.close();
  hub = new Application({ homes: hubHomes, timers: false, runtimes: () => new Map() }); hubOptions.application = hub; hub.conversations.daemonUrl = hubBase; await hub.conversations.ready;
  expect(hub.riggingApplication()).toEqual(receipt); expect(hub.hub.get('rigging-application', hub.device.deviceId, RiggingApplicationSchema)).toBeNull();
});

function externalJournal(at = Date.now()) {
  const directory = join(homes.userHome, '.claude', 'projects', 'fixture'); mkdirSync(directory, { recursive: true }); const journal = join(directory, 'synthetic-session.jsonl');
  writeFileSync(journal, JSON.stringify({ type: 'user', cwd: path, message: { content: 'Synthetic outside work.' } }) + '\n'); utimesSync(journal, new Date(at), new Date(at)); return journal;
}
function quietJournal(journal: string) { const old = new Date(Date.now() - 10 * 60_000); utimesSync(journal, old, old); }

test('member heartbeats carry local execution, checkout and external metadata and an outage does not kill the step', async () => {
  externalJournal(Date.now() - 1000); await create(); const started = deferred(); const finish = deferred();
  fake.enqueue(async ({ input }) => { started.resolve(); await finish.promise; await handoff(input); return { status: 'completed' }; });
  try {
    await choose('reply'); await vi.waitFor(() => expect(fake.starts).toHaveLength(1), { timeout: 20_000 }); await started.promise;
    expect(await member.presence.pulse()).toMatchObject({ runningConversations: ['member_work'], projects: [{ projectId: 'project', path, branch: 'main', dirty: false }], externalSessions: [{ runtime: 'claude', cwd: path, projectId: 'project' }] });
    expect(hub.devices.view(member.device.deviceId)).toMatchObject({ status: 'online', heartbeat: { runningConversations: ['member_work'] } });
    offline = true; expect(await member.presence.pulse()).toBeNull(); expect(groupAlive(fake.runs[0]!.native.pgid)).toBe(true);
    offline = false; finish.resolve(); await member.conversations.wait('member_work'); expect((await member.presence.pulse())?.runningConversations).toEqual([]);
    expect((await member.conversations.view('member_work')).stretches[0]?.status).toBe('completed');
  } finally { offline = false; finish.resolve(); }
}, 60_000);

test('an external writer blocks launch and Retry starts the recorded manual choice after that journal goes quiet', async () => {
  const journal = externalJournal(Date.now() - 1000); const initial = git(path, 'rev-parse', 'HEAD'); await create();
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work');
  const blocked = await member.conversations.view('member_work'); expect(blocked.pause?.reason).toBe('Another agent (Claude Code) is active in Member project on Fixture member.');
  expect(fake.starts).toHaveLength(0); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(git(path, 'status', '--porcelain')).toBe('');
  expect(blocked.externalWait?.source).toBe('manual'); quietJournal(journal);
  const retry = { schema: 'retry-external-activity-v1', waitId: blocked.externalWait!.id, generation: blocked.conversation.generation };
  await body(await request(memberBase, '/api/conversations/member_work/retry-external', cookie, retry), 202); await member.conversations.wait('member_work');
  expect(fake.starts).toHaveLength(1); expect((await member.conversations.view('member_work')).stretches[0]?.status).toBe('completed');
  expect((await request(memberBase, '/api/conversations/member_work/retry-external', cookie, retry)).status).toBe(409);
  await choose('done'); await member.conversations.wait('member_work'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
}, 90_000);

test('outside activity during a member step lets execution finish and requires reviewed adoption before publication, even after restart', async () => {
  const initial = git(path, 'rev-parse', 'HEAD'); let journal = ''; const observed = deferred(); const finish = deferred(); await create();
  fake.enqueue(async ({ input }) => {
    writeFileSync(join(path, 'value.txt'), '2\n'); journal = externalJournal(); observed.resolve();
    await finish.promise; await handoff(input); return { status: 'completed' };
  });
  try {
    await choose('implement'); await vi.waitFor(() => expect(fake.starts).toHaveLength(1), { timeout: 20_000 }); await observed.promise;
    await member.presence.pulse(); expect((await member.conversations.view('member_work')).checkpointBlocks).toHaveLength(1); expect(groupAlive(fake.runs[0]!.native.pgid)).toBe(true);
  } finally { finish.resolve(); }
  await member.conversations.wait('member_work');
  let blocked = await member.conversations.view('member_work'); expect(blocked.checkpointBlocks).toHaveLength(1); expect(blocked.checkpointBlocks[0]?.reason).toContain('Claude Code started working');
  expect(blocked.handoffs).toHaveLength(1); expect(git(path, 'rev-parse', 'HEAD')).toBe(initial); expect(readFileSync(join(path, 'value.txt'), 'utf8')).toBe('2\n');
  quietJournal(journal); await member.close(); member = newMember(); await member.conversations.ready; blocked = await member.conversations.view('member_work'); expect(blocked.checkpointBlocks).toHaveLength(1);
  expect((await request(memberBase, '/api/conversations/member_work/manual', cookie, { schema: 'manual-step-v1', generation: blocked.conversation.generation, action: 'done', remember: false })).status).toBe(409);
  const changes = ConversationChangesSchema.parse(await body(await request(memberBase, '/api/conversations/member_work/changes/1', cookie))); expect(changes.uncommitted).toContain('+2'); expect(changes.recovery?.fingerprint).toBeTruthy();
  await body(await request(memberBase, '/api/conversations/member_work/adopt-changes', cookie, { schema: 'adopt-changes-v1', clientRequestId: 'outside_review', workId: blocked.conversation.work!.id, stretch: 1, generation: changes.recovery!.generation, fingerprint: changes.recovery!.fingerprint }), 202);
  await member.conversations.wait('member_work'); expect((await member.conversations.view('member_work')).checkpointBlocks).toEqual([]); expect(fake.starts).toHaveLength(1);
  // The blocked step never answered the request; a completed reply must answer it before Done is available.
  fake.enqueue(async ({ input }) => { await handoff(input); return { status: 'completed' }; }); await choose('reply'); await member.conversations.wait('member_work');
  expect(git(origin, 'rev-parse', 'main')).toBe(initial); await choose('done'); await member.conversations.wait('member_work'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
  expect(fake.starts.map((step) => step.action)).toEqual(['implement', 'reply']);
}, 90_000);

test('outside activity discovered during publication coordination prevents pushing and can retry without another runtime step', async () => {
  const initial = git(origin, 'rev-parse', 'main'); await create();
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const original = member.conversations.leases.assert.bind(member.conversations.leases); let journal = '';
  vi.spyOn(member.conversations.leases, 'assert').mockImplementationOnce(async lease => { await original(lease); journal = externalJournal(); });
  await choose('done'); await member.conversations.wait('member_work'); const blocked = await member.conversations.view('member_work');
  expect(blocked.pause?.reason).toContain('Another agent'); expect(git(origin, 'rev-parse', 'main')).toBe(initial); expect(blocked.externalWait?.choice.action).toBe('done');
  quietJournal(journal); await body(await request(memberBase, '/api/conversations/member_work/retry-external', cookie, { schema: 'retry-external-activity-v1', waitId: blocked.externalWait!.id, generation: blocked.conversation.generation }), 202);
  await member.conversations.wait('member_work'); expect(fake.starts).toHaveLength(1); expect((await member.conversations.view('member_work')).conversation.state).toBe('done'); expect(git(path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'main'));
}, 90_000);

test('outside files introduced during launch preparation cannot enter a later writing step after activity becomes quiet', async () => {
  await create(); let journal = ''; const markUsed = member.accounts.markUsed.bind(member.accounts);
  vi.spyOn(member.accounts, 'markUsed').mockImplementationOnce(async (...args) => { await markUsed(...args); journal = externalJournal(); writeFileSync(join(path, 'outside.txt'), 'Outside before launch.\n'); });
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const blocked = await member.conversations.view('member_work'); expect(fake.starts).toHaveLength(0); expect(blocked.externalWait).toBeDefined(); quietJournal(journal);
  const retry = { schema: 'retry-external-activity-v1', waitId: blocked.externalWait!.id, generation: blocked.conversation.generation };
  await body(await request(memberBase, '/api/conversations/member_work/retry-external', cookie, retry), 202); await member.conversations.wait('member_work');
  expect(fake.starts).toHaveLength(0); expect((await member.conversations.view('member_work')).pause?.reason).toContain('uncommitted changes before the writing step'); expect(readFileSync(join(path, 'outside.txt'), 'utf8')).toBe('Outside before launch.\n');
  rmSync(join(path, 'outside.txt')); await body(await request(memberBase, '/api/conversations/member_work/retry-external', cookie, retry), 202); await member.conversations.wait('member_work'); expect(fake.starts).toHaveLength(1); expect((await member.conversations.view('member_work')).stretches[0]?.status).toBe('completed');
}, 90_000);

test('a pre-launch outside commit remains unowned after its journal becomes quiet', async () => {
  await create(); let journal = ''; const markUsed = member.accounts.markUsed.bind(member.accounts);
  vi.spyOn(member.accounts, 'markUsed').mockImplementationOnce(async (...args) => { await markUsed(...args); journal = externalJournal(); writeFileSync(join(path, 'outside.txt'), 'Outside before launch.\n'); git(path, 'add', '-A'); git(path, 'commit', '-m', 'Outside before launch'); });
  fake.enqueue(async ({ input }) => { writeFileSync(join(path, 'value.txt'), '2\n'); await handoff(input); return { status: 'completed' }; });
  await choose('implement'); await member.conversations.wait('member_work'); const blocked = await member.conversations.view('member_work'); const before = git(path, 'rev-parse', 'HEAD'); const refs = git(path, 'show-ref'); expect(fake.starts).toHaveLength(0); expect(blocked.externalWait).toBeDefined(); quietJournal(journal);
  await body(await request(memberBase, '/api/conversations/member_work/retry-external', cookie, { schema: 'retry-external-activity-v1', waitId: blocked.externalWait!.id, generation: blocked.conversation.generation }), 202); await member.conversations.wait('member_work');
  expect(fake.starts).toHaveLength(0); expect(git(path, 'rev-parse', 'HEAD')).toBe(before); expect(git(path, 'show-ref')).toBe(refs); expect((await member.conversations.view('member_work')).pause?.reason).toMatch(/Git history|unrecorded/);
}, 90_000);
