import { expect, test } from 'vitest';
import { AccountSchema, AccountStatusSchema, JevCallSchema, PlacementRecordSchema, ProjectSchema, seedConfiguration, type Account, type AccountStatus, type ModelOption } from '../packages/core/dist/index.js';
import { approximateTokens, LEAVE_GIT_MAIN, MAIN_NOT_AVAILABLE, NO_PLACEMENT, NO_THREAD_MODEL, PLACEMENT_NOT_ENABLED, PLACEMENT_QUESTION_SET, placementCandidates, placementDevices, placementFallback, placementOptions, REMOTE_NOT_AVAILABLE, UNKNOWN_PLACEMENT_DEVICE, UNKNOWN_PLACEMENT_MODEL, type PlacementCandidates, type PlacementDevice, type PlacementInput, type PlacementRuntime } from '../packages/decisions/dist/index.js';

const now = Date.parse('2026-10-03T10:00:00Z');
const later = new Date(now + 3_600_000).toISOString();
const settings = seedConfiguration()['x-jevellan'];
const swift: ModelOption = { id: 'swift', runtime: 'codex', model: 'swift-version', enabled: true, label: 'Swift', description: 'Fast coding model.', efforts: ['low', 'medium', 'high', 'xhigh'] };
const deep: ModelOption = { id: 'deep', runtime: 'claude', model: 'deep-version', enabled: true, label: 'Deep', description: 'Strong for complex changes.', efforts: ['high', 'max'] };
const support: PlacementRuntime = { mcp: true, readOnlyEnforced: true, edit: true, shell: true, turns: true, displayName: '' };
const runtimes = new Map<string, PlacementRuntime>([['codex', { ...support, displayName: 'Codex' }], ['claude', { ...support, displayName: 'Claude' }]]);
const project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_app', name: 'App', paths: { dev_mini: '/work/app', dev_studio: '/srv/app' }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
function account(id: string, runtime: string, over: Partial<Account> = {}): Account {
  return AccountSchema.parse({ schema: 'account-v1', id, runtime, label: id, kind: 'subscription', enabled: true, credential: 'per-device', ...over });
}
function status(accountId: string, deviceId: string, over: Partial<AccountStatus> = {}): AccountStatus {
  return AccountStatusSchema.parse({ schema: 'account-status-v2', accountId, deviceId, auth: 'ready', observedAt: new Date(now - 60_000).toISOString(), ...over });
}
const accounts = [account('codex_a', 'codex'), account('claude_a', 'claude')];
const ready = (deviceIds: string[]) => deviceIds.flatMap((deviceId) => accounts.map((entry) => status(entry.id, deviceId)));
function device(id: string, name: string, over: Partial<PlacementDevice> = {}): PlacementDevice {
  return { id, name, status: 'online', revoked: false, hasPath: true, allowed: true, running: 0, isCoordinator: id === 'dev_mini', ...over };
}
const mini = device('dev_mini', 'Mac mini'); const studio = device('dev_studio', 'Studio');
const open = { mainIsolation: true, remoteDevices: true }; const closed = { mainIsolation: false, remoteDevices: false };
function input(over: Partial<PlacementInput> = {}): PlacementInput {
  return { settings: { ...settings, menu: [swift, deep] }, project, defaultIsolation: 'worktree', runtimes, accounts, statuses: ready(['dev_mini', 'dev_studio']),
    devices: [mini, studio], maxRunningPerDevice: 4, ignoreRunningLimit: false, deviceId: 'dev_mini', coordinatorDeviceId: 'dev_mini', gates: open, fixed: {}, now, ...over };
}
function candidates(value: PlacementInput): PlacementCandidates {
  const result = placementCandidates(value); if ('refused' in result) throw new Error(result.refused); return result;
}
function refusal(value: PlacementInput): string {
  const result = placementCandidates(value); if (!('refused' in result)) throw new Error('Expected a refusal.'); return result.refused;
}
const fallback = (value: PlacementInput, fixedOnly = false) => placementFallback(value, candidates(value), PLACEMENT_NOT_ENABLED, [], fixedOnly);
const ids = (devices: PlacementDevice[]) => devices.map((entry) => entry.id);
const sorted = (values: string[]) => [...values].sort();
function expectPartition(value: PlacementInput, options: Pick<PlacementCandidates, 'models' | 'devices' | 'excludedModels' | 'excludedDevices'>) {
  const models = [...options.models.map((entry) => entry.model.id), ...options.excludedModels.map((entry) => entry.modelId)];
  const devices = [...ids(options.devices), ...options.excludedDevices.map((entry) => entry.deviceId)];
  expect(sorted(models)).toEqual(sorted(value.settings.menu.map((model) => model.id)));
  expect(sorted(devices)).toEqual(sorted(value.devices.map((entry) => entry.id)));
}

