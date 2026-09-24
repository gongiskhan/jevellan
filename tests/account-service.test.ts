import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Homes, seedConfiguration, type AccountStatus } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { AccountService, rankAccounts } from '../packages/accounts/dist/index.js';
import { FakeRuntime, type RuntimeAdapter, type LoginSession } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase; let service: AccountService;
let claude: RuntimeAdapter; let codex: RuntimeAdapter;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-account-service-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
  hub.configuration.put(seedConfiguration(), 0, { deviceId: 'here', source: 'install' });
  const fake = new FakeRuntime();
  claude = { id: 'claude', displayName: 'Claude Code', accountKinds: fake.accountKinds, riggingKinds: [], capabilities: fake.capabilities, listModels: vi.fn<RuntimeAdapter['listModels']>(async () => [{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low', 'high'] }]), beginLogin: vi.fn(fake.beginLogin.bind(fake)), probe: vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready' })), materialiseRigging: fake.materialiseRigging.bind(fake), startStretch: fake.startStretch.bind(fake) };
  codex = { ...claude, id: 'codex' };
  service = new AccountService({ store: hub, vault: hub.vault, redactor: hub.redactor, homes, deviceId: 'here', configuration: hub.configuration, runtimes: new Map([['claude', claude], ['codex', codex]]), timers: false });
});
afterEach(async () => { await service.close(); hub.close(); await rm(root, { recursive: true, force: true }); });
function add(secret = `fixture-${randomUUID()}`) { return service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Personal', kind: 'subscription', secret }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('account creation requires an explicit paid-use choice and returns only a secret summary', () => {
  const key = `fixture-${randomUUID()}`;
  expect(() => service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Key', kind: 'api-key', secret: key })).toThrow('choose');
  const account = service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Key', kind: 'api-key', secret: key, paidUse: 'never' });
  expect(account.account).toMatchObject({ credential: 'shared', paidUse: 'never', ceilingPct: 90 });
  expect(account.secret?.lastFour).toBe(key.slice(-4)); expect(JSON.stringify(service.list())).not.toContain(key);
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain(key);
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM secrets').all())).not.toContain(key);
});

test('account edits use revision checks and cannot mutate credential ownership', () => {
  const original = add();
  const change = { schema: 'update-account-v1', revision: original.revision, label: 'Edited', enabled: false, ceilingPct: 80 };
  service.update(original.account.id, change);
  expect(() => service.update(original.account.id, { ...change, label: 'Stale' })).toThrow('changed');
  expect(() => service.update(original.account.id, { ...change, credential: 'per-device' })).toThrow();
  expect(service.get(original.account.id).account).toMatchObject({ label: 'Edited', enabled: false, credential: 'shared' });
});

test('an old authentication failure cannot overwrite readiness for a replaced credential', async () => {
  const account = add(); const old = deferred<{ auth: 'needs-login' }>(); const started = deferred<void>();
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => { started.resolve(); return old.promise; });
  const oldCheck = service.check(account.account.id); await started.promise;
  const replacement = `fixture-${randomUUID()}`; service.captureSecret(account.account.id, replacement);
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready' }));
  expect((await service.check(account.account.id)).auth).toBe('ready');
  old.resolve({ auth: 'needs-login' }); await oldCheck;
  expect(service.status(account.account.id).auth).toBe('ready');
  expect(() => hub.vault.summary(account.account.secretRef!)).toThrow('unavailable');
  expect((await service.resolve(account.account.id)).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: replacement });
});

test('a failed usage query preserves authenticated readiness and reports unknown usage', async () => {
  const account = add(); const id = account.account.id;
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready', usage: { source: 'probe', fiveHourPct: 100, observedAt: new Date().toISOString() } }));
  await service.check(id);
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'unknown', error: 'Usage is unavailable.' }));
  const status = await service.check(id);
  expect(status).toMatchObject({ auth: 'ready', usage: { source: 'unknown' } }); expect(status.usage?.fiveHourPct).toBeUndefined();
  expect(rankAccounts({ accounts: [account.account], statuses: [status], runtime: 'claude', deviceId: 'here' })[0]?.eligible).toBe(true);
  service.recordError(id, 'rate-limit'); expect(service.status(id).coolingUntil).toBeDefined();
  service.recordError(id, 'auth'); expect(service.status(id).auth).toBe('needs-login');
});

