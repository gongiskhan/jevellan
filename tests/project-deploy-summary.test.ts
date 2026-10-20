import { afterEach, expect, test, vi } from 'vitest';
import { ProjectDeployBaselineSchema, ProjectDeploySchema, ProjectHealthRunSchema, type ProjectDeploy } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const at = '2026-10-19T12:00:00.000Z', a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const deploy = (patch: Partial<ProjectDeploy> = {}) => ProjectDeploySchema.parse({ schema: 'project-deploy-v1', id: 'summary_deploy', projectId: 'project', revision: 0,
  state: 'deployed', commit: b, previousCommit: a, threads: [], suite: { commit: b, conclusion: 'passed' }, health: { before: [], after: [] }, checks: [],
  rollbackAvailable: true, decisionId: 'summary_decision', timezone: 'Europe/Lisbon', createdAt: at, updatedAt: at, deployedAt: at,
  // A finished fixture includes its delivery/desktop receipts; recovery must not race the revision under test.
  notified: ['deploy-delivered', 'rollback-delivered'], desktop: { state: 'not-needed' }, ...patch });
async function prepare() { const f = fixture = await projectFixture(); await f.app.projectWork.coordinators.ensureAssigned('project'); return f; }
async function baseline(f: ProjectFixture, commit: string, updatedAt: string) {
  await f.app.projectHub.putDeployBaseline(ProjectDeployBaselineSchema.parse({ schema: 'project-deploy-baseline-v1', id: 'project', projectId: 'project', revision: 0,
    commit, rollbackAvailable: true, migrationPaths: [], updatedAt }), 0);
}
async function summary(f: ProjectFixture) {
  const response = await f.request('/api/projects/project/deploy-summary'); expect(response.status).toBe(200); return response.json();
}

test('deploy summary renders a recorded baseline without inventing a Jevellan release or rollback action', async () => {
  const f = await prepare(); await baseline(f, a, at);
  const view = await summary(f);
  expect(view).toMatchObject({ schema: 'project-deploy-summary-v1', projectId: 'project', current: { source: 'baseline', commit: a, at }, healthLines: [], desktopLine: null, rollback: null });
  expect(view.current.label).toContain('Recorded deploy baseline: aaaaaaa');
  const tool = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'deploy', args: { project: 'project' } });
  expect(tool).toMatchObject({ ok: true, data: view });
});

test('deploy summary shares health copy and revision-stable rollback confirmation with the jobs tool', async () => {
  const f = await prepare();
  const row = (await f.app.projectHub.putDeploy(deploy({
    checks: [{ id: 'app', name: 'Fixture app', enabled: true, steps: [{ name: 'Readiness', method: 'GET', url: 'http://127.0.0.1:9000', expectStatus: [200], headers: {}, body: null, expectBody: null, timeoutMs: 1000 }] }],
    messageHealth: [ProjectHealthRunSchema.parse({ schema: 'project-health-run-v1', id: 'summary_health', projectId: 'project', checkId: 'app', at, trigger: 'manual',
      passed: false, steps: [{ name: 'Readiness', passed: false, ms: 1, reason: 'Fixture response unavailable' }] })],
    desktop: { state: 'skipped', reason: 'Fixture signing is not configured' },
  }), 0)).document;
  const view = await summary(f);
  expect(view).toMatchObject({ current: { source: 'deploy', commit: b, label: 'Last deploy: bbbbbbb, 13:00' },
    healthLines: ['Fixture app: failed at 13:00: Readiness: Fixture response unavailable'], desktopLine: 'Desktop build skipped: Fixture signing is not configured',
    rollback: { deployId: row.id, enabled: true, refusal: null, label: 'Roll back to aaaaaaa', confirmation: 'Roll back production to aaaaaaa?',
      path: `/api/projects/project/deploys/${row.id}/rollback`, body: { schema: 'project-deploy-rollback-request-v1', expectedRevision: row.revision, clientRequestId: `rollback_${row.id}_${row.revision}` } } });
  const tool = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'deploy', args: { project: 'project' } });
  expect(tool).toMatchObject({ ok: true, data: view });
  if (tool.ok) expect(tool.text).toContain('Last deploy: bbbbbbb, 13:00 · health after: not run · rollback to aaaaaaa: available');
  const confirmation = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'rollback', args: { project: 'project' } });
  expect(confirmation).toMatchObject({ ok: true }); if (confirmation.ok) expect(confirmation.text).toContain('Rolling production back to aaaaaaa replaces bbbbbbb');
  expect((await f.app.projectWork.tasks.list('project'))).toHaveLength(0);
});

