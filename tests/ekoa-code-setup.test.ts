import { afterEach, expect, test } from 'vitest';
import { EkoaCodeSetupReceiptSchema, ProjectSchema, type ProjectGoal } from '../packages/core/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EKOA_FAST_CHECKS, EKOA_GOALS, EKOA_RISKY_AREAS, EKOA_THREAD_RULES, restoreFromVault, vaultDefinition } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('owner setup installs the exact amendment preset once, preserving later goal/settings edits', async () => {
  const f = fixture = await projectFixture({ menu: [{ id: 'discovered_opus', runtime: 'claude', model: 'reported-native-model', label: 'Claude Opus 5.5', description: 'Fixture model discovery', efforts: ['high'], enabled: true }] });
  const current = await f.app.state.projects.get('project');
  await f.app.state.projects.put(ProjectSchema.parse({ ...current!.project, name: 'Ekoa Code', remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git', githubTokenScope: 'project', allowedDevices: [f.app.device.deviceId], testCommand: EKOA_FAST_CHECKS }), current!.revision);
  const request = { schema: 'ekoa-code-setup-request-v1', modelId: 'discovered_opus', workflowPull: 208 };
  expect((await fetch(`${f.base}/api/projects/project/ekoa-code-setup`, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
  const receipt = await f.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request); expect(receipt.completed).toBe(true);
  const work = f.app.projectWork, goals = await work.goals.list('project'); expect(goals).toHaveLength(6);
  for (const expected of EKOA_GOALS) expect(goals.find(goal => goal.name === expected.name)).toMatchObject({ ...expected, autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2 });
  expect((await work.settingsView('project')).settings).toMatchObject({ autoMerge: false, requiredChecks: ['result'], riskyAreas: EKOA_RISKY_AREAS, instructions: EKOA_THREAD_RULES, setupCommand: 'npm ci', allowMainIsolation: false, maxRunningThreads: 8, maxRunningPerDevice: 6, nightlyWindow: { time: '01:00', timezone: 'Europe/Lisbon', enabled: true } });
  const dailies = await work.daily.dailies('project'); expect(dailies.filter(row => row.target.kind !== 'memory-dream').map(row => row.name)).toEqual(['Legal programme night', 'Full suite', 'Review since last', 'Latest Anthropic models']); expect(dailies.at(-1)?.enabled).toBe(false);
  expect(dailies.filter(row => row.target.kind === 'memory-dream')).toHaveLength(1); expect(dailies.find(row => row.target.kind === 'memory-dream')?.enabled).toBe(true);
  expect(receipt.presetVersion).toBe(2); expect((await f.app.state.projects.get('project'))!.project.memory.mode).toBe('hub');
  const jobs = await work.daily.jobs('project'), full = jobs.find(job => job.name === 'Full suite')!;
  expect(full.run).toMatchObject({ kind: 'command', command: 'node scripts/jevellan/full-suite.mjs', needs: ['linux'], cwd: 'workspace' }); expect(jobs.find(job => job.name === 'Deploy')).toBeUndefined();
  const goal = goals[0]!; await work.goals.update('project', goal.id, { schema: 'goal-update-request-v1', expectedRevision: goal.revision, health: 'Owner correction' });
  const before = (await work.settingsView('project')).settings, { schema: _schema, projectId: _projectId, revision, ...fields } = before; void _schema; void _projectId;
  await work.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...fields, riskyAreas: 'Owner correction' } });
  await f.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request); expect(await work.goals.list('project')).toHaveLength(6); expect(await work.daily.jobs('project')).toHaveLength(2); expect((await work.goals.read('project', goal.id)).health).toBe('Owner correction'); expect((await work.settingsView('project')).settings.riskyAreas).toBe('Owner correction');
});
test('reapplying the earlier preset upgrades only shared memory and the independent dream', async () => {
  const f = fixture = await projectFixture({ menu: [{ id: 'discovered_opus', runtime: 'claude', model: 'reported-native-model', label: 'Claude Opus 5.5', description: 'Fixture model discovery', efforts: ['high'], enabled: true }] });
  const current = (await f.app.state.projects.get('project'))!;
  await f.app.state.projects.put(ProjectSchema.parse({ ...current.project, name: 'Ekoa Code', remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git', githubTokenScope: 'project', allowedDevices: [f.app.device.deviceId], testCommand: EKOA_FAST_CHECKS }), current.revision);
  const request = { schema: 'ekoa-code-setup-request-v1', modelId: 'discovered_opus', workflowPull: 208 };
  await f.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request);
  const work = f.app.projectWork, file = join(work.paths.project('project'), 'ekoa-code-setup.json'), legacy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete legacy.presetVersion; writeFileSync(file, JSON.stringify(legacy));
  const old = (await work.settingsView('project')).settings, { schema: _schema, projectId: _project, revision, ...settings } = old; void _schema; void _project;
  await work.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, riskyAreas: 'Owner correction', autoMerge: true, memory: { mode: 'device', capture: false, dreamMode: 'suggest' } } });
  const goals = await work.goals.list('project'), jobs = await work.daily.jobs('project');
  const result = await f.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request);
  expect(result.presetVersion).toBe(2); expect(result.settings).toMatchObject({ riskyAreas: 'Owner correction', autoMerge: true, memory: { mode: 'hub', capture: true, dreamMode: 'apply' } });
  expect(await work.goals.list('project')).toEqual(goals); expect(await work.daily.jobs('project')).toEqual(jobs); expect((await work.daily.dailies('project')).filter(row => row.target.kind === 'memory-dream')).toHaveLength(1);
});