test('model discovery retains settings edited while the provider was answering', async () => {
  const account = add(); const models = deferred<Awaited<ReturnType<RuntimeAdapter['listModels']>>>(); const started = deferred<void>();
  claude.listModels = vi.fn<RuntimeAdapter['listModels']>(async () => { started.resolve(); return models.promise; });
  const pending = service.discover(account.account.id); await started.promise;
  const current = hub.configuration.current()!; current.configuration['x-jevellan'].routingProfile = 'New profile';
  current.configuration['x-jevellan'].menu[0]!.description = 'Keep this edit';
  hub.configuration.put(current.configuration, current.revision, { deviceId: 'elsewhere', source: 'ui' });
  models.resolve([{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low', 'high'] }]); await pending;
  const result = hub.configuration.current()!;
  expect(result.configuration['x-jevellan'].routingProfile).toBe('New profile');
  expect(result.configuration['x-jevellan'].menu[0]).toMatchObject({ description: 'Keep this edit', efforts: ['low', 'high'], enabled: true });
  expect(readFileSync(homes.at('apm.yml'), 'utf8')).toContain('New profile');
});

test('UI login completion captures the secret, verifies readiness and discovers models', async () => {
  const account = service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Login', kind: 'subscription' });
  let state: 'pending' | 'done' = 'pending'; const token = `fixture-${randomUUID()}`; const cancel = vi.fn(async () => {});
  const session: LoginSession = { instructions: 'Paste the code.', url: 'https://claude.ai/oauth/authorize', poll: async () => state, cancel, submitCode: async () => { service.captureSecret(account.account.id, token); state = 'done'; } };
  claude.beginLogin = vi.fn(async () => session);
  const login = await service.beginLogin(account.account.id); expect(login.acceptsCode).toBe(true);
  expect((await service.pollLogin(login.id)).state).toBe('pending');
  expect((await service.submitLogin(login.id, 'fixture-code')).state).toBe('done');
  expect(service.status(account.account.id).auth).toBe('ready'); expect(service.offered()).toHaveLength(1);
  expect(JSON.stringify(service.get(account.account.id))).not.toContain(token);
  await service.cancelLogin(login.id); expect(cancel).toHaveBeenCalledOnce();
});

test('a cancelled login cannot turn a late provider completion into Ready', async () => {
  const account = add(); const poll = deferred<'done'>(); const started = deferred<void>();
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Wait', poll: async () => { started.resolve(); return poll.promise; }, cancel: async () => {} }));
  const login = await service.beginLogin(account.account.id); const pending = service.pollLogin(login.id); await started.promise;
  await service.cancelLogin(login.id); poll.resolve('done');
  expect((await pending).state).toBe('cancelled'); expect(claude.probe).not.toHaveBeenCalled();
});

test('simultaneous login requests share one terminal process and panel', async () => {
  const account = add(); const starting = deferred<LoginSession>();
  claude.beginLogin = vi.fn(async () => starting.promise);
  const first = service.beginLogin(account.account.id); const second = service.beginLogin(account.account.id);
  starting.resolve({ instructions: 'Wait', poll: async () => 'pending', cancel: async () => {} });
  expect((await first).id).toBe((await second).id); expect(claude.beginLogin).toHaveBeenCalledOnce();
  expect((await service.beginLogin(account.account.id)).id).toBe((await first).id);
});

test('scheduled probes select only recently used enabled accounts', async () => {
  const active = add(); const unused = add(); const disabled = add();
  service.markUsed(active.account.id); service.markUsed(disabled.account.id);
  service.update(disabled.account.id, { schema: 'update-account-v1', revision: disabled.revision, label: 'Disabled', enabled: false, ceilingPct: 90 });
  await service.probeRecent();
  expect(claude.probe).toHaveBeenCalledOnce(); expect(service.status(active.account.id).auth).toBe('ready'); expect(service.status(unused.account.id).auth).toBe('checking');
});

test('Codex subscriptions keep distinct homes and API preparation never forwards the key to a stretch', async () => {
  const first = service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'First', kind: 'subscription' });
  const second = service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Second', kind: 'subscription' });
  expect((await service.resolve(first.account.id)).home).not.toBe((await service.resolve(second.account.id)).home);
  expect(first.account.credential).toBe('per-device'); expect(first.secret).toBeUndefined();
  await service.close(); const prepare = vi.fn(async () => {});
  service = new AccountService({ store: hub, vault: hub.vault, redactor: hub.redactor, homes, deviceId: 'here', configuration: hub.configuration, runtimes: new Map([['codex', codex]]), prepare, timers: false });
  const key = `fixture-${randomUUID()}`;
  const account = service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'API', kind: 'api-key', secret: key, paidUse: 'always' });
  expect((await service.resolve(account.account.id)).env).toEqual({}); expect(prepare).toHaveBeenCalledOnce();
});

test('probe output is redacted before persistent status storage', async () => {
  const token = `fixture-${randomUUID()}`; const account = add(token);
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'unknown' as AccountStatus['auth'], error: `Provider error ${token}` }));
  expect((await service.check(account.account.id)).lastError).toBe('Provider error [redacted]');
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain(token);
});
