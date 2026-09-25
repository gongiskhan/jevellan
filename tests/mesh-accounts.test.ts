import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountHubRequestSchema, CredentialCaptureReceiptSchema, DeviceSchema, Homes, SecretRedactor, type AccountStatus } from '../packages/core/dist/index.js';
import { HubAccounts, HubDatabase, HubUnavailable, MemberAccounts, MemberHubClient, joinMember, memberConnection } from '../packages/mesh/dist/index.js';
import { AccountService } from '../packages/accounts/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { FakeRuntime, type RuntimeAdapter } from '../packages/runtime-contract/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string; let homes: Homes;
let connection: MemberHubClient; let repository: MemberAccounts; let service: AccountService; let runtime: RuntimeAdapter; let redactor: SecretRedactor;
const services: AccountService[] = [];
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function accountService(store = repository, prepare?: (account: Awaited<ReturnType<AccountService['resolve']>>) => Promise<void>) {
  const result = new AccountService({ store, homes, redactor, deviceId: connection.deviceId, runtimes: new Map([['claude', runtime], ['codex', { ...runtime, id: 'codex' }]]), timers: false, ...(prepare ? { prepare } : {}) });
  services.push(result); return result;
}
function add(secret = `fixture-${randomUUID()}`) { return service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Member account', kind: 'subscription', secret }); }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-mesh-accounts-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!;
  app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  redactor = new SecretRedactor(); homes = new Homes(join(root, 'member'), join(root, 'user'));
  await joinMember(homes, { schema: 'member-join-input-v1', hubUrl: base, code: app.mesh.invite().code, device: { name: 'Member', url: 'http://127.0.0.1:9773', os: 'linux', version: '0.1.0' } }, { redactor });
  connection = memberConnection(homes, { redactor }).client; repository = new MemberAccounts(connection);
  const fake = new FakeRuntime();
  runtime = { id: 'claude', displayName: 'Fixture Claude', accountKinds: fake.accountKinds, riggingKinds: [], capabilities: fake.capabilities,
    probe: vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready', identity: { email: 'member@example.invalid' } })),
    listModels: vi.fn<RuntimeAdapter['listModels']>(async () => [{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low', 'high'] }]),
    beginLogin: vi.fn(fake.beginLogin.bind(fake)), materialiseRigging: fake.materialiseRigging.bind(fake), startStretch: fake.startStretch.bind(fake) };
  service = accountService();
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(value => value.close()));
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true });
});

test('member account checks and model discovery run locally while shared data and encrypted credentials stay on the hub', async () => {
  const secret = `fixture-${randomUUID()}`; const created = await add(secret); const id = created.account.id;
  const hub = new HubAccounts(app.hub, app.device.deviceId);
  expect(hub.get(id).account).toEqual(created.account); expect(hub.status(id).auth).toBe('missing');
  expect((await service.check(id)).auth).toBe('ready'); await service.discover(id);
  expect(runtime.probe).toHaveBeenCalledOnce(); expect(runtime.listModels).toHaveBeenCalledOnce(); expect(app.runtimes.size).toBe(0);
  expect(vi.mocked(runtime.probe).mock.calls[0]![0]).toMatchObject({ home: homes.account('claude', id), env: { CLAUDE_CODE_OAUTH_TOKEN: secret } });
  const view = hub.get(id); expect(view.statuses.find(status => status.deviceId === connection.deviceId)?.auth).toBe('ready'); expect(hub.status(id).auth).toBe('missing');
  expect(view.account.identity?.email).toBe('member@example.invalid');
  expect(app.hub.configuration.current()!.configuration['x-jevellan'].menu[0]!.efforts).toEqual(['low', 'high']);
  expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('claude-fable-5-1');
  expect(JSON.stringify(await service.list())).not.toContain(secret); expect(JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all())).not.toContain(secret);
  expect(redactor.text(secret)).toBe('[redacted]'); expect(existsSync(homes.at('hub'))).toBe(false);
});

