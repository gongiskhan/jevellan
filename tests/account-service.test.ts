import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Homes, HubUnavailable, seedConfiguration, type AccountStatus } from '../packages/core/dist/index.js';
import { HubAccounts, HubDatabase } from '../packages/mesh/dist/index.js';
import { AccountService, rankAccounts } from '../packages/accounts/dist/index.js';
import { FakeRuntime, type RuntimeAdapter, type LoginSession } from '../packages/runtime-contract/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase; let service: AccountService;
let claude: RuntimeAdapter; let codex: RuntimeAdapter;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-account-service-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
  hub.configuration.put(seedConfiguration(), 0, { deviceId: 'here', source: 'install' });
  const fake = new FakeRuntime();
  claude = { id: 'claude', displayName: 'Claude Code', accountKinds: fake.accountKinds, riggingKinds: [], capabilities: fake.capabilities, listModels: vi.fn<RuntimeAdapter['listModels']>(async () => [{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low', 'high'] }]), beginLogin: vi.fn(fake.beginLogin.bind(fake)), probe: vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready' })), materialiseRigging: fake.materialiseRigging.bind(fake), startStretch: fake.startStretch.bind(fake), startTurn: fake.startTurn.bind(fake) };
  codex = { ...claude, id: 'codex' };
  service = new AccountService({ store: new HubAccounts(hub, 'here'), redactor: hub.redactor, homes, deviceId: 'here', runtimes: new Map([['claude', claude], ['codex', codex]]), timers: false });
});
afterEach(async () => { await service.close(); hub.close(); await rm(root, { recursive: true, force: true }); });
async function add(secret = `fixture-${randomUUID()}`) { return (await service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Personal', kind: 'subscription', secret })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test('account creation requires an explicit paid-use choice and returns only a secret summary', async () => {
  const key = `fixture-${randomUUID()}`;
  await expect(service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Key', kind: 'api-key', secret: key })).rejects.toThrow('choose');
  const account = (await service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Key', kind: 'api-key', secret: key, paidUse: 'never' }));
  expect(account.account).toMatchObject({ credential: 'shared', paidUse: 'never', ceilingPct: 90 });
  expect(account.secret?.lastFour).toBe(key.slice(-4)); expect(JSON.stringify((await service.list()))).not.toContain(key);
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain(key);
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM secrets').all())).not.toContain(key);
});

test('account edits use revision checks and cannot mutate credential ownership', async () => {
  const original = (await add());
  const change = { schema: 'update-account-v1', revision: original.revision, label: 'Edited', enabled: false, ceilingPct: 80 };
  (await service.update(original.account.id, change));
  await expect(service.update(original.account.id, { ...change, label: 'Stale' })).rejects.toThrow('changed');
  await expect(service.update(original.account.id, { ...change, credential: 'per-device' })).rejects.toThrow();
  expect((await service.get(original.account.id)).account).toMatchObject({ label: 'Edited', enabled: false, credential: 'shared' });
});

test('an old authentication failure cannot overwrite readiness for a replaced credential', async () => {
  const account = (await add()); const old = deferred<{ auth: 'needs-login' }>(); const started = deferred<void>();
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => { started.resolve(); return old.promise; });
  const oldCheck = service.check(account.account.id); await started.promise;
  const replacement = `fixture-${randomUUID()}`; (await service.captureSecret(account.account.id, replacement));
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready' }));
  expect((await service.check(account.account.id)).auth).toBe('ready');
  old.resolve({ auth: 'needs-login' }); await oldCheck;
  expect((await service.status(account.account.id)).auth).toBe('ready');
  expect(() => hub.vault.summary(account.account.secretRef!)).toThrow('unavailable');
  expect((await service.resolve(account.account.id)).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: replacement });
});

