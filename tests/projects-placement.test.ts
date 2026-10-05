import { expect, test, vi } from 'vitest';
import { AccountSchema, AccountStatusSchema, JevCallSchema, PlacementRecordSchema, ProjectSchema, SecretRedactor, seedConfiguration, type Account, type AccountStatus, type ModelOption } from '../packages/core/dist/index.js';
import { approximateTokens, buildPlacementState, decidePlacement, JevClient, JevError, LEAVE_GIT_MAIN, MAIN_NOT_AVAILABLE, NO_PLACEMENT, NO_THREAD_MODEL, overrideSentence, parseJevResponse, PLACEMENT_INCOMPATIBLE, PLACEMENT_INSTRUCTIONS,
  PLACEMENT_ISOLATION_CRITERIA, PLACEMENT_QUESTION_SET, placementCandidates, placementDevices, placementDeviceSetup, placementFallback, placementOptions, PlacementStateSchema, preparePlacementA, preparePlacementB, REMOTE_NOT_AVAILABLE,
  TASK_SHORTENED, UNKNOWN_PLACEMENT_DEVICE, UNKNOWN_PLACEMENT_MODEL, type DecisionClient, type JevQuestions, type PlacementCandidates, type PlacementDevice, type PlacementInput, type PlacementPacketInput, type PlacementRuntime } from '../packages/decisions/dist/index.js';

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
const NO_KEY = { kind: 'no-key', message: 'no key configured' };
const fallback = (value: PlacementInput, fixedOnly = false) => placementFallback(value, candidates(value), NO_KEY, [], fixedOnly);
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

test('the device setup gives every device in roster order the reason a thread of the project cannot run there, ignoring limits and fixed fields (D281)', () => {
  const lab = device('dev_lab', 'Lab', { status: 'offline' }); const stale = device('dev_stale', 'Stale', { status: 'stale' });
  const gone = device('dev_gone', 'Gone', { revoked: true }); const bare = device('dev_bare', 'Bare', { hasPath: false });
  const outside = device('dev_out', 'Outside', { allowed: false }); const full = device('dev_full', 'Full', { running: 9 });
  const value = input({ devices: [mini, studio, lab, stale, gone, bare, outside, full], statuses: ready(['dev_mini', 'dev_full', 'dev_bare']), fixed: { deviceId: 'dev_mini', modelId: 'swift' } });
  expect(placementDeviceSetup(value)).toEqual([
    { deviceId: 'dev_mini' }, { deviceId: 'dev_studio', reason: 'Codex needs login; Claude needs login' }, { deviceId: 'dev_lab', reason: 'offline' },
    { deviceId: 'dev_stale', reason: 'offline' }, { deviceId: 'dev_gone', reason: 'offline' }, { deviceId: 'dev_bare', reason: 'not set up for this project' },
    { deviceId: 'dev_out', reason: 'not set up for this project' }, { deviceId: 'dev_full' },
  ]);
  // One model with an eligible account is enough; the placing device counts as online whatever its row says (D8).
  expect(placementDeviceSetup(input({ devices: [device('dev_mini', 'Mac mini', { status: 'stale' }), studio], statuses: [status('claude_a', 'dev_studio'), status('codex_a', 'dev_mini')] })))
    .toEqual([{ deviceId: 'dev_mini' }, { deviceId: 'dev_studio' }]);
  // Without any model that runs threads no device is to blame (placement refuses with its own sentence).
  expect(placementDeviceSetup(input({ settings: { ...settings, menu: [{ ...swift, enabled: false }] } }))).toEqual([{ deviceId: 'dev_mini' }, { deviceId: 'dev_studio' }]);
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
    error: { kind: 'no-key', message: 'no key configured' }, jevCalls: [], decidedAt: '2026-10-03T10:00:00.000Z' });
  expect(PlacementRecordSchema.parse(record)).toEqual(record);
  expect(NO_KEY).toEqual({ kind: 'no-key', message: new JevError('no-key').message });
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