test('restore from the vault and the preset, in either order, never duplicate goals, jobs or dailies', { timeout: 120_000 }, async () => {
  const menu = [{ id: 'discovered_opus', runtime: 'claude', model: 'reported-native-model', label: 'Claude Opus 5.5', description: 'Fixture model discovery', efforts: ['high' as const], enabled: true }];
  const request = { schema: 'ekoa-code-setup-request-v1', modelId: 'discovered_opus', workflowPull: 208 };
  const ekoa = async (f: ProjectFixture) => {
    const current = await f.app.state.projects.get('project');
    await f.app.state.projects.put(ProjectSchema.parse({ ...current!.project, name: 'Ekoa Code', remoteUrl: 'https://github.com/gongiskhan/ekoa-code.git', githubTokenScope: 'project', allowedDevices: [f.app.device.deviceId], testCommand: EKOA_FAST_CHECKS }), current!.revision);
  };
  const counts = async (f: ProjectFixture) => { const work = f.app.projectWork; return { goals: (await work.goals.list('project')).length, jobs: (await work.daily.jobs('project')).length, dailies: (await work.daily.dailies('project')).length }; };
  const definition = async (f: ProjectFixture) => {
    const work = f.app.projectWork, project = (await f.app.state.projects.get('project'))!.project;
    return vaultDefinition(project, await work.admission.settings('project'), await work.goals.list('project'), await work.daily.jobs('project'), await work.daily.dailies('project'));
  };
  // Preset first, then restore its own definition.
  const first = fixture = await projectFixture({ menu }); await ekoa(first);
  await first.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request);
  const exported = await definition(first), before = await counts(first);
  await restoreFromVault(first.app.projectWork, 'project', 'gongiskhan__ekoa-code', exported, null);
  expect(await counts(first)).toEqual(before); expect(before).toMatchObject({ goals: 6, jobs: 2 });
  await first.close(); fixture = undefined;
  // Restore first on a fresh hub, then the preset.
  const second = fixture = await projectFixture({ menu }); await ekoa(second);
  await restoreFromVault(second.app.projectWork, 'project', 'gongiskhan__ekoa-code', exported, 'Notebook.\n');
  expect(await counts(second)).toEqual(before);
  await second.json('/api/projects/project/ekoa-code-setup', EkoaCodeSetupReceiptSchema, 'POST', request);
  expect(await counts(second)).toEqual(before);
});

test('the night migration preserves legacy goal and daily ids and retires the old deploy', async () => {
  const { configureEkoaNights } = await import('../packages/projects/dist/index.js');
  const { ProjectDailySchema, ProjectJobSchema } = await import('../packages/core/dist/index.js');
  const f = fixture = await projectFixture(), work = f.app.projectWork; await work.prepareDailyWork('project');
  const goals: ProjectGoal[] = [];
  for (const [index, definition] of EKOA_GOALS.entries()) goals.push((await work.goals.create('project', { schema: 'goal-create-request-v1', clientRequestId: `legacy_goal_${index}`, ...definition, name: index === 0 ? 'Hardening through automated tests' : definition.name, state: index === 1 ? 'active' : index === 2 ? 'paused' : definition.state })).goal);
  const at = work.tasks.at();
  f.app.hub.put('project-jobs', 'old_workflow', ProjectJobSchema, { schema: 'project-job-v1', id: 'old_workflow', projectId: 'project', revision: 1, name: 'Historical full suite', goalId: goals[0]!.id, enabled: true, gate: null, run: { kind: 'github-workflow', workflow: 'night.yml', mode: 'watch', timeoutMinutes: 5 }, createdAt: at, updatedAt: at }, 0);
  for (const [id, name, goalId, order, target] of [['old_full', 'Full suite with the expensive tests', goals[0]!.id, 2, { kind: 'job', jobId: 'old_workflow' }], ['old_deploy', 'Deploy', null, 3, { kind: 'job', jobId: 'old_workflow' }], ['old_review', 'Review since last', goals[1]!.id, 0, { kind: 'review-since-last' }]] as const) {
    f.app.hub.put('project-dailies', id, ProjectDailySchema, ProjectDailySchema.parse({ schema: 'project-daily-v1', id, projectId: 'project', revision: 1, name, goalId, order, target, enabled: true, createdAt: at, updatedAt: at }), 0);
  }
  await configureEkoaNights(work, 'project');
  const after = await work.goals.list('project'); expect(after).toHaveLength(6); expect(after.find(goal => goal.name === 'Resilience')?.id).toBe(goals[0]!.id); expect(after.find(goal => goal.id === goals[1]!.id)?.state).toBe('done'); expect(after.find(goal => goal.id === goals[2]!.id)?.state).toBe('active'); expect(after.find(goal => goal.name === 'Security')?.state).toBe('paused');
  const daily = await work.daily.dailies('project'); expect(daily.find(row => row.id === 'old_review')).toMatchObject({ goalId: goals[0]!.id, order: 3 }); expect(daily.find(row => row.id === 'old_full')).toMatchObject({ name: 'Full suite', order: 2, enabled: true }); expect(daily.find(row => row.id === 'old_deploy')?.enabled).toBe(false); expect((await work.daily.jobs('project')).find(row => row.id === 'old_workflow')?.enabled).toBe(false);
  const ids = daily.map(row => row.id).sort(); await configureEkoaNights(work, 'project'); expect((await work.daily.dailies('project')).map(row => row.id).sort()).toEqual(ids);
});