test('a failed usage query preserves authenticated readiness and reports unknown usage', async () => {
  const account = (await add()); const id = account.account.id;
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'ready', usage: { source: 'probe', fiveHourPct: 100, observedAt: new Date().toISOString() } }));
  await service.check(id);
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'unknown', error: 'Usage is unavailable.' }));
  const status = await service.check(id);
  expect(status).toMatchObject({ auth: 'ready', usage: { source: 'unknown' } }); expect(status.usage?.fiveHourPct).toBeUndefined();
  expect(rankAccounts({ accounts: [account.account], statuses: [status], runtime: 'claude', deviceId: 'here' })[0]?.eligible).toBe(true);
  (await service.recordError(id, 'rate-limit')); expect((await service.status(id)).coolingUntil).toBeDefined();
  (await service.recordError(id, 'auth')); expect((await service.status(id)).auth).toBe('needs-login');
});

test('model discovery retains settings edited while the provider was answering', async () => {
  const account = (await add()); const models = deferred<Awaited<ReturnType<RuntimeAdapter['listModels']>>>(); const started = deferred<void>();
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
  const account = (await service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Login', kind: 'subscription' }));
  let state: 'pending' | 'done' = 'pending'; const token = `fixture-${randomUUID()}`; const cancel = vi.fn(async () => {});
  const session: LoginSession = { instructions: 'Paste the code.', url: 'https://claude.ai/oauth/authorize', poll: async () => state, cancel, submitCode: async () => { (await service.captureSecret(account.account.id, token)); state = 'done'; } };
  claude.beginLogin = vi.fn(async () => session);
  const login = await service.beginLogin(account.account.id); expect(login.acceptsCode).toBe(true);
  expect((await service.pollLogin(login.id)).state).toBe('pending');
  expect((await service.submitLogin(login.id, 'fixture-code')).state).toBe('done');
  expect((await service.status(account.account.id)).auth).toBe('ready'); expect((await service.offered())).toHaveLength(1);
  expect(JSON.stringify((await service.get(account.account.id)))).not.toContain(token);
  await service.cancelLogin(login.id); expect(cancel).toHaveBeenCalledOnce();
});
test('a failed native login exposes its safe error and permits a fresh sign-in', async () => {
  const account = await service.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Login failure', kind: 'subscription' });
  const session: LoginSession = { instructions: 'Paste the code.', error: 'Claude reported a sign-in error. Start again.', poll: async () => 'failed', cancel: async () => {}, submitCode: async () => {} };
  claude.beginLogin = vi.fn(async () => session);
  const login = await service.beginLogin(account.account.id);
  expect(await service.submitLogin(login.id, 'fixture-code')).toMatchObject({ state: 'failed', acceptsCode: false, error: session.error });
  expect(claude.probe).not.toHaveBeenCalled(); expect((await service.get(account.account.id)).secret).toBeUndefined();
  expect((await service.beginLogin(account.account.id)).id).not.toBe(login.id);
});

test('a cancelled login cannot turn a late provider completion into Ready', async () => {
  const account = (await add()); const poll = deferred<'done'>(); const started = deferred<void>();
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Wait', poll: async () => { started.resolve(); return poll.promise; }, cancel: async () => {} }));
  const login = await service.beginLogin(account.account.id); const pending = service.pollLogin(login.id); await started.promise;
  await service.cancelLogin(login.id); poll.resolve('done');
  expect((await pending).state).toBe('cancelled'); expect(claude.probe).not.toHaveBeenCalled();
});

test('simultaneous login requests share one terminal process and panel', async () => {
  const account = (await add()); const starting = deferred<LoginSession>();
  claude.beginLogin = vi.fn(async () => starting.promise);
  const first = service.beginLogin(account.account.id); const second = service.beginLogin(account.account.id);
  starting.resolve({ instructions: 'Wait', poll: async () => 'pending', cancel: async () => {} });
  expect((await first).id).toBe((await second).id); expect(claude.beginLogin).toHaveBeenCalledOnce();
  expect((await service.beginLogin(account.account.id)).id).toBe((await first).id);
});

test('login readiness resumes after hub loss without resubmitting a code or polling the completed native login', async () => {
  const account = await add(); const poll = vi.fn(async () => 'done' as const); const submitCode = vi.fn(async () => {});
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Fixture', poll, submitCode, cancel: async () => {} }));
  const login = await service.beginLogin(account.account.id, 'login_first');
  const check = vi.spyOn(service, 'check').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  await expect(service.submitLogin(login.id, 'fixture-code')).rejects.toBeInstanceOf(HubUnavailable);
  expect(service.loginSubmissionAccepted(login.id)).toBe(true); expect(submitCode).toHaveBeenCalledOnce(); expect(poll).toHaveBeenCalledOnce();
  expect((await service.submitLogin(login.id, 'fixture-code')).state).toBe('done'); expect(check).toHaveBeenCalledTimes(2);
  expect((await service.beginLogin(account.account.id, 'login_first')).state).toBe('done'); expect(claude.beginLogin).toHaveBeenCalledOnce();
  await expect(service.submitLogin(login.id, 'changed-code')).rejects.toMatchObject({ status: 409 }); expect(submitCode).toHaveBeenCalledOnce(); expect(poll).toHaveBeenCalledOnce();
});

test('concurrent submitted-code retries share the original native exchange', async () => {
  const account = await add(); const accepted = deferred<void>(); const submitCode = vi.fn(async () => accepted.promise);
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Fixture', poll: async () => 'done' as const, submitCode, cancel: async () => {} }));
  const login = await service.beginLogin(account.account.id, 'login_first');
  const first = service.submitLogin(login.id, 'fixture-code'); const second = service.submitLogin(login.id, 'fixture-code'); accepted.resolve();
  expect((await Promise.all([first, second])).map(view => view.state)).toEqual(['done', 'done']); expect(submitCode).toHaveBeenCalledOnce();
});

test('a cancelled readiness wait never becomes Ready after reconnection', async () => {
  const account = await add(); const cancel = vi.fn(async () => {});
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Fixture', poll: async () => 'done' as const, cancel }));
  const login = await service.beginLogin(account.account.id, 'login_first'); const check = vi.spyOn(service, 'check').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  await expect(service.pollLogin(login.id)).rejects.toBeInstanceOf(HubUnavailable); await service.cancelLogin(login.id);
  expect((await service.pollLogin(login.id)).state).toBe('cancelled'); expect(check).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
});

test('login request receipts prevent an old browser retry from starting a process after restart', async () => {
  const account = await add(); await service.beginLogin(account.account.id, 'login_first'); await service.close();
  service = new AccountService({ store: new HubAccounts(hub, 'here'), redactor: hub.redactor, homes, deviceId: 'here', runtimes: new Map([['claude', claude], ['codex', codex]]), timers: false });
  await expect(service.beginLogin(account.account.id, 'login_first')).rejects.toMatchObject({ status: 409 }); expect(claude.beginLogin).toHaveBeenCalledOnce();
  await service.beginLogin(account.account.id, 'login_second'); expect(claude.beginLogin).toHaveBeenCalledTimes(2);
  const receipt = JSON.parse(readFileSync(homes.at('auth', 'login-requests', 'login_first.json'), 'utf8'));
  expect(Object.keys(receipt).sort()).toEqual(['accountId', 'deviceId', 'loginId', 'requestId', 'schema']);
});

test('a reused login request ID cannot start two different accounts concurrently', async () => {
  const first = await add(); const second = await add();
  const results = await Promise.allSettled([service.beginLogin(first.account.id, 'same_request'), service.beginLogin(second.account.id, 'same_request')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { status: 409 } }]); expect(claude.beginLogin).toHaveBeenCalledOnce();
});