test('candidates cover every menu entry and roster device exactly once', () => {
  const value = input(); const result = candidates(value);
  expect(PLACEMENT_QUESTION_SET).toBe('p-v1');
  expect(result).toMatchObject({ isolations: ['worktree', 'main'], atLimit: false, excludedModels: [], excludedDevices: [] });
  expect(result.models.map((entry) => [entry.model.id, entry.devices, entry.unavailable])).toEqual([['swift', ['dev_mini', 'dev_studio'], []], ['deep', ['dev_mini', 'dev_studio'], []]]);
  expectPartition(value, result); expectPartition(value, result.main!);
  const crowded = input({ settings: { ...settings, menu: [swift, deep, { ...deep, id: 'off', enabled: false }] }, devices: [mini, studio, device('dev_lab', 'Lab', { status: 'offline' })], statuses: ready(['dev_mini']) });
  const narrowed = candidates(crowded);
  expectPartition(crowded, narrowed); expectPartition(crowded, narrowed.main!);
  expect(narrowed.models.map((entry) => [entry.model.id, entry.devices])).toEqual([['swift', ['dev_mini']], ['deep', ['dev_mini']]]);
  expect(narrowed.models[0]!.unavailable).toEqual([{ deviceId: 'dev_studio', reason: 'Codex needs login' }]);
});

test('offline, stale, revoked, unset and full devices are excluded with reasons, and the placing device counts as online', () => {
  const devices = [device('dev_mini', 'Mac mini', { status: 'stale' }), device('dev_studio', 'Studio', { status: 'offline' }), device('dev_lab', 'Lab', { status: 'stale' }),
    device('dev_old', 'Old', { revoked: true }), device('dev_bare', 'Bare', { hasPath: false }), device('dev_denied', 'Denied', { allowed: false }), device('dev_full', 'Full', { running: 4 })];
  const statuses = ready(devices.map((entry) => entry.id));
  const result = candidates(input({ devices, statuses }));
  expect(ids(result.devices)).toEqual(['dev_mini']);
  expect(result.excludedDevices).toEqual([{ deviceId: 'dev_studio', reason: 'offline' }, { deviceId: 'dev_lab', reason: 'offline' }, { deviceId: 'dev_old', reason: 'offline' },
    { deviceId: 'dev_bare', reason: 'not set up for this project' }, { deviceId: 'dev_denied', reason: 'not set up for this project' }, { deviceId: 'dev_full', reason: 'at its running limit (4)' }]);
  expect(ids(candidates(input({ devices, statuses, ignoreRunningLimit: true })).devices)).toEqual(['dev_mini', 'dev_full']);
  expect(candidates(input({ devices, statuses, maxRunningPerDevice: 2 })).excludedDevices.at(-1)).toEqual({ deviceId: 'dev_full', reason: 'at its running limit (2)' });
  // Another device's stale row still reads offline; a revoked placing device is never a candidate.
  expect(refusal(input({ devices: [device('dev_mini', 'Mac mini', { revoked: true })] }))).toBe(`${NO_PLACEMENT}: Mac mini: offline.`);
  expect(fallback(input({ devices, statuses })).deviceId).toBe('dev_mini');
});