test('credential replacement is atomic when a status write fails and invalidates every known device only after success', async () => {
  const secret = `fixture-${randomUUID()}`; const created = await add(secret); const id = created.account.id;
  await service.check(id); const hub = new HubAccounts(app.hub, app.device.deviceId);
  hub.writeStatus({ ...hub.status(id), auth: 'ready' }, created.account.secretRef!);
  const before = hub.get(id); const secrets = app.hub.db.prepare('SELECT id FROM secrets ORDER BY id').all();
  app.hub.db.exec("CREATE TEMP TRIGGER fail_account_status BEFORE UPDATE ON documents WHEN NEW.namespace = 'account-statuses' BEGIN SELECT RAISE(ABORT, 'fixture status write failed'); END");
  await expect(repository.capture(id, before.revision, `fixture-${randomUUID()}`, 'capture_atomic')).rejects.toThrow();
  expect(hub.get(id)).toEqual(before); expect(hub.credential(id, before.account.secretRef!)).toBe(secret); expect(app.hub.db.prepare('SELECT id FROM secrets ORDER BY id').all()).toEqual(secrets);
  expect(app.hub.list('credential-captures', CredentialCaptureReceiptSchema)).toEqual([]);
  app.hub.db.exec('DROP TRIGGER fail_account_status');
  const replacement = await repository.capture(id, before.revision, `fixture-${randomUUID()}`);
  expect(replacement.statuses.map(status => status.auth)).toEqual(['checking', 'checking']); expect(replacement.account.identity).toBeUndefined();
  await expect(repository.capture(id, before.revision, `fixture-${randomUUID()}`)).rejects.toMatchObject({ status: 409 });
  expect(() => app.hub.vault.forLaunch(before.account.secretRef!)).toThrow('unavailable');
});

test('member token capture recovers a lost successful hub reply without replacing it twice or overwriting later account changes', async () => {
  const created = await add(); const id = created.account.id; const secret = `fixture-${randomUUID()}`; let lose = true;
  const send = connection.accountData.bind(connection);
  vi.spyOn(connection, 'accountData').mockImplementation(async raw => {
    const response = await send(raw);
    if (lose && AccountHubRequestSchema.parse(raw).operation === 'capture') { lose = false; throw new HubUnavailable('Fixture hub'); }
    return response;
  });
  await expect(service.captureSecret(id, secret, undefined, 'capture_lost')).rejects.toBeInstanceOf(HubUnavailable);
  const hub = new HubAccounts(app.hub, connection.deviceId); const saved = hub.get(id); const ref = saved.account.secretRef!;
  hub.update(id, { schema: 'update-account-v1', revision: saved.revision, label: 'Newer label', enabled: true, ceilingPct: 75 });
  const changed = hub.get(id); await service.captureSecret(id, secret, undefined, 'capture_lost'); await service.captureSecret(id, secret, undefined, 'capture_lost');
  expect(hub.get(id)).toEqual(changed); expect(hub.credential(id, ref)).toBe(secret);
  const reopened = new HubDatabase(app.homes, 'hub');
  try { expect(new HubAccounts(reopened, connection.deviceId).capture(id, created.revision, secret, 'capture_lost')).toEqual(changed); }
  finally { reopened.close(); }
  expect(app.hub.list('credential-captures', CredentialCaptureReceiptSchema)).toHaveLength(1);
  expect(JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all())).not.toContain(secret);
  await expect(repository.capture(id, created.revision, `fixture-${randomUUID()}`, 'capture_lost')).rejects.toMatchObject({ status: 409 });
  expect(() => new HubAccounts(app.hub, app.device.deviceId).capture(id, created.revision, secret, 'capture_lost')).toThrow('changed');
  hub.capture(id, changed.revision, `fixture-${randomUUID()}`); const latest = hub.get(id);
  await expect(service.captureSecret(id, secret, undefined, 'capture_lost')).rejects.toMatchObject({ status: 409 }); expect(hub.get(id)).toEqual(latest);
});

test('hub loss during credential resolution stays a waiting readiness check rather than an unknown provider result', async () => {
  const created = await add(); const id = created.account.id;
  vi.spyOn(repository, 'credential').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  await expect(service.check(id)).rejects.toBeInstanceOf(HubUnavailable); expect(runtime.probe).not.toHaveBeenCalled();
  expect((await service.check(id)).auth).toBe('ready'); expect(runtime.probe).toHaveBeenCalledOnce();
});