test('validation rejects a bad code before locking its native submission', async () => {
  const account = await add(); const submitCode = vi.fn(async () => {});
  claude.beginLogin = vi.fn(async () => ({ instructions: 'Fixture', poll: async () => 'done' as const, validateCode: (code: string) => { if (code === 'invalid') throw new Error('Invalid fixture code'); }, submitCode, cancel: async () => {} }));
  const login = await service.beginLogin(account.account.id);
  await expect(service.submitLogin(login.id, 'invalid')).rejects.toThrow('Invalid fixture code'); expect(submitCode).not.toHaveBeenCalled();
  expect((await service.submitLogin(login.id, 'valid')).state).toBe('done'); expect(submitCode).toHaveBeenCalledOnce();
});

test('scheduled probes select only recently used enabled accounts', async () => {
  const active = (await add()); const unused = (await add()); const disabled = (await add());
  (await service.markUsed(active.account.id)); (await service.markUsed(disabled.account.id));
  (await service.update(disabled.account.id, { schema: 'update-account-v1', revision: disabled.revision, label: 'Disabled', enabled: false, ceilingPct: 90 }));
  await service.probeRecent();
  expect(claude.probe).toHaveBeenCalledOnce(); expect((await service.status(active.account.id)).auth).toBe('ready'); expect((await service.status(unused.account.id)).auth).toBe('checking');
});