test('main isolation needs the main policy, a free checkout and a checkout on main', () => {
  const busy = device('dev_mini', 'Mac mini', { mainBlockedBy: 'Fix login' }); const feature = device('dev_studio', 'Studio', { checkoutBranch: 'feature' });
  const none = candidates(input({ devices: [busy, feature] }));
  expect(none.isolations).toEqual(['worktree']); expect(none.main).toBeUndefined(); expect(ids(none.devices)).toEqual(['dev_mini', 'dev_studio']);
  const onMain = candidates(input({ devices: [busy, device('dev_studio', 'Studio', { checkoutBranch: 'main' })] }));
  expect(onMain.isolations).toEqual(['worktree', 'main']); expect(ids(onMain.devices)).toEqual(['dev_mini', 'dev_studio']);
  expect(ids(onMain.main!.devices)).toEqual(['dev_studio']); expect(onMain.main!.excludedDevices).toEqual([{ deviceId: 'dev_mini', reason: 'main checkout busy: Fix login' }]);
  expect(placementOptions(onMain, 'main')).toEqual(onMain.main); expect(ids(placementOptions(onMain, 'worktree').devices)).toEqual(['dev_mini', 'dev_studio']);
  expect(candidates(input({ project: { ...project, branchPolicy: 'external' } })).isolations).toEqual(['worktree']);
  expect(candidates(input({ fixed: { isolation: 'worktree' } })).isolations).toEqual(['worktree']);
  const fixedMain = candidates(input({ devices: [busy, device('dev_studio', 'Studio', { checkoutBranch: 'main' })], fixed: { isolation: 'main' } }));
  expect(fixedMain.isolations).toEqual(['main']); expect(ids(fixedMain.devices)).toEqual(['dev_studio']);
  expect(() => placementOptions(fixedMain, 'worktree')).toThrow('This isolation is not a placement candidate.');
  expect(fallback(input({ devices: [busy, device('dev_studio', 'Studio', { checkoutBranch: 'main' })], fixed: { isolation: 'main' } }))).toMatchObject({ isolation: 'main', deviceId: 'dev_studio', fixed: ['isolation'],
    eligibleDevices: ['dev_studio'], excludedDevices: [{ deviceId: 'dev_mini', reason: 'main checkout busy: Fix login' }] });
  expect(refusal(input({ devices: [busy, feature], fixed: { isolation: 'main' } }))).toBe(`${NO_PLACEMENT}: Mac mini: main checkout busy: Fix login; Studio: checkout is on feature, not main.`);
});

