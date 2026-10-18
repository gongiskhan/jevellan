import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, AccountStatusSchema, ThreadCreatedViewSchema, AddAccountSchema, Homes, minimalEnvironment, reconcileEndpointMenu, ModelOptionSchema, seedConfiguration } from '../packages/core/dist/index.js';
import { rankAccounts } from '../packages/accounts/dist/index.js';
import { HubAccounts, HubDatabase } from '../packages/mesh/dist/index.js';
import { probeClaude } from '../runtimes/claude/dist/control.js';
import { projectFixture } from './helpers/project-fixture.js';
import { FakeRuntime, forThread } from '../packages/runtime-contract/dist/index.js';
import { launchEnvironment } from '../packages/runtime-contract/dist/worker-run.js';
const endpoint = { baseUrl: 'http://127.0.0.1:8888/anthropic', billing: 'free', models: [{ id: 'fixture-glm', label: 'Fixture GLM', efforts: ['medium'], description: 'Small bounded work.' }] };
const raw = (extra: Record<string, unknown> = {}) => ({ schema: 'account-v2', id: 'endpoint', runtime: 'claude', label: 'Endpoint', kind: 'endpoint', enabled: true, credential: 'shared', ceilingPct: 90, secretRef: 'endpoint_secret', endpoint, ...extra });
const status = (accountId: string) => AccountStatusSchema.parse({ schema: 'account-status-v2', accountId, deviceId: 'here', auth: 'ready', observedAt: new Date().toISOString() });
let root: string | undefined, hub: HubDatabase | undefined;
afterEach(async () => { hub?.close(); hub = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
test('account-v1 migrates to v2 without changing existing subscription choices', () => {
  const before = { schema: 'account-v1', id: 'native', runtime: 'claude', label: 'Native', kind: 'subscription', credential: 'shared', enabled: false, ceilingPct: 70 };
  expect(AccountSchema.parse(before)).toEqual({ ...before, schema: 'account-v2' });
});
test('endpoint accounts round-trip their declared models and reject inconsistent ownership and billing', () => {
  expect(AccountSchema.parse(raw())).toEqual(raw());
  for (const patch of [{ runtime: 'codex' }, { credential: 'per-device' }, { endpoint: undefined }, { kind: 'subscription' }, { paidUse: 'always' }, { endpoint: { ...endpoint, billing: 'metered' } }]) expect(AccountSchema.safeParse(raw(patch)).success).toBe(false);
  expect(AccountSchema.safeParse(raw({ endpoint: { ...endpoint, billing: 'metered' }, paidUse: 'always' })).success).toBe(true);
  expect(AddAccountSchema.safeParse({ schema: 'add-account-v1', runtime: 'claude', label: 'Endpoint', kind: 'endpoint', endpoint, secret: 'fixture credential' }).success).toBe(true);
  expect(AddAccountSchema.safeParse({ schema: 'add-account-v1', runtime: 'claude', label: 'Endpoint', kind: 'endpoint', endpoint }).success).toBe(false);
});
test('ranking serves endpoint ids only from declared endpoint accounts and native ids only from native accounts', () => {
  const custom = AccountSchema.parse(raw()), native = AccountSchema.parse(raw({ id: 'native', kind: 'subscription', endpoint: undefined }));
  const rank = (model: string) => rankAccounts({ accounts: [custom, native], statuses: [status(custom.id), status(native.id)], runtime: 'claude', model, deviceId: 'here' });
  expect(rank('fixture-glm').find(row => row.account.id === 'native')).toMatchObject({ eligible: false, reason: 'model-not-served' });
  expect(rank('fixture-glm').find(row => row.account.id === 'endpoint')).toMatchObject({ eligible: true, knownUsage: false });
  expect(rank('native-model').find(row => row.account.id === 'endpoint')).toMatchObject({ eligible: false, reason: 'model-not-served' });
  expect(rank('native-model').find(row => row.account.id === 'native')?.eligible).toBe(true);
});
test('metered endpoints use the existing paid-use policy and free endpoints do not', () => {
  const custom = AccountSchema.parse(raw({ endpoint: { ...endpoint, billing: 'metered' }, paidUse: 'never' }));
  expect(rankAccounts({ accounts: [custom], statuses: [status(custom.id)], runtime: 'claude', model: 'fixture-glm', deviceId: 'here' })[0]).toMatchObject({ eligible: false, reason: 'paid-not-allowed' });
});
test('saving, editing and disabling an endpoint reconciles its menu without exposing credentials', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-endpoint-')); mkdirSync(join(root, 'user')); const homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
  hub.configuration.put(seedConfiguration(), 0, { deviceId: 'here', source: 'install' }); const store = new HubAccounts(hub, 'here');
  const saved = store.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Endpoint', kind: 'endpoint', endpoint, secret: 'fixture endpoint credential' });
  const menu = () => hub!.configuration.current()!.configuration['x-jevellan'].menu;
  const model = menu().find(row => row.model === 'fixture-glm'); expect(model).toMatchObject({ runtime: 'claude', label: 'Fixture GLM', efforts: ['medium'], enabled: true, description: 'Small bounded work.' });
  expect(JSON.stringify(saved)).not.toContain('fixture endpoint credential');
  store.update(saved.account.id, { schema: 'update-account-v1', revision: saved.revision, label: 'Endpoint', enabled: false, ceilingPct: 90, endpoint });
  expect(menu().find(row => row.id === model!.id)).toMatchObject({ enabled: false, unavailableReason: 'The account that serves this model is disabled.' });
});
test('the endpoint probe uses one bounded Messages request with its base path and token', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(url).toBe('http://127.0.0.1:8888/anthropic/v1/messages'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture token'); expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture-glm', max_tokens: 1 }); return new Response('{}'); });
  expect(await probeClaude({ account: AccountSchema.parse(raw()), home: '/tmp/isolated', env: { ANTHROPIC_AUTH_TOKEN: 'fixture token' } }, fetcher)).toEqual({ auth: 'ready' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([401, 403, 500])('endpoint probe failure %i has the required diagnosis and no usage windows', async code => {
  const result = await probeClaude({ account: AccountSchema.parse(raw()), home: '/tmp/isolated', env: { ANTHROPIC_AUTH_TOKEN: 'fixture token' } }, async () => new Response('{}', { status: code }));
  expect(result.auth).toBe(code === 500 ? 'unknown' : 'needs-login'); expect(result.error).toBe(code === 500 ? 'Unreachable: HTTP 500' : 'Key refused'); expect(result.usage).toBeUndefined();
});
test('ordinary accounts cannot inject endpoint auth while endpoint launches use only their own token', () => {
  expect(() => minimalEnvironment('claude', '/tmp/isolated', { ANTHROPIC_BASE_URL: endpoint.baseUrl })).toThrow('Unsupported authentication');
  const background = endpoint.models[0]!.id;
  const env = { ANTHROPIC_BASE_URL: endpoint.baseUrl, ANTHROPIC_AUTH_TOKEN: 'fixture token', ANTHROPIC_DEFAULT_OPUS_MODEL: background, ANTHROPIC_DEFAULT_SONNET_MODEL: background, ANTHROPIC_DEFAULT_HAIKU_MODEL: background, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const launched = launchEnvironment('claude', { account: { account: AccountSchema.parse(raw()), home: '/tmp/isolated', env }, launch: { env: {}, mcpServers: {} } });
  expect(launched).toMatchObject(env); expect(launched).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(launched).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
});

test('endpoint menu ids are stable, missing sources disable them and the cap refuses excess models', () => {
  const custom = AccountSchema.parse(raw()), menu = reconcileEndpointMenu([], [custom]);
  expect(menu[0]!.id).toMatch(/^model_[a-f0-9]{64}$/u); expect(reconcileEndpointMenu(menu, [custom])).toEqual(menu);
  expect(reconcileEndpointMenu(menu, [])[0]).toMatchObject({ enabled: false, unavailableReason: 'The account that serves this model is disabled.' });
  const full = Array.from({ length: 19 }, (_, i) => ModelOptionSchema.parse({ id: `native_${i}`, runtime: 'claude', model: `native-${i}`, label: `Native ${i}`, description: 'Native work.', efforts: ['medium'], enabled: true }));
  expect(() => reconcileEndpointMenu(full, [custom])).toThrow('The model menu holds 19 models. Disable or remove one first.');
});
test('endpoint usage is unknown even when a stale or provider-specific observation has windows', () => {
  const custom = AccountSchema.parse(raw()), observed = { ...status(custom.id), usage: { source: 'stream' as const, observedAt: new Date().toISOString(), fiveHourPct: 100, weeklyPct: 100 } };
  expect(rankAccounts({ accounts: [custom], statuses: [observed], runtime: 'claude', model: 'fixture-glm', deviceId: 'here' })[0]).toMatchObject({ eligible: true, knownUsage: false, effectivePct: 0, weeklyPct: 0 });
});

test('the hub refuses a model-menu overflow atomically before storing an endpoint or its secret', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-endpoint-cap-')); mkdirSync(join(root, 'user')); const homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
  const config = seedConfiguration(); config['x-jevellan'].menu = [...config['x-jevellan'].menu.map(({ unavailableReason: _reason, ...model }) => { void _reason; return { ...model, enabled: true }; }), ...Array.from({ length: 19 - config['x-jevellan'].menu.length }, (_, index) => ModelOptionSchema.parse({ id: `menu_${index}`, runtime: 'claude', model: `native-${index}`, label: `Native ${index}`, description: 'Native work.', efforts: ['medium'], enabled: true }))];
  hub.configuration.put(config, 0, { deviceId: 'here', source: 'install' }); const store = new HubAccounts(hub, 'here');
  expect(() => store.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Endpoint', kind: 'endpoint', endpoint, secret: 'fixture endpoint cap credential' })).toThrow('The model menu holds 19 models. Disable or remove one first.');
  expect(store.list()).toEqual([]); expect(hub.configuration.current()!.configuration['x-jevellan'].menu).toHaveLength(19);
});
test('metered endpoint fallback waits for a free endpoint that serves the same model to become unavailable', () => {
  const free = AccountSchema.parse(raw()), paid = AccountSchema.parse(raw({ id: 'paid', endpoint: { ...endpoint, billing: 'metered' }, paidUse: 'when-subscriptions-run-out' }));
  const ranked = (account: typeof free) => rankAccounts({ accounts: [account, paid], statuses: [status(free.id), status(paid.id)], runtime: 'claude', model: 'fixture-glm', deviceId: 'here' });
  expect(ranked(free).find(row => row.account.id === 'paid')).toMatchObject({ eligible: false, reason: 'paid-not-allowed' });
  expect(ranked({ ...free, enabled: false }).find(row => row.account.id === 'paid')?.eligible).toBe(true);
});

test('an endpoint keeps known device availability while unprobed devices may use its shared credential', () => {
  const account = AccountSchema.parse(raw()), ready = { ...status(account.id), deviceId: 'hub', observedAt: '2026-10-17T12:00:00Z' };
  const local = { ...ready, deviceId: 'member', auth: 'unknown' as const, lastError: 'Unreachable: connection failed', observedAt: '2026-10-17T11:00:00Z' };
  const rank = (statuses: Parameters<typeof rankAccounts>[0]['statuses']) => rankAccounts({ accounts: [account], statuses, runtime: 'claude', model: 'fixture-glm', deviceId: 'member' })[0];
  expect(rank([ready, local])).toMatchObject({ eligible: false, reason: 'unreachable' });
  expect(rank([{ ...ready, auth: 'unknown', lastError: 'Unreachable: connection failed' }, { ...local, auth: 'ready', lastError: undefined }])?.eligible).toBe(true);
  expect(rank([ready, { ...local, auth: 'missing' }])?.eligible).toBe(true);
  expect(rank([ready, { ...local, auth: 'checking' }])?.eligible).toBe(true);
});

test('a normal project start automatically uses the declared endpoint model, effort and saved account', async () => {
  const claude = new FakeRuntime(); Object.defineProperty(claude, 'id', { value: 'claude' });
  const decisionFetch: typeof fetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type !== 'choice') throw new Error('Only placement choices are scripted in this fixture.');
      const ids = Object.keys(question.criteria), choice = ids[0]!;
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])), confidence: 1 }];
    }));
    return Response.json({ model: 'jev-fixture', answers, usage: { input_tokens: 20, output_tokens: 4 } });
  };
  const f = await projectFixture({ runtimes: { fake: new FakeRuntime(), claude }, jevKey: true, decisionFetch });
  try {
    const saved = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Project endpoint', kind: 'endpoint', endpoint, secret: 'fixture project endpoint token' });
    await f.app.accounts.check(saved.account.id);
    const menu = (await f.app.configuration()).configuration['x-jevellan'].menu, model = menu.find(row => row.endpointAccountId === saved.account.id)!;
    const settings = await f.app.projectWork.admission.settings(f.project.id); await f.app.projectHub.putSettings({ ...settings, placement: { ...settings.placement, allowedModelIds: [model.id] } }, settings.revision);
    claude.enqueueTurn(async turn => {
      expect(turn.input.model).toBe('fixture-glm'); expect(turn.input.effort).toBe('medium'); expect(turn.input.account.account.id).toBe(saved.account.id);
      expect(turn.input.account.env).toMatchObject({ ANTHROPIC_BASE_URL: endpoint.baseUrl, ANTHROPIC_AUTH_TOKEN: 'fixture project endpoint token' });
      await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Inspected the project through its endpoint.' }); return { status: 'completed' };
    }, forThread());
    const made = await f.json(`/api/projects/${f.project.id}/threads`, ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'endpoint_project_start', title: 'Inspect a narrow area', task: 'Read README and report progress.' });
    await f.waitFor(() => f.thread(made.threadId).lastReport?.summary, summary => summary === 'Inspected the project through its endpoint.'); await f.app.projectWork.idle(f.project.id);
    expect(f.thread(made.threadId).placement).toMatchObject({ runtime: 'claude', model: 'fixture-glm', effortEffective: 'medium', accountId: saved.account.id, accountChoice: { source: 'only-option' } });
  } finally { await f.close(); }
});