test('Codex subscriptions keep distinct homes and API preparation never forwards the key to a stretch', async () => {
  const first = (await service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'First', kind: 'subscription' }));
  const second = (await service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'Second', kind: 'subscription' }));
  expect((await service.resolve(first.account.id)).home).not.toBe((await service.resolve(second.account.id)).home);
  expect(first.account.credential).toBe('per-device'); expect(first.secret).toBeUndefined();
  await service.close(); const prepare = vi.fn(async () => {});
  service = new AccountService({ store: new HubAccounts(hub, 'here'), redactor: hub.redactor, homes, deviceId: 'here', runtimes: new Map([['codex', codex]]), prepare, timers: false });
  const key = `fixture-${randomUUID()}`;
  const account = (await service.add({ schema: 'add-account-v1', runtime: 'codex', label: 'API', kind: 'api-key', secret: key, paidUse: 'always' }));
  expect((await service.resolve(account.account.id)).env).toEqual({}); expect(prepare).toHaveBeenCalledOnce();
});

test('probe output is redacted before persistent status storage', async () => {
  const token = `fixture-${randomUUID()}`; const account = (await add(token));
  claude.probe = vi.fn<RuntimeAdapter['probe']>(async () => ({ auth: 'unknown' as AccountStatus['auth'], error: `Provider error ${token}` }));
  expect((await service.check(account.account.id)).lastError).toBe('Provider error [redacted]');
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain(token);
});

test('shutdown waits for a superseded credential probe before the database can close', async () => {
  const account = (await add()); const response = deferred<{ auth: 'needs-login' }>(); const started = deferred<void>();
  claude.probe = async () => { started.resolve(); return response.promise; };
  const probe = service.check(account.account.id); await started.promise;
  (await service.captureSecret(account.account.id, `fixture-${randomUUID()}`));
  let closed = false; const closing = service.close(); void closing.then(() => { closed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false); expect(service.close()).toBe(closing);
    await expect(service.check(account.account.id)).rejects.toThrow('closed');
  } finally { response.resolve({ auth: 'needs-login' }); await probe; await closing; }
  expect(closed).toBe(true);
});

test('shutdown drains provider discovery without applying its late result', async () => {
  const account = (await add()); const models = deferred<Awaited<ReturnType<RuntimeAdapter['listModels']>>>(); const started = deferred<void>();
  claude.listModels = async () => { started.resolve(); return models.promise; };
  const discovery = service.discover(account.account.id); const rejected = expect(discovery).rejects.toThrow('closed'); await started.promise;
  const revision = hub.configuration.current()!.revision;
  let closed = false; const closing = service.close(); void closing.then(() => { closed = true; });
  try { await new Promise<void>((resolve) => setImmediate(resolve)); expect(closed).toBe(false); }
  finally { models.resolve([{ id: 'claude-fable-5-1', label: 'Fable', efforts: ['low'] }]); await rejected; await closing; }
  expect(hub.configuration.current()!.revision).toBe(revision);
  expect(hub.db.prepare("SELECT count(*) AS count FROM documents WHERE namespace = 'offered-models'").get()).toMatchObject({ count: 0 });
});