test('models are excluded for settings, runtime and capability reasons, and per device with the runtime display name', () => {
  const menu: ModelOption[] = [swift, deep, { ...deep, id: 'off', enabled: false }, { ...deep, id: 'fable', enabled: false, unavailableReason: 'Model discovery has not run.' },
    { ...swift, id: 'quiet', runtime: 'paused' }, { ...swift, id: 'ghost', runtime: 'missing' }, { ...swift, id: 'chat', runtime: 'chat' }, { ...swift, id: 'viewer', runtime: 'viewer' }, { ...swift, id: 'nosh', runtime: 'nosh' }];
  const value = input({ settings: { ...settings, menu, runtimes: { codex: { enabled: true }, claude: { enabled: true }, paused: { enabled: false }, missing: { enabled: true }, chat: { enabled: true }, viewer: { enabled: true }, nosh: { enabled: true } } },
    runtimes: new Map([...runtimes, ['paused', { ...support, displayName: 'Paused' }], ['chat', { ...support, turns: false, displayName: 'Chat' }], ['viewer', { ...support, edit: false, displayName: 'Viewer' }], ['nosh', { ...support, shell: false, displayName: 'Nosh' }]]),
    statuses: [status('codex_a', 'dev_mini', { auth: 'needs-login' }), status('codex_a', 'dev_studio', { coolingUntil: later }), status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio', { modelCooling: { 'deep-version': later } })] });
  const result = candidates(value);
  expectPartition(value, result);
  expect(result.models.map((entry) => [entry.model.id, entry.devices, entry.unavailable])).toEqual([['deep', ['dev_mini'], [{ deviceId: 'dev_studio', reason: 'Claude cooling down' }]]]);
  expect(result.excludedModels).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex needs login; Studio: Codex cooling down' }, { modelId: 'off', reason: 'disabled in Settings' },
    { modelId: 'fable', reason: 'Model discovery has not run' }, { modelId: 'quiet', reason: 'runtime disabled' }, { modelId: 'ghost', reason: 'runtime cannot run threads here' },
    { modelId: 'chat', reason: 'runtime cannot run threads here' }, { modelId: 'viewer', reason: 'runtime cannot run threads here' }, { modelId: 'nosh', reason: 'runtime cannot run threads here' }]);
  const reasons = (over: Partial<AccountStatus> | null, extra: Account[] = []) => candidates(input({ accounts: [...accounts, ...extra],
    statuses: [status('claude_a', 'dev_mini'), ...over ? [status('codex_a', 'dev_mini', over)] : []], gates: closed })).excludedModels;
  expect(reasons({ auth: 'expired' })).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex login expired' }]);
  expect(reasons({ usage: { weeklyPct: 95, source: 'probe', observedAt: new Date(now).toISOString() } })).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex usage ceiling reached' }]);
  expect(reasons(null)).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex needs login' }]);
  expect(candidates(input({ accounts: [account('claude_a', 'claude')], statuses: [status('claude_a', 'dev_mini')], gates: closed })).excludedModels).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex no account' }]);
  expect(candidates(input({ accounts: [account('codex_a', 'codex', { enabled: false }), account('claude_a', 'claude')], gates: closed })).excludedModels).toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex account disabled' }]);
  expect(candidates(input({ accounts: [account('codex_k', 'codex', { kind: 'api-key', credential: 'shared', paidUse: 'never' }), account('claude_a', 'claude')], statuses: [status('codex_k', 'dev_mini'), status('claude_a', 'dev_mini')], gates: closed })).excludedModels)
    .toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex paid use not allowed' }]);
  expect(candidates(input({ accounts: [account('codex_h', 'codex', { kind: 'api-key', credential: 'hub-refreshed', paidUse: 'always' }), account('claude_a', 'claude')], statuses: [status('codex_h', 'dev_mini'), status('claude_a', 'dev_mini')], gates: closed })).excludedModels)
    .toEqual([{ modelId: 'swift', reason: 'Mac mini: Codex not supported' }]);
});

test('refusals name each device reason once and leave out gated and unchosen devices', () => {
  const nobody = { statuses: [] as AccountStatus[] };
  expect(refusal(input(nobody))).toBe(`${NO_PLACEMENT}: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: Codex needs login; Studio: Claude needs login.`);
  expect(refusal(input({ ...nobody, settings: { ...settings, menu: [swift, deep, { ...deep, id: 'deep2', model: 'deep-two' }] } })))
    .toBe(`${NO_PLACEMENT}: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: Codex needs login; Studio: Claude needs login.`);
  expect(refusal(input({ ...nobody, gates: closed }))).toBe('No device can run any enabled model: Mac mini: Codex needs login; Mac mini: Claude needs login.');
  expect(refusal(input({ ...nobody, devices: [mini, device('dev_studio', 'Studio', { status: 'offline' })] }))).toBe(`${NO_PLACEMENT}: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: offline.`);
  expect(refusal(input({ ...nobody, fixed: { deviceId: 'dev_studio' } }))).toBe(`${NO_PLACEMENT}: Studio: Codex needs login; Studio: Claude needs login.`);
  expect(refusal(input({ gates: closed, devices: [device('dev_mini', 'Mac mini', { hasPath: false }), studio] }))).toBe(`${NO_PLACEMENT}: Mac mini: not set up for this project.`);
  expect(refusal(input({ devices: [] }))).toBe(`${NO_PLACEMENT}.`);
  expect(refusal(input({ settings: { ...settings, menu: [{ ...swift, enabled: false }, { ...deep, enabled: false }] } }))).toBe(NO_THREAD_MODEL);
  expect(refusal(input({ settings: { ...settings, menu: [] } }))).toBe('No enabled model can run threads.');
  expect(refusal(input({ settings: { ...settings, menu: [swift, { ...deep, enabled: false }] }, fixed: { modelId: 'deep' } }))).toBe('Deep cannot run threads: disabled in Settings.');
  expect(refusal(input({ statuses: [status('codex_a', 'dev_mini')], fixed: { modelId: 'deep' } }))).toBe('No device can run Deep: Mac mini: Claude needs login; Studio: Claude needs login.');
});

test('running limits never refuse a start: full devices queue the thread and refusals name lasting reasons', () => {
  const full = device('dev_mini', 'Mac mini', { running: 4 });
  const partly = candidates(input({ devices: [full, device('dev_studio', 'Studio', { running: 1 })] }));
  expect(partly.atLimit).toBe(false); expect(ids(partly.devices)).toEqual(['dev_studio']); expect(partly.excludedDevices).toEqual([{ deviceId: 'dev_mini', reason: 'at its running limit (4)' }]);
  const both = input({ devices: [full, device('dev_studio', 'Studio', { running: 5 })] });
  const queued = candidates(both);
  expect(queued.atLimit).toBe(true); expect(ids(queued.devices)).toEqual(['dev_mini', 'dev_studio']); expect(queued.excludedDevices).toEqual([]);
  expect(fallback(both).deviceId).toBe('dev_mini');
  expect(candidates({ ...both, ignoreRunningLimit: true }).atLimit).toBe(false);
  expect(refusal({ ...both, statuses: [] })).toBe(`${NO_PLACEMENT}: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: Codex needs login; Studio: Claude needs login.`);
  expect(refusal({ ...both, statuses: [], devices: [full, device('dev_studio', 'Studio', { running: 5, status: 'offline' })] })).toBe(`${NO_PLACEMENT}: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: offline.`);
});

test('phase gates refuse fixed fields in a fixed order and keep defaults on this device in a worktree', () => {
  const gated = (fixed: PlacementInput['fixed'], over: Partial<PlacementInput> = {}) => refusal(input({ gates: closed, fixed, ...over }));
  const external = { project: { ...project, branchPolicy: 'external' as const } };
  expect(gated({ isolation: 'main' })).toBe(MAIN_NOT_AVAILABLE);
  expect(gated({ isolation: 'main' }, external)).toBe(LEAVE_GIT_MAIN);
  expect(refusal(input({ fixed: { isolation: 'main' }, ...external }))).toBe('This project is set to Leave git to me, so threads cannot work on main.');
  expect(gated({ deviceId: 'dev_studio' })).toBe(REMOTE_NOT_AVAILABLE);
  expect(gated({ isolation: 'main', deviceId: 'dev_studio' })).toBe('Main isolation is not available yet.');
  expect(gated({ modelId: 'nope', isolation: 'main', deviceId: 'dev_ghost' }, external)).toBe(UNKNOWN_PLACEMENT_MODEL);
  expect(gated({ deviceId: 'dev_ghost', isolation: 'main' }, external)).toBe(UNKNOWN_PLACEMENT_DEVICE);
  expect([UNKNOWN_PLACEMENT_MODEL, UNKNOWN_PLACEMENT_DEVICE, REMOTE_NOT_AVAILABLE]).toEqual(['Choose a model from the configuration.', 'Choose a registered device.', 'Threads run only on this device for now.']);
  const local = input({ gates: closed, defaultIsolation: 'main', fixed: { deviceId: 'dev_mini' } });
  expect(candidates(local)).toMatchObject({ isolations: ['worktree'], excludedDevices: [{ deviceId: 'dev_studio', reason: 'not chosen' }] });
  const roster = input({ gates: closed, defaultIsolation: 'main', coordinatorDeviceId: 'dev_studio', devices: [device('dev_mini', 'Mac mini', { running: 3, status: 'stale' }), studio] });
  const result = candidates(roster);
  expect(result.isolations).toEqual(['worktree']); expect(result.main).toBeUndefined();
  expect(result.excludedDevices).toEqual([{ deviceId: 'dev_studio', reason: 'not available until remote threads exist' }]);
  expect(fallback(roster)).toMatchObject({ isolation: 'worktree', deviceId: 'dev_mini', eligibleDevices: ['dev_mini'], excludedDevices: [{ deviceId: 'dev_studio', reason: 'not available until remote threads exist' }] });
  expect(fallback(input({ defaultIsolation: 'main' })).isolation).toBe('main');
  expect(fallback(input({ defaultIsolation: 'main', ...external })).isolation).toBe('worktree');
});

test('the fallback takes the default isolation, the first eligible model and medium effort mapped to the model', () => {
  const value = input({ statuses: [status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio')] });
  const record = fallback(value);
  expect(record).toEqual({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'claude', modelId: 'deep', model: 'deep-version',
    effortRequested: 'medium', effortEffective: 'high', deviceId: 'dev_mini', accountId: 'claude_a', eligibleModels: ['deep'],
    excludedModels: [{ modelId: 'swift', reason: 'Mac mini: Codex needs login; Studio: Codex needs login' }], eligibleDevices: ['dev_mini', 'dev_studio'], excludedDevices: [],
    error: { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' }, jevCalls: [], decidedAt: '2026-10-03T10:00:00.000Z' });
  expect(PlacementRecordSchema.parse(record)).toEqual(record);
  expect(PLACEMENT_NOT_ENABLED).toEqual({ kind: 'not-enabled', message: 'Jev placement is not enabled yet.' });
  expect(fallback(input())).toMatchObject({ modelId: 'swift', runtime: 'codex', effortRequested: 'medium', effortEffective: 'medium', accountId: 'codex_a' });
  expect(fallback(input({ fixed: { effort: 'max' } }))).toMatchObject({ modelId: 'swift', fixed: ['effort'], effortRequested: 'max', effortEffective: 'xhigh' });
  expect(fallback(input({ fixed: { effort: 'low', modelId: 'deep' } }))).toMatchObject({ modelId: 'deep', fixed: ['model', 'effort'], effortRequested: 'low', effortEffective: 'high', eligibleModels: ['deep'],
    excludedModels: [{ modelId: 'swift', reason: 'not chosen' }] });
  const call = JevCallSchema.parse({ schema: 'jev-call-v1', kind: 'placement', requestedModel: 'jev-1.13.0', returnedModel: 'jev-1.13.0', usage: { input_tokens: 40, output_tokens: 4 }, latencyMs: 12 });
  const calls = [call]; const failed = placementFallback(value, candidates(value), { kind: 'timeout', message: 'x'.repeat(400) }, calls);
  expect(failed.error).toEqual({ kind: 'timeout', message: 'x'.repeat(300) }); expect(failed.jevCalls).toEqual([call]); expect(failed.jevCalls).not.toBe(calls);
});

test('the fallback device is the coordinator when it can run the model, else the fewest running, ties by name', () => {
  const codexOnly = { settings: { ...settings, menu: [swift] } };
  expect(fallback(input({ ...codexOnly, coordinatorDeviceId: 'dev_studio', devices: [mini, device('dev_studio', 'Studio', { running: 3 })] })).deviceId).toBe('dev_studio');
  const devices = [mini, device('dev_studio', 'Studio', { running: 2 }), device('dev_lab', 'Lab', { running: 1 }), device('dev_zeta', 'Zeta', { running: 1 })];
  const withoutCoordinator = input({ ...codexOnly, devices, statuses: [status('codex_a', 'dev_mini', { auth: 'needs-login' }), ...['dev_studio', 'dev_lab', 'dev_zeta'].map((id) => status('codex_a', id))] });
  const record = fallback(withoutCoordinator);
  expect(record).toMatchObject({ deviceId: 'dev_lab', eligibleDevices: ['dev_studio', 'dev_lab', 'dev_zeta'], excludedDevices: [{ deviceId: 'dev_mini', reason: 'Codex needs login' }] });
  expect(placementDevices(withoutCoordinator, placementOptions(candidates(withoutCoordinator), 'worktree'), candidates(withoutCoordinator).models[0]!).excluded).toEqual(record.excludedDevices);
  const tied = input({ ...codexOnly, coordinatorDeviceId: 'dev_none', devices: [device('dev_zeta', 'Zeta', { running: 1 }), device('dev_alpha', 'Alpha', { running: 1 }), device('dev_beta', 'Beta', { running: 2 })],
    statuses: ['dev_zeta', 'dev_alpha', 'dev_beta'].map((id) => status('codex_a', id)) });
  expect(fallback(tied).deviceId).toBe('dev_alpha');
  const usage = (weeklyPct: number) => ({ weeklyPct, source: 'probe' as const, observedAt: new Date(now).toISOString() });
  const ranked = input({ ...codexOnly, gates: closed, accounts: [account('codex_busy', 'codex'), account('codex_calm', 'codex')], statuses: [status('codex_busy', 'dev_mini', { usage: usage(80) }), status('codex_calm', 'dev_mini', { usage: usage(10) })] });
  expect(fallback(ranked).accountId).toBe('codex_calm');
});

test('fixed fields are kept, and a placement without open choices records source fixed', () => {
  const value = input({ fixed: { isolation: 'worktree', modelId: 'swift', effort: 'low', deviceId: 'dev_studio' } });
  const result = candidates(value);
  expect(result).toMatchObject({ isolations: ['worktree'], excludedModels: [{ modelId: 'deep', reason: 'not chosen' }], excludedDevices: [{ deviceId: 'dev_mini', reason: 'not chosen' }] });
  expectPartition(value, result);
  const record = fallback(value, true);
  expect(record).toMatchObject({ source: 'fixed', fixed: ['isolation', 'model', 'effort', 'device'], isolation: 'worktree', modelId: 'swift', effortEffective: 'low', deviceId: 'dev_studio', accountId: 'codex_a' });
  expect(record).not.toHaveProperty('error');
  expect(fallback(input({ gates: closed, settings: { ...settings, menu: [deep] }, fixed: { effort: 'max' } }), true)).toMatchObject({ source: 'fixed', fixed: ['effort'], modelId: 'deep', deviceId: 'dev_mini' });
});

test('approximateTokens is the existing state estimator', () => {
  expect(approximateTokens('abcdef')).toBe(2); expect(approximateTokens('abcd')).toBe(2); expect(approximateTokens('é')).toBe(1); expect(approximateTokens('')).toBe(0);
});