// Jev placement (phase 4): the response builder of decision-selection.test.ts, with explicit probabilities for near ties.
type Answer = string | { choice: string; probabilities: Record<string, number> };
function response(questions: JevQuestions, values: Record<string, Answer> = {}) {
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type !== 'choice') throw new Error('Unexpected fixture question.');
    const value = values[id] ?? Object.keys(question.criteria)[0]!;
    const answer = typeof value === 'string' ? { choice: value, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === value ? 1 : 0])) } : value;
    return [id, { type: 'choice', ...answer, confidence: 1 }];
  }));
  return parseJevResponse(JSON.stringify({ model: 'fixture-returned', answers, usage: { input_tokens: 20, output_tokens: 10 } }), questions);
}
/** A scripted Jev: every call answers with the next answer set or throws the next error. */
function jev(...script: Array<Record<string, Answer> | Error>) {
  return vi.fn<DecisionClient['decide']>(async (request) => {
    const next = script.shift(); if (!next) throw new Error('Unexpected Jev call.');
    if (next instanceof Error) throw next; return response(request.questions, next);
  });
}
const packet: PlacementPacketInput = { title: 'Add A', task: 'Add the A endpoint with tests.', activeThreads: [], overrides: [] };
const noSecrets = new SecretRedactor();
const place = (value: PlacementInput, decide: DecisionClient['decide'], signal = new AbortController().signal, over: Partial<PlacementPacketInput> = {}) =>
  decidePlacement({ decide }, { ...value, jevModel: 'jev-1.13.0', packet: { ...packet, ...over }, redactor: noSecrets }, signal);
async function placed(...args: Parameters<typeof place>) {
  const result = await place(...args); if (result.kind !== 'placed') throw new Error(result.message); return result.record;
}
const usage = (weeklyPct: number) => ({ weeklyPct, source: 'probe' as const, observedAt: new Date(now).toISOString() });
const questionKeys = (value: PlacementInput) => Object.keys(preparePlacementA(value, candidates(value)));
const placementCall = { schema: 'jev-call-v1', kind: 'placement', requestedModel: 'jev-1.13.0', returnedModel: 'fixture-returned', usage: { input_tokens: 20, output_tokens: 10 }, latencyMs: expect.any(Number) };