test.each(['newer baseline', 'failed rollback', 'uncertain release'] as const)('deploy summary never offers stale rollback after %s', async mode => {
  const f = await prepare();
  const row = (await f.app.projectHub.putDeploy(deploy({ ...(mode === 'uncertain release' ? { releaseUncertain: true } : {}), ...(mode === 'failed rollback' ? {
    rollback: { at: '2026-10-19T12:02:00.000Z', reason: 'owner', toCommit: a, jobRunId: 'summary_rollback', result: 'failed', failure: 'Fixture rollback failed' },
  } : {}) }), 0)).document;
  if (mode === 'newer baseline') await baseline(f, c, '2026-10-19T12:03:00.000Z');
  const view = await summary(f);
  expect(view.current.commit).toBe(mode === 'newer baseline' ? c : null); expect(view.rollback?.enabled ?? false).toBe(false);
  await expect(f.app.projectWork.deploys.rollback('project', row.id, row.revision)).rejects.toThrow('Only the current latest deploy can be rolled back.');
  expect((await f.app.projectWork.tasks.list('project'))).toHaveLength(0);
});

test.each(['UI first', 'tool first'] as const)('rollback clients share one canonical queued effect and accept its receipt retry: %s', async first => {
  const f = await prepare();
  const job = await f.app.projectWork.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'summary_job', name: 'Fixture rollback', enabled: true,
    goalId: null, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  const current = (await f.app.projectWork.settingsView('project')).settings;
  const { schema: _s, projectId: _p, revision, ...fields } = current; void _s; void _p;
  await f.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...fields, deploy: { ...fields.deploy, jobId: job.id } } });
  await f.app.projectHub.putDeploy(deploy(), 0);
  const plan = (await summary(f)).rollback;
  const ui = async () => { const response = await f.request(plan.path, 'POST', plan.body); expect(response.status).toBe(202); return response.json(); };
  const tool = async () => { const result = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'rollback', args: { project: 'project', confirm: true } }); expect(result, result.ok ? 'accepted' : result.error.text).toMatchObject({ ok: true }); };
  if (first === 'UI first') { await ui(); await tool(); } else { await tool(); await ui(); }
  const rows = await f.app.projectWork.tasks.list('project'); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ jobId: job.id, deployment: { mode: 'rollback', commit: a, commandCommit: b } });
  expect((await summary(f)).rollback).toMatchObject({ enabled: false, pending: true });
});

test('rollback availability and canonical guards agree on missing images and overlapping work', async () => {
  const f = await prepare(); let row = (await f.app.projectHub.putDeploy(deploy({ rollbackAvailable: false }), 0)).document;
  expect((await summary(f)).rollback).toMatchObject({ enabled: false, refusal: 'A rollback image is not available.' });
  await expect(f.app.projectWork.deploys.rollback('project', row.id, row.revision)).rejects.toThrow('A rollback image is not available.');
  row = (await f.app.projectHub.putDeploy({ ...row, rollbackAvailable: true }, row.revision)).document;
  await f.app.projectHub.putDeploy(deploy({ id: 'summary_other', state: 'running', deployedAt: undefined, commit: c, decisionId: 'summary_other_decision' }), 0);
  const view = await summary(f); expect(view.rollback.enabled).toBe(false);
  await expect(f.app.projectWork.deploys.rollback('project', row.id, row.revision)).rejects.toThrow(view.rollback.refusal);
  expect(await f.app.projectWork.tasks.list('project')).toHaveLength(0);
});

test('tool rollback keeps member coordinator ownership through the same owner route as the UI', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f); member.fake.capabilities.readOnlyEnforced = true;
  const job = await f.app.projectWork.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'member_summary_job', name: 'Fixture rollback', enabled: true,
    goalId: null, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  const current = (await f.app.projectWork.settingsView('project')).settings;
  const { schema: _s, projectId: _p, revision, ...fields } = current; void _s; void _p;
  await f.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...fields, deploy: { ...fields.deploy, jobId: job.id } } });
  await f.app.projectWork.prepareDailyWork('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await member.request('/api/projects/project/coordinator/move', 'POST', { schema: 'empty-request-v1' })).status).toBe(200); await member.app.projectWork.idle();
  await member.app.projectHub.putDeploy(deploy(), 0);
  const hubRollback = vi.spyOn(f.app.projectWork.deploys, 'rollback'), memberRollback = vi.spyOn(member.app.projectWork.deploys, 'rollback');
  const plan = (await summary(f)).rollback;
  expect((await f.request(plan.path, 'POST', plan.body)).status).toBe(202);
  expect(await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'rollback', args: { project: 'project', confirm: true } })).toMatchObject({ ok: true });
  expect(hubRollback).not.toHaveBeenCalled(); expect(memberRollback).toHaveBeenCalledTimes(2);
  expect(await f.app.projectWork.tasks.list('project')).toHaveLength(1);
});
