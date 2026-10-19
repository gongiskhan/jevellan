import { expect, test } from 'vitest';
import { ProjectWorkSettingsRequestSchema, ProjectWorkSettingsSchema, StoredProjectWorkSettingsSchema, VaultProjectSchema, defaultProjectWorkSettings } from '../packages/core/dist/index.js';

const legacy = { schema: 'project-work-settings-v1', projectId: 'parity', revision: 7, defaultIsolation: 'main',
  coordinator: { runtimeId: 'claude', accountId: 'chosen', modelId: 'deep', effort: 'high' }, setupCommand: 'npm ci',
  maxRunningThreads: 9, maxRunningPerDevice: 3, threadTurnCap: 51 };
const nightlyWindow = { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' };

test.each([1, 2, 3])('settings v%s migrate to v4 without losing owner choices', version => {
  const before = { ...legacy, schema: `project-work-settings-v${version}`, ...(version > 1 ? { threadRules: 'Keep these instructions.', nightlyWindow } : {}),
    ...(version === 2 ? { coordinatorReview: false } : {}), ...(version === 3 ? { autoMerge: true, requiredChecks: ['result'], perDeviceLimits: { madrid: 8 } } : {}) };
  const after = StoredProjectWorkSettingsSchema.parse(before);
  const { defaultIsolation: _retired, ...retained } = legacy; void _retired;
  expect(after).toMatchObject({ ...retained, schema: 'project-work-settings-v5', instructions: version > 1 ? 'Keep these instructions.' : '', status: 'active', startMode: 'start', maxNewThreadsPerDay: 100 });
  expect(after).not.toHaveProperty('threadRules'); expect(after).not.toHaveProperty('coordinatorReview');
  if (version > 1) expect(after.nightlyWindow).toEqual(nightlyWindow);
  if (version === 3) expect(after).toMatchObject({ autoLand: true, perDeviceLimits: { madrid: 8 } });
  expect(StoredProjectWorkSettingsSchema.parse(after)).toEqual(after);
});

test('v4 defaults, optional request fields and sixteen-thousand-character instructions round trip', () => {
  const value = defaultProjectWorkSettings('parity');
  expect(value).toMatchObject({ schema: 'project-work-settings-v5', placement: { allowedModelIds: null, minEffort: null, guidance: '' },
    prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 3 }, environment: { variables: [], secrets: [], copyFiles: [] }, notifications: 'standard' });
  expect(ProjectWorkSettingsSchema.parse({ ...value, instructions: 'i'.repeat(16000) })).toHaveProperty('instructions', 'i'.repeat(16000));
  expect(ProjectWorkSettingsSchema.safeParse({ ...value, instructions: 'i'.repeat(16001) }).success).toBe(false);
  const request = ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: 7,
    settings: { delivery: 'land', coordinator: legacy.coordinator, setupCommand: null, maxRunningThreads: 2, maxRunningPerDevice: 2, threadTurnCap: 20 } });
  for (const field of ['status', 'instructions', 'startMode', 'placement', 'prAutoFix', 'environment', 'notifications', 'maxNewThreadsPerDay']) expect(request.settings).not.toHaveProperty(field);
});

test.each(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'CODEX_HOME', 'JEVELLAN_TOKEN', 'GIT_CONFIG'])('reserved environment name %s is refused precisely', name => {
  const parsed = ProjectWorkSettingsSchema.safeParse({ ...defaultProjectWorkSettings('parity'), environment: { variables: [{ name, value: 'value' }], secrets: [], copyFiles: [] } });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain(`${name} is reserved for Jevellan and the runtimes.`);
});

test.each(['/tmp/a', '../a', 'a/../b'])('environment copy path %s stays inside the project', path => {
  const parsed = ProjectWorkSettingsSchema.safeParse({ ...defaultProjectWorkSettings('parity'), environment: { variables: [], secrets: [], copyFiles: [path] } });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain('Use a path inside the project, without ..');
});

test('environment names are unique across variables and secret names', () => {
  const value = { ...defaultProjectWorkSettings('parity'), environment: { variables: [{ name: 'SANDBOX_DATA_DIR', value: '/tmp/data' }], secrets: ['SANDBOX_DATA_DIR'], copyFiles: ['.env.local'] } };
  const parsed = ProjectWorkSettingsSchema.safeParse(value); expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain('Each name can appear once.');
});

test('vault v1 restores to v2 with instructions and portable defaults', () => {
  const old = { schema: 'vault-project-v1', name: 'Fixture', origin: 'https://github.com/fixture/repo', testCommand: 'npm test', setupCommand: 'npm ci', gitPolicy: 'main',
    work: { defaultIsolation: 'worktree', allowMainIsolation: false, maxRunningThreads: 6, maxRunningPerDevice: 4, threadTurnCap: 30,
      threadRules: 'Keep the old instructions.', riskyAreas: 'data', requiredChecks: ['result'], autoMerge: false, nightlyWindow,
      refill: { enabled: true, minIntervalMinutes: 30 }, memory: { mode: 'hub', capture: true, dreamMode: 'apply' },
      sessionCheckpoints: { enabled: false, checkpointMinTokens: 40000 }, compactAtPercent: 70, coordinator: { runtimeId: 'claude', modelId: 'deep', effort: 'high' } },
    goals: [], jobs: [], dailies: [] };
  const restored = VaultProjectSchema.parse(old);
  expect(restored).toMatchObject({ schema: 'vault-project-v3', work: { instructions: 'Keep the old instructions.', startMode: 'start', maxNewThreadsPerDay: 100 } });
  expect(restored.work).not.toHaveProperty('threadRules'); expect(restored.work).not.toHaveProperty('status');
  expect(VaultProjectSchema.parse(restored)).toEqual(restored);
});
