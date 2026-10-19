import { afterEach, expect, test } from 'vitest';
import { ProjectJobSchema, ProjectJobRunSchema, ProjectWorkTaskSchema } from '../packages/core/dist/index.js';
import { ProjectDailyWork } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const workflow = { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5 };
test('new workflow jobs and explicit runs are refused while old receipts remain readable without Actions requests', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork; await work.prepareDailyWork('project');
  const input = { schema: 'job-create-request-v1', clientRequestId: 'retired', name: 'Old nightly job', goalId: null, enabled: true, gate: null, run: workflow };
  await expect(work.daily.createJob('project', input)).rejects.toThrow('GitHub workflow jobs retired on 19 October. Use a command job.');
  const at = work.tasks.at(), job = (await f.app.projectHub.putJob(ProjectJobSchema.parse({ name: input.name, run: input.run, goalId: null, gate: null, enabled: true, schema: 'project-job-v1', id: 'old_job', projectId: 'project', revision: 0, createdAt: at, updatedAt: at }), 0)).document;
  await expect(work.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'retired_run' })).rejects.toThrow('retired');
  const quiet = new ProjectDailyWork({ ...work.daily.o, changed: () => undefined });
  const task = await work.tasks.save(ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: 'old_task', projectId: 'project', revision: 0, title: 'Old job', brief: 'Historical job', kind: 'job', type: 'ops', goalId: null, source: 'daily', state: 'active', rank: 'a', ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: job.id, threadId: null, jobRunId: 'old_run', fixed: {}, projectDay: '2026-10-19', createdAt: at, updatedAt: at }));
  await f.app.projectHub.putJobRun(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: 'old_run', projectId: 'project', revision: 0, taskId: task.id, jobId: job.id, commit: f.git(f.checkout, 'rev-parse', 'HEAD'), deviceId: f.app.device.deviceId, projectDay: task.projectDay, startedAt: at, watchAfter: at, conclusion: null, summary: '', logTail: 'Earlier output', spec: workflow, phase: 'watching', baseBranch: 'main' }), 0);
  await work.jobs.sweep('project');
  expect((await quiet.view('project')).runs[0]).toMatchObject({ conclusion: 'skipped', summary: 'GitHub workflow (retired 19 October)', logTail: 'Earlier output' });
  const count = f.github.requests.length; await f.restart(); await f.app.projectWork.jobs.sweep('project');
  expect((await f.app.projectWork.daily.view('project')).runs[0]?.summary).toContain('retired 19 October');
  expect(f.github.requests.slice(count).some(row => row.path.includes('/actions/'))).toBe(false);
});
test('weekly items follow the configured order; the memory dream fences command execution', async () => {
  let now = Date.parse('2026-10-18T23:59:00Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  await work.prepareDailyWork('project'); const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }, settings.revision);
  const daily = new ProjectDailyWork({ ...work.daily.o, changed: () => undefined });
  const legal = await daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'legal_job', name: 'Legal', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  const full = await daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'full_job', name: 'Full suite', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  for (const [name, order, target, days] of [
    ['Memory', 0, { kind: 'memory-dream' }, undefined], ['Legal', 1, { kind: 'job', jobId: legal.id }, undefined], ['Full suite', 2, { kind: 'job', jobId: full.id }, undefined], ['Review', 3, { kind: 'review-since-last' }, undefined], ['Weekly Monday', 4, { kind: 'session', title: 'Models', brief: 'Check models', type: 'ops' }, ['mon']], ['Weekly Tuesday', 5, { kind: 'session', title: 'Other', brief: 'Check another day', type: 'ops' }, ['tue']],
  ] as const) await daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: `daily_${order}`, name, goalId: null, order, enabled: true, target, ...(days ? { days } : {}) });
  now += 60_000; await daily.sweep('project'); const window = (await daily.window('project'))!;
  expect(window.plans.map(row => row.title)).toEqual(['Legal', 'Full suite', 'Review', 'Models']);
  expect(window.memoryDreamPending).toBe(true); expect(await daily.eligible(window.plans[0]!, await work.tasks.list('project'))).toBe(false);
  await daily.memoryFinished('project', window.id, 'Memory dream: completed', false);
  expect(await daily.eligible(window.plans[0]!, await work.tasks.list('project'))).toBe(true);
  expect(await daily.eligible(window.plans[1]!, await work.tasks.list('project'))).toBe(false);
  const weekly = (await daily.dailies('project')).find(row => row.name === 'Weekly Monday')!;
  const cleared = await daily.updateDaily('project', weekly.id, { schema: 'daily-update-request-v1', expectedRevision: weekly.revision, name: weekly.name, goalId: weekly.goalId, order: weekly.order, enabled: weekly.enabled, target: weekly.target });
  expect(cleared.days).toBeUndefined(); expect((await daily.window('project'))?.plans).toEqual(window.plans);
});
test('failed suite findings create goal-linked fix tasks once and preserve their report', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork; await work.prepareDailyWork('project');
  const goal = (await work.goals.create('project', { schema: 'goal-create-request-v1', clientRequestId: 'resilience', name: 'Resilience', state: 'active', motivation: 'Catch regressions', health: 'Suite green', autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2 })).goal;
  const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'suite_findings', name: 'Full suite', goalId: goal.id, enabled: true, gate: null, run: { kind: 'command', command: `printf '%s' '{"schema":"project-job-findings-v1","findings":[{"title":"Fix failing suite","brief":"Repair the reproduced failure and add its regression."}]}' > project-job-findings.json; exit 1`, cwd: 'workspace', timeoutMinutes: 1 } });
  const receipt = await work.daily.runJob('project', job.id, { schema: 'project-run-request-v1', clientRequestId: 'suite_findings_run' });
  await f.waitFor(() => work.tasks.list('project'), tasks => tasks.some(task => task.title === 'Fix failing suite'));
  await work.idle(); await work.jobs.sweep('project');
  const fixes = (await work.tasks.list('project')).filter(task => task.title === 'Fix failing suite'); expect(fixes).toHaveLength(1); expect(fixes[0]).toMatchObject({ goalId: goal.id, source: 'finding', state: 'draft' });
  expect((await work.jobs.runs('project')).find(run => run.taskId === receipt.taskId)).toMatchObject({ conclusion: 'failed', findings: [{ title: 'Fix failing suite' }] });
});