test('a replacement on another device rejects stale probe identity, usage and launch authentication errors', async () => {
  const created = await add(); const id = created.account.id; const started = deferred(); const late = deferred<{ auth: 'needs-login'; identity: { email: string } }>();
  runtime.probe = vi.fn(async () => { started.resolve(); return late.promise; });
  const oldProbe = service.check(id); await started.promise;
  const hub = new HubAccounts(app.hub, app.device.deviceId); hub.capture(id, hub.get(id).revision, `fixture-${randomUUID()}`);
  runtime.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready', identity: { email: 'replacement@example.invalid' } }));
  const fresh = accountService(); await fresh.check(id);
  late.resolve({ auth: 'needs-login', identity: { email: 'old@example.invalid' } }); await oldProbe;
  await service.recordError(id, 'auth', created.account.secretRef!);
  await service.recordUsage(id, { source: 'stream', fiveHourPct: 99, observedAt: new Date().toISOString() }, created.account.secretRef!);
  expect(await fresh.status(id)).toMatchObject({ auth: 'ready', usage: { source: 'unknown' } });
  expect((await fresh.status(id)).usage?.fiveHourPct).toBeUndefined(); expect(hub.get(id).account.identity?.email).toBe('replacement@example.invalid');
});

test('credential exchange is scoped to the current shared account and status reports to the authenticated device', async () => {
  const created = await add(); const id = created.account.id; app.hub.vault.put('unrelated', `fixture-${randomUUID()}`);
  await expect(repository.credential(id, 'unrelated')).rejects.toMatchObject({ status: 409 });
  const codex = await service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Per device', kind: 'subscription' });
  await expect(repository.credential(codex.account.id, created.account.secretRef!)).rejects.toMatchObject({ status: 409 });
  const status: AccountStatus = { schema: 'account-status-v1', accountId: id, deviceId: app.device.deviceId, auth: 'ready', observedAt: new Date().toISOString() };
  await expect(repository.writeStatus(status, created.account.secretRef!)).rejects.toMatchObject({ status: 403 });
  expect((await service.status(id)).auth).toBe('checking');
});

test('an unavailable hub prevents new credentials, login and edits without creating an offline account database', async () => {
  const created = await add(); let offline = false;
  const client = memberConnection(homes, { redactor, fetch: async (...args) => { if (offline) throw new Error('fixture offline'); return fetch(...args); } }).client;
  const prepare = vi.fn(async () => {}); const member = accountService(new MemberAccounts(client), prepare);
  await member.resolve(created.account.id); prepare.mockClear(); offline = true;
  await expect(member.resolve(created.account.id)).rejects.toBeInstanceOf(HubUnavailable);
  await expect(member.beginLogin(created.account.id)).rejects.toBeInstanceOf(HubUnavailable);
  await expect(member.update(created.account.id, { schema: 'update-account-v1', revision: created.revision, label: 'Offline change', enabled: false, ceilingPct: 80 })).rejects.toBeInstanceOf(HubUnavailable);
  expect(runtime.beginLogin).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(existsSync(homes.at('hub'))).toBe(false);
  offline = false; expect((await member.get(created.account.id)).account.label).toBe('Member account');
});

test.each(['get', 'credential'] as const)('shutdown while the hub delays %s never starts local login or account preparation', async operation => {
  const created = await add(); const arrived = deferred(); const release = deferred();
  const client = memberConnection(homes, { redactor, fetch: async (...args) => {
    const response = await fetch(...args);
    const body = args[1]?.body; if (typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === operation) { arrived.resolve(); await release.promise; }
    return response;
  } }).client;
  const prepare = vi.fn(async () => {}); const member = accountService(new MemberAccounts(client), prepare);
  const pending = operation === 'get' ? member.beginLogin(created.account.id) : member.resolve(created.account.id);
  const rejected = expect(pending).rejects.toThrow('closed'); await arrived.promise;
  const closing = member.close(); release.resolve(); await rejected; await closing;
  expect(runtime.beginLogin).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});

test('shutdown also prevents a second local preparation already queued behind the first', async () => {
  const created = await add(); const entered = deferred(); const release = deferred(); const lookedUp = deferred(); let credentials = 0;
  const store = new MemberAccounts(connection); const original = store.credential.bind(store);
  vi.spyOn(store, 'credential').mockImplementation(async (...args) => { const result = await original(...args); if (++credentials === 2) lookedUp.resolve(); return result; });
  const prepare = vi.fn(async () => { entered.resolve(); await release.promise; }); const member = accountService(store, prepare);
  const first = member.resolve(created.account.id); const firstRejected = expect(first).rejects.toThrow('closed'); await entered.promise;
  const second = member.resolve(created.account.id); const secondRejected = expect(second).rejects.toThrow('closed'); await lookedUp.promise;
  await new Promise<void>(resolve => setImmediate(resolve)); const closing = member.close(); release.resolve();
  await Promise.all([firstRejected, secondRejected, closing]); expect(prepare).toHaveBeenCalledOnce();
});