test('Call A asks isolation only when both are allowed, the eligible models by description and the effort guide', async () => {
  const value = input(); const a = preparePlacementA(value, candidates(value));
  expect(Object.keys(a)).toEqual(['isolation', 'pick_model', 'effort']);
  expect(a.isolation).toEqual({ type: 'choice', instructions: 'Choose how this new thread works: in its own worktree ending in a pull request, or directly on main.', criteria: {
    worktree: 'Larger, riskier or multi-file change that should be reviewed as a pull request.', main: 'Small, contained change that is safe to land directly on main without review.' } });
  expect(a.pick_model).toEqual({ type: 'choice', instructions: 'Choose the model that should carry this thread end to end.', criteria: { swift: 'Fast coding model.', deep: 'Strong for complex changes.' } });
  expect(a.effort).toEqual({ type: 'choice', instructions: 'Choose the reasoning effort this thread needs.', criteria: settings.effortGuide });
  expect(a.effort?.type === 'choice' && Object.keys(a.effort.criteria)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(a.isolation?.type === 'choice' && a.isolation.criteria).toEqual(PLACEMENT_ISOLATION_CRITERIA);
  expect(questionKeys(input({ project: { ...project, branchPolicy: 'external' } }))).toEqual(['pick_model', 'effort']);
  expect(questionKeys(input({ gates: closed }))).toEqual(['pick_model', 'effort']);
  expect(questionKeys(input({ fixed: { isolation: 'worktree' } }))).toEqual(['pick_model', 'effort']);
  expect(questionKeys(input({ devices: [device('dev_mini', 'Mac mini', { mainBlockedBy: 'Fix login' }), device('dev_studio', 'Studio', { checkoutBranch: 'feature' })] }))).toEqual(['pick_model', 'effort']);
  expect(questionKeys(input({ fixed: { modelId: 'deep', effort: 'high' } }))).toEqual(['isolation']);
  expect(questionKeys(input({ statuses: [status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio')] }))).toEqual(['isolation', 'effort']);
  // Nothing to ask: no Jev call, and the record lists only the explicit fields (D30b).
  const decide = jev();
  const record = await placed(input({ gates: closed, settings: { ...settings, menu: [deep] }, fixed: { effort: 'max' } }), decide);
  expect(decide).not.toHaveBeenCalled();
  expect(record).toMatchObject({ source: 'fixed', fixed: ['effort'], modelId: 'deep', effortEffective: 'max', deviceId: 'dev_mini', accountId: 'claude_a', jevCalls: [] });
  expect(record).not.toHaveProperty('probabilities'); expect(record).not.toHaveProperty('error');
});

test('Call B offers each device that can run the chosen model, with the brief criteria', () => {
  const value = input({ devices: [device('dev_mini', 'Mac mini', { running: 2, checkoutBranch: 'main' }), studio, device('dev_lab', 'Lab', { running: 3, checkoutBranch: 'feature' }), device('dev_bare', 'Bare', { hasPath: false })],
    statuses: [...ready(['dev_mini', 'dev_lab']), status('claude_a', 'dev_studio'), status('codex_a', 'dev_studio', { auth: 'needs-login' })] });
  const result = candidates(value);
  expect(preparePlacementB(value, result, { isolation: 'worktree', model: swift })).toEqual({ device: { type: 'choice', instructions: 'Choose the device that should run this thread.', criteria: {
    dev_mini: "Mac mini: 2 threads running here, this is the coordinator's device, project checkout is on main", dev_lab: 'Lab: 3 threads running here, project checkout is on feature' } } });
  const deepWorktree = preparePlacementB(value, result, { isolation: 'worktree', model: deep }).device;
  expect(deepWorktree?.type === 'choice' && deepWorktree.criteria).toEqual({ dev_mini: "Mac mini: 2 threads running here, this is the coordinator's device, project checkout is on main",
    dev_studio: 'Studio: 0 threads running here', dev_lab: 'Lab: 3 threads running here, project checkout is on feature' });
  const deepMain = preparePlacementB(value, result, { isolation: 'main', model: deep }).device;
  expect(deepMain?.type === 'choice' && Object.keys(deepMain.criteria)).toEqual(['dev_mini', 'dev_studio']);
  expect(PLACEMENT_INSTRUCTIONS.device).toBe('Choose the device that should run this thread.');
  const fixed = input({ ...value, fixed: { deviceId: 'dev_mini' } });
  expect(preparePlacementB(fixed, candidates(fixed), { isolation: 'worktree', model: deep })).toEqual({});
  const single = input({ gates: closed });
  expect(preparePlacementB(single, candidates(single), { isolation: 'worktree', model: deep })).toEqual({});
  const narrowed = input({ ...value, statuses: [status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio'), status('codex_a', 'dev_lab')] });
  expect(preparePlacementB(narrowed, candidates(narrowed), { isolation: 'worktree', model: swift })).toEqual({});
  const busy = input({ devices: [device('dev_mini', 'Mac mini', { mainBlockedBy: 'Fix login' }), studio], statuses: [status('codex_a', 'dev_mini'), status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio')] });
  expect(() => preparePlacementB(busy, candidates(busy), { isolation: 'main', model: swift })).toThrow('This model is not a placement candidate for this isolation.');
});

test('Jev answers resolve to the highest probability, the mapped effort and the best-ranked account on the chosen device', async () => {
  const value = input({ accounts: [...accounts, account('claude_b', 'claude')],
    statuses: [status('codex_a', 'dev_mini'), status('codex_a', 'dev_studio'), status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio', { usage: usage(80) }), status('claude_b', 'dev_studio', { usage: usage(10) })] });
  // Jev's choice sits 0.011 below the maximum: the parser accepts it and the maximum wins (D30).
  const decide = jev({ isolation: { choice: 'worktree', probabilities: { worktree: 0.8, main: 0.2 } }, pick_model: { choice: 'swift', probabilities: { swift: 0.4945, deep: 0.5055 } },
    effort: { choice: 'max', probabilities: { low: 0, medium: 0.1, high: 0.3, xhigh: 0, max: 0.6 } } }, { device: 'dev_studio' });
  const record = await placed(value, decide);
  expect(record).toEqual({ schema: 'placement-v1', questionSet: 'p-v1', source: 'jev', fixed: [], isolation: 'worktree', runtime: 'claude', modelId: 'deep', model: 'deep-version',
    effortRequested: 'max', effortEffective: 'max', deviceId: 'dev_studio', accountId: 'claude_b',
    probabilities: { isolation: { worktree: 0.8, main: 0.2 }, pick_model: { swift: 0.4945, deep: 0.5055 }, effort: { low: 0, medium: 0.1, high: 0.3, xhigh: 0, max: 0.6 }, device: { dev_mini: 0, dev_studio: 1 } },
    eligibleModels: ['swift', 'deep'], excludedModels: [], eligibleDevices: ['dev_mini', 'dev_studio'], excludedDevices: [], jevCalls: [placementCall, placementCall], decidedAt: '2026-10-03T10:00:00.000Z' });
  expect(PlacementRecordSchema.parse(record)).toEqual(record);
  const [first, second] = decide.mock.calls.map(([request]) => request);
  expect(Object.keys(first!.questions)).toEqual(['isolation', 'pick_model', 'effort']); expect(Object.keys(second!.questions)).toEqual(['device']);
  expect(first!.model).toBe('jev-1.13.0'); expect(second!.state).toBe(first!.state);
  expect(PlacementStateSchema.parse(JSON.parse(first!.state))).toMatchObject({ schema: 'placement-state-v1', thread: { title: 'Add A', task: 'Add the A endpoint with tests.' } });
  // Effort maps to the chosen model; an exact tie goes to Jev's choice, else to the first tied option.
  const local = input({ gates: closed });
  expect(await placed(local, jev({ pick_model: 'deep', effort: 'low' }))).toMatchObject({ modelId: 'deep', effortRequested: 'low', effortEffective: 'high', probabilities: { pick_model: { swift: 0, deep: 1 } } });
  expect(await placed(local, jev({ pick_model: { choice: 'deep', probabilities: { swift: 0.5, deep: 0.5 } } }))).toMatchObject({ modelId: 'deep' });
  expect(await placed(local, jev({ pick_model: 'swift', effort: { choice: 'low', probabilities: { low: 0.33, medium: 0.335, high: 0.335, xhigh: 0, max: 0 } } })))
    .toMatchObject({ modelId: 'swift', effortRequested: 'medium', effortEffective: 'medium' });
  expect(await placed(input({ gates: closed, fixed: { modelId: 'swift' } }), jev({ effort: 'max' }))).toMatchObject({ source: 'jev', fixed: ['model'], effortRequested: 'max', effortEffective: 'xhigh', probabilities: { effort: { max: 1 } } });
});

test('every Jev failure except cancellation places with the fallback and records why', async () => {
  const kinds = ['no-key', 'auth', 'rate-limited', 'unavailable', 'timeout', 'network', 'invalid-request', 'invalid-response', 'state-too-large'] as const;
  for (const kind of kinds) {
    const record = await placed(input(), jev(new JevError(kind)));
    expect(record).toMatchObject({ source: 'fallback', isolation: 'worktree', modelId: 'swift', effortRequested: 'medium', effortEffective: 'medium', deviceId: 'dev_mini', accountId: 'codex_a',
      error: { kind, message: new JevError(kind).message }, jevCalls: [] });
    expect(record).not.toHaveProperty('probabilities');
  }
  await expect(place(input(), jev(new JevError('cancelled')))).rejects.toMatchObject({ kind: 'cancelled' });
  const stopped = new AbortController(); stopped.abort(); const idle = jev();
  await expect(place(input(), idle, stopped.signal)).rejects.toMatchObject({ kind: 'cancelled' }); expect(idle).not.toHaveBeenCalled();
  await expect(place(input(), jev(new Error('Unexpected bug.')))).rejects.toThrow('Unexpected bug.');
  // The hub-backed key source is unreachable: the client raises a plain 503 error before any request.
  const hubDown = new JevClient({ key: () => { throw Object.assign(new Error('Hub unavailable.'), { status: 503 }); }, timeoutMs: 1000 });
  expect((await placed(input(), (request, signal) => hubDown.decide(request, signal))).error).toEqual({ kind: 'credential-unavailable', message: 'The credential source is unavailable. Retry when it reconnects.' });
  const transport = vi.fn<typeof fetch>(async () => new Response('Private provider body is not evidence.', { status: 401 }));
  const rejected = new JevClient({ key: () => 'jev-test-key', timeoutMs: 1000, fetch: transport });
  const auth = await placed(input(), (request, signal) => rejected.decide(request, signal));
  expect(auth).toMatchObject({ source: 'fallback', error: { kind: 'auth', message: 'authentication failed' } }); expect(JSON.stringify(auth)).not.toContain('Private provider body');
  expect(transport).toHaveBeenCalledTimes(1);
  // The fallback keeps its own rules: the default isolation (coerced), the coordinator device, else the fewest running by name.
  expect((await placed(input({ defaultIsolation: 'main' }), jev(new JevError('timeout')))).isolation).toBe('main');
  expect((await placed(input({ defaultIsolation: 'main', project: { ...project, branchPolicy: 'external' } }), jev(new JevError('timeout')))).isolation).toBe('worktree');
  const roster = input({ settings: { ...settings, menu: [swift] }, coordinatorDeviceId: 'dev_none', devices: [device('dev_zeta', 'Zeta', { running: 1 }), device('dev_alpha', 'Alpha', { running: 1 })], statuses: ['dev_zeta', 'dev_alpha'].map((id) => status('codex_a', id)) });
  expect((await placed(roster, jev(new JevError('network')))).deviceId).toBe('dev_alpha');
});

test('a failed Call B keeps Call A in the record, and main with a model no main checkout can run falls back', async () => {
  const decide = jev({ isolation: 'main', pick_model: 'deep', effort: 'max' }, new JevError('timeout'));
  const record = await placed(input(), decide);
  expect(decide).toHaveBeenCalledTimes(2);
  expect(record).toMatchObject({ source: 'fallback', isolation: 'worktree', modelId: 'swift', effortRequested: 'medium', deviceId: 'dev_mini', error: { kind: 'timeout', message: 'request timed out' }, jevCalls: [placementCall] });
  expect(record).not.toHaveProperty('probabilities');
  // Swift runs only on Studio, whose checkout is on a feature branch: Jev's main + swift pair has no device (D250).
  const split = input({ devices: [device('dev_mini', 'Mac mini', { checkoutBranch: 'main' }), device('dev_studio', 'Studio', { checkoutBranch: 'feature' })],
    statuses: [status('codex_a', 'dev_studio'), status('claude_a', 'dev_mini'), status('claude_a', 'dev_studio')] });
  expect(candidates(split).main!.models.map((entry) => entry.model.id)).toEqual(['deep']);
  const incompatible = jev({ isolation: 'main', pick_model: 'swift', effort: 'high' });
  expect(await placed(split, incompatible)).toMatchObject({ source: 'fallback', error: PLACEMENT_INCOMPATIBLE, isolation: 'worktree', modelId: 'swift', deviceId: 'dev_studio', jevCalls: [placementCall] });
  expect(incompatible).toHaveBeenCalledTimes(1);
  expect(PLACEMENT_INCOMPATIBLE).toEqual({ kind: 'incompatible-answer', message: 'no device can run the chosen model on main' });
  expect(await placed(split, jev({ isolation: 'main', pick_model: 'deep', effort: 'high' }))).toMatchObject({ source: 'jev', isolation: 'main', modelId: 'deep', deviceId: 'dev_mini', eligibleDevices: ['dev_mini'],
    excludedDevices: [{ deviceId: 'dev_studio', reason: 'checkout is on feature, not main' }] });
});

test('placement refuses without candidates before asking Jev and passes the running-limit flag on', async () => {
  const decide = jev();
  expect(await place(input({ statuses: [] }), decide)).toEqual({ kind: 'refused', message: 'No device can run any enabled model: Mac mini: Codex needs login; Mac mini: Claude needs login; Studio: Codex needs login; Studio: Claude needs login.' });
  expect(await place(input({ settings: { ...settings, menu: [{ ...swift, enabled: false }] } }), decide)).toEqual({ kind: 'refused', message: NO_THREAD_MODEL });
  expect(decide).not.toHaveBeenCalled();
  const full = input({ gates: closed, devices: [device('dev_mini', 'Mac mini', { running: 4 })] });
  expect(await place(full, jev({}))).toMatchObject({ kind: 'placed', atLimit: true, record: { deviceId: 'dev_mini' } });
  expect(await place(input({ gates: closed }), jev({}))).toMatchObject({ kind: 'placed', atLimit: false });
});

test('the placement packet is redacted before the task is shortened and carries the newest override sentences', () => {
  const secret = 'zq9-private-token-77'; const redactor = new SecretRedactor(); redactor.add(secret);
  const overrides: PlacementPacketInput['overrides'] = [
    { title: 'Add A', mode: 'next-turn', changes: [{ field: 'effort', from: 'high', to: 'low' }], at: '2026-10-03T09:00:00Z' },
    { title: 'Add B', mode: 'restart', changes: [{ field: 'model', from: 'deep', to: 'swift' }, { field: 'device', from: 'dev_mini', to: 'dev_studio' }], at: '2026-10-03T09:30:00Z' }];
  const active = { title: 'Fix login', isolation: 'worktree' as const, device: 'Mac mini', model: 'Deep', effort: 'high' as const, reservedPaths: ['src/login.ts'] };
  // The secret straddles the cut: shortening first would leave its first characters in the packet.
  const build = (over: Partial<PlacementPacketInput> = {}, value = input()) => buildPlacementState({ ...value, packet: { ...packet, ...over }, redactor });
  const { state, approximateTokens: tokens } = build({ title: `Add A ${secret}`, task: `${'x'.repeat(5975)}${secret}${'y'.repeat(100)}`, note: `  Use the ${secret} with Bearer abc123 now.  `, activeThreads: [active], overrides });
  expect(state).not.toContain(secret.slice(0, 7)); expect(state).not.toContain('abc123');
  expect(JSON.parse(state)).toEqual({ schema: 'placement-state-v1',
    rules: { routingProfile: settings.routingProfile, effortGuide: settings.effortGuide,
      recentOverrides: ["model changed from deep to swift for 'Add B' (restart)", "device changed from dev_mini to dev_studio for 'Add B' (restart)", "effort changed from high to low for 'Add A' (next-turn)"] },
    project: { name: 'App', defaultIsolation: 'worktree' },
    thread: { title: 'Add A [redacted]', task: `${'x'.repeat(5975)}[redact${TASK_SHORTENED}`, coordinatorNote: 'Use the [redacted] with Bearer [redacted] now.' }, activeThreads: [active] });
  expect(TASK_SHORTENED).toBe('\n[Task shortened.]'); expect(JSON.parse(state).thread.task).toHaveLength(6000);
  expect(tokens).toBe(approximateTokens(state)); expect(tokens).toBeLessThanOrEqual(12_000);
  expect(overrideSentence({ field: 'effort', from: 'high', to: 'low' }, 'Add A', 'next-turn')).toBe("effort changed from high to low for 'Add A' (next-turn)");
  const parsed = (over: Partial<PlacementPacketInput> = {}, value = input()) => PlacementStateSchema.parse(JSON.parse(build(over, value).state));
  expect(parsed({ task: 'y'.repeat(6000), note: ' ' })).toMatchObject({ thread: { task: 'y'.repeat(6000) } }); expect(parsed({ note: ' ' }).thread).not.toHaveProperty('coordinatorNote');
  expect(parsed({ note: 'n'.repeat(700) }).thread.coordinatorNote).toBe('n'.repeat(600));
  // The newest 8 overrides, newest first; the newest 50 active threads in their order.
  const many = Array.from({ length: 10 }, (_, index) => ({ title: `T${index}`, mode: 'next-turn' as const, changes: [{ field: 'effort' as const, from: 'low', to: 'high' }], at: new Date(now + index * 60_000).toISOString() }));
  expect(parsed({ overrides: [...many].reverse() }).rules.recentOverrides).toEqual(many.slice(2).reverse().map((entry) => `effort changed from low to high for '${entry.title}' (next-turn)`));
  const threads = Array.from({ length: 52 }, (_, index) => ({ ...active, title: `Thread ${index}` }));
  expect(parsed({ activeThreads: threads }).activeThreads.map((thread) => thread.title)).toEqual(threads.slice(2).map((thread) => thread.title));
  // The default isolation is the effective one: main only when main can be offered.
  expect(parsed({}, input({ defaultIsolation: 'main' })).project.defaultIsolation).toBe('main');
  expect(parsed({}, input({ defaultIsolation: 'main', gates: closed })).project.defaultIsolation).toBe('worktree');
  expect(parsed({}, input({ defaultIsolation: 'main', project: { ...project, branchPolicy: 'external' } })).project.defaultIsolation).toBe('worktree');
});

test('an oversized packet drops reserved paths, then threads, then overrides, oldest first, and falls back when still too large', async () => {
  const build = (over: Partial<PlacementPacketInput>, value = input()) => {
    const result = buildPlacementState({ ...value, packet: { ...packet, ...over }, redactor: noSecrets });
    expect(result.approximateTokens).toBeLessThanOrEqual(12_000); return PlacementStateSchema.parse(JSON.parse(result.state));
  };
  const thread = (title: string, reservedPaths: string[] = []) => ({ title, isolation: 'worktree' as const, device: 'Mac mini', model: 'Deep', effort: 'high' as const, reservedPaths });
  const paths = (prefix: string) => Array.from({ length: 10 }, (_, index) => `${prefix}/${'p'.repeat(1500)}/${index}`);
  expect(build({ activeThreads: [thread('Old', paths('old')), thread('Mid', paths('mid')), thread('New', paths('new'))] }).activeThreads.map((entry) => [entry.title, entry.reservedPaths.length]))
    .toEqual([['Old', 0], ['Mid', 10], ['New', 10]]);
  expect(build({ activeThreads: ['A', 'B', 'C', 'D'].map((name) => thread(`${name}${'t'.repeat(10_000)}`, [`${name}.ts`])) }).activeThreads.map((entry) => [entry.title[0], entry.reservedPaths]))
    .toEqual([['B', []], ['C', []], ['D', []]]);
  const overrides = Array.from({ length: 8 }, (_, index) => ({ title: `${index}${'o'.repeat(5000)}`, mode: 'restart' as const, changes: [{ field: 'model' as const, from: 'deep', to: 'swift' }], at: new Date(now + index * 60_000).toISOString() }));
  const kept = build({ overrides }).rules.recentOverrides;
  expect(kept.length).toBeGreaterThan(0); expect(kept.length).toBeLessThan(8);
  expect(kept).toEqual([...overrides].reverse().slice(0, kept.length).map((entry) => overrideSentence(entry.changes[0]!, entry.title, entry.mode)));
  // Rules and the thread itself are never dropped: the packet is too large and placement falls back without asking Jev.
  const huge = input({ settings: { ...settings, menu: [swift, deep], routingProfile: 'r'.repeat(40_000) } });
  expect(() => buildPlacementState({ ...huge, packet, redactor: noSecrets })).toThrow('decision context exceeds the size limit');
  const decide = jev();
  expect(await placed(huge, decide)).toMatchObject({ source: 'fallback', error: { kind: 'state-too-large', message: 'decision context exceeds the size limit' }, jevCalls: [] });
  expect(decide).not.toHaveBeenCalled();
  // The packet is built only when a question needs it.
  expect(await placed(input({ ...huge, gates: closed, settings: { ...huge.settings, menu: [deep] }, fixed: { effort: 'high' } }), decide)).toMatchObject({ source: 'fixed' });
});