test('member account creation resumes a lost committed reply without duplicates, preserves newer edits and survives reopening the hub database', async () => {
  const secret = `fixture-${randomUUID()}`; const input = { schema: 'add-account-v1', runtime: 'claude', kind: 'subscription', label: 'Original label', secret, clientRequestId: 'create_lost' };
  const original = connection.accountData.bind(connection);
  vi.spyOn(connection, 'accountData').mockImplementationOnce(async raw => { await original(raw); throw new HubUnavailable('Fixture hub'); });
  await expect(service.add(input)).rejects.toBeInstanceOf(HubUnavailable);
  const hub = new HubAccounts(app.hub, connection.deviceId); const [created] = hub.list(); expect(created).toBeDefined();
  const newer = hub.update(created!.account.id, { schema: 'update-account-v1', revision: created!.revision, label: 'Newer label', enabled: false, ceilingPct: 70 });
  expect(await service.add(input)).toEqual(newer); expect(hub.list()).toHaveLength(1);
  const reopened = new HubDatabase(app.homes, 'hub');
  try { expect(new HubAccounts(reopened, connection.deviceId).add(input)).toEqual(newer); } finally { reopened.close(); }
  await expect(service.add({ ...input, label: 'Different request' })).rejects.toMatchObject({ status: 409 });
  expect(hub.get(created!.account.id)).toEqual(newer);
  expect(JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all())).not.toContain(secret);
});

test('account update receipts preserve a later save and an unsuccessful receipt write rolls back account and vault creation', async () => {
  const created = await add(); const patch = { schema: 'update-account-v1', revision: created.revision, label: 'First save', enabled: false, ceilingPct: 75, clientRequestId: 'update_lost' };
  const original = connection.accountData.bind(connection);
  vi.spyOn(connection, 'accountData').mockImplementationOnce(async raw => { await original(raw); throw new HubUnavailable('Fixture hub'); });
  await expect(service.update(created.account.id, patch)).rejects.toBeInstanceOf(HubUnavailable);
  const saved = await service.get(created.account.id); const newer = await service.update(created.account.id, { ...patch, revision: saved.revision, label: 'Later save', clientRequestId: 'update_newer' });
  expect(await service.update(created.account.id, patch)).toEqual(newer); expect(newer.account.label).toBe('Later save');
  const before = app.hub.db.prepare('SELECT namespace,id,revision,document FROM documents ORDER BY namespace,id').all(); const secrets = app.hub.db.prepare('SELECT id,document FROM secrets ORDER BY id').all();
  app.hub.db.exec("CREATE TEMP TRIGGER fail_settings_receipt BEFORE INSERT ON documents WHEN NEW.namespace = 'settings-mutations' BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END");
  await expect(service.add({ schema: 'add-account-v1', runtime: 'claude', kind: 'subscription', label: 'Rolled back', secret: `fixture-${randomUUID()}`, clientRequestId: 'create_rollback' })).rejects.toThrow();
  expect(app.hub.db.prepare('SELECT namespace,id,revision,document FROM documents ORDER BY namespace,id').all()).toEqual(before); expect(app.hub.db.prepare('SELECT id,document FROM secrets ORDER BY id').all()).toEqual(secrets);
});

test('key replacement resumes its original save after a lost reply and refuses to overwrite a later key', async () => {
  const created = await add(); const input = { schema: 'replace-credential-v1', revision: created.revision, secret: `fixture-${randomUUID()}`, clientRequestId: 'replace_lost' };
  const original = connection.accountData.bind(connection); let lose = true;
  vi.spyOn(connection, 'accountData').mockImplementation(async raw => { const result = await original(raw); if (lose && AccountHubRequestSchema.parse(raw).operation === 'capture') { lose = false; throw new HubUnavailable('Fixture hub'); } return result; });
  await expect(service.replaceCredential(created.account.id, input)).rejects.toBeInstanceOf(HubUnavailable);
  const saved = await service.get(created.account.id); const secretRef = saved.account.secretRef;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
  const result = await service.replaceCredential(created.account.id, input); expect(result.account.secretRef).toBe(secretRef); expect(result.statuses.find(status => status.deviceId === connection.deviceId)?.auth).toBe('ready');
  clock.mockRestore();
  const replacement = `fixture-${randomUUID()}`; const latest = await repository.capture(created.account.id, result.revision, replacement);
  await expect(service.replaceCredential(created.account.id, input)).rejects.toMatchObject({ status: 409 }); expect((await service.get(created.account.id)).account.secretRef).toBe(latest.account.secretRef);
});
