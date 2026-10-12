import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const switchSpec = { schema: 'workflow-scheduler-switch-v1', variable: 'NIGHTLY_SCHEDULER', dispatchValue: 'jevellan', watchOrder: 1, ownerMergePull: 208 };
const request = (id: string) => ({ schema: 'project-run-request-v1', clientRequestId: id });
async function job(f: ProjectFixture, id: string, extra: object = {}) {
  await f.app.projectWork.prepareDailyWork('project');
  return f.app.projectWork.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: id, name: id, goalId: null, enabled: true, gate: null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5, schedulerSwitch: switchSpec, ...extra } });
}
test.each([undefined, 'github', 'unexpected', 'jevellan'])('repository variable %s selects mode without reading PR 208', { timeout: 60_000 }, async value => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  f.github.setVariable('NIGHTLY_SCHEDULER', value);
  const definition = await job(f, 'variable'), task = await work.daily.runJob('project', definition.id, request('variable'));
  await f.waitFor(() => work.jobs.runs('project'), rows => rows.some(row => row.taskId === task.taskId && row.phase === 'watching'));
  const run = (await work.jobs.runs('project'))[0]!;
  expect(run.spec).toMatchObject({ mode: value === 'jevellan' ? 'dispatch' : 'watch' });
  expect(run.workflowScheduler).toMatchObject({ mode: value === 'jevellan' ? 'dispatch' : 'watch' });
  expect(f.github.requests.filter(row => row.path.endsWith('/actions/variables/NIGHTLY_SCHEDULER'))).toHaveLength(1);
  expect(f.github.requests.some(row => row.path.endsWith('/pulls/208'))).toBe(false);
});
test('failed variable read watches and dispatch binds SHA title and real steps while main moves', { timeout: 60_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  f.github.failNext('GET', /variables\/NIGHTLY_SCHEDULER$/u, 403, 'Variables read is missing.');
  const definition = await job(f, 'sha', { commitInput: 'sha', requiredSteps: ['Tests'] });
  const watched = await work.daily.runJob('project', definition.id, request('fallback'));
  f.github.addWorkflow({ jobs: [{ id: 1, name: 'suite', status: 'completed', conclusion: 'success', steps: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] }] });
  await work.pulse(); await f.waitFor(() => work.tasks.read('project', watched.taskId), row => row.state === 'done');
  expect((await work.jobs.runs('project'))[0]!.workflowScheduler).toMatchObject({ mode: 'watch', reason: 'Variables read is missing.' });
  f.github.setVariable('NIGHTLY_SCHEDULER', 'jevellan');
  const receipt = await work.daily.runJob('project', definition.id, request('sha_dispatch'));
  const run = await f.waitFor(async () => (await work.jobs.runs('project')).find(row => row.taskId === receipt.taskId), row => !!row?.workflowRunId);
  expect(run!.dispatchRef).toBe('main');
  expect(f.github.requests.find(row => row.path.endsWith('/dispatches'))?.body).toEqual({ ref: 'main', return_run_details: true, inputs: { sha: run!.commit } });
  expect(f.github.requests.some(row => row.method === 'POST' && row.path.endsWith('/git/refs'))).toBe(false);
  f.github.changeWorkflow(run!.workflowRunId!, { head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', display_title: `nightly ${run!.commit}`, jobs: [{ id: 2, name: 'suite', status: 'completed', conclusion: 'success', steps: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] }] });
  now += 61_000; await work.pulse();
  await f.waitFor(() => work.tasks.read('project', receipt.taskId), row => row.state === 'done');
  expect((await work.jobs.runs('project')).find(row => row.taskId === receipt.taskId)).toMatchObject({ commit: run!.commit, conclusion: 'passed' });
});
test('watch legal rejects manual, repository dispatch and out-of-chain schedule titles', { timeout: 60_000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const definition = await job(f, 'legal', { watchChain: { schema: 'workflow-watch-chain-v1', event: 'schedule', titleSuffix: ' night', excludeTitle: '(not in the chain)' } });
  const wanted = f.github.addWorkflow({ event: 'schedule', display_title: 'nightly-legal-programme night' });
  for (const [event, display_title] of [['workflow_dispatch', 'nightly-legal-programme night'], ['repository_dispatch', 'nightly-legal-programme night'], ['schedule', 'nightly-legal-programme weekly'], ['schedule', 'nightly-legal-programme (not in the chain) night']] as const) f.github.addWorkflow({ event, display_title });
  const receipt = await work.daily.runJob('project', definition.id, request('legal_watch'));
  await f.waitFor(() => work.tasks.read('project', receipt.taskId), row => row.state === 'done');
  expect((await work.jobs.runs('project'))[0]?.workflowRunId).toBe(wanted.id);
});
test('a window snapshots one variable read and watch order through restart', { timeout: 60_000 }, async () => {
  let now = Date.parse('2026-10-11T12:00:00Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }, 0);
  for (const [name, order, watchOrder] of [['Legal', 0, 0], ['Full', 1, 2], ['Deploy', 2, 1]] as const) {
    const definition = await job(f, name, { workflow: `${name}.yml`, schedulerSwitch: { ...switchSpec, watchOrder } });
    await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: name, name, goalId: null, order, enabled: true, target: { kind: 'job', jobId: definition.id } });
  }
  now = Date.parse('2026-10-12T00:00:00Z'); await work.daily.sweep('project');
  const window = (await work.daily.window('project'))!;
  expect(window.workflowScheduler?.mode).toBe('watch'); expect(window.plans.map(row => row.title)).toEqual(['Legal', 'Deploy', 'Full']);
  expect(window.plans.every(row => row.workflowScheduler?.mode === 'watch')).toBe(true);
  expect(f.github.requests.filter(row => row.path.endsWith('/actions/variables/NIGHTLY_SCHEDULER'))).toHaveLength(1);
  f.github.setVariable('NIGHTLY_SCHEDULER', 'jevellan'); await f.restart();
  expect((await f.app.projectWork.daily.window('project'))?.plans).toEqual(window.plans);
  expect(f.github.requests.some(row => row.method === 'GET' && row.path.endsWith('/pulls/208'))).toBe(false);
});
test('watch descendants bind after their chain parent and exclude unrelated workflow runs', { timeout: 60_000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const legal = await job(f, 'legal_parent', { workflow: 'legal.yml', watchChain: { schema: 'workflow-watch-chain-v1', event: 'schedule', titleSuffix: ' night', excludeTitle: '(not in the chain)' } });
  const at = new Date().toISOString(); f.github.addWorkflow({ workflow: 'legal.yml', event: 'schedule', display_title: 'Legal night', updated_at: at });
  const parent = await work.daily.runJob('project', legal.id, request('parent'));
  await f.waitFor(() => work.tasks.read('project', parent.taskId), row => row.state === 'done');
  const deploy = await job(f, 'deploy_child', { workflow: 'deploy.yml', watchChain: { schema: 'workflow-watch-chain-v1', event: 'workflow_run', afterWorkflow: 'legal.yml', excludeTitle: '(not in the chain)' } });
  f.github.addWorkflow({ workflow: 'deploy.yml', event: 'workflow_run', display_title: 'Deploy', created_at: new Date(Date.parse(at) - 1).toISOString() });
  const wanted = f.github.addWorkflow({ workflow: 'deploy.yml', event: 'workflow_run', display_title: 'Deploy', created_at: new Date(Date.parse(at) + 1).toISOString() });
  for (const [event, display_title] of [['workflow_dispatch', 'Deploy'], ['repository_dispatch', 'Deploy'], ['workflow_run', 'Deploy (not in the chain)']] as const) f.github.addWorkflow({ workflow: 'deploy.yml', event, display_title });
  const receipt = await work.daily.runJob('project', deploy.id, request('child'));
  await f.waitFor(() => work.tasks.read('project', receipt.taskId), row => row.state === 'done');
  expect((await work.jobs.runs('project')).find(row => row.taskId === receipt.taskId)?.workflowRunId).toBe(wanted.id);
});
test('optional pinned refs are deleted at completion and stale dated refs are cleaned at window open', { timeout: 60_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  f.github.setVariable('NIGHTLY_SCHEDULER', 'jevellan');
  const definition = await job(f, 'pin', { pinCommitRef: true });
  const receipt = await work.daily.runJob('project', definition.id, request('pin'));
  const run = await f.waitFor(async () => (await work.jobs.runs('project')).find(row => row.taskId === receipt.taskId), row => !!row?.workflowRunId);
  expect(run!.dispatchRef).toBe(`jv/jobs/${now}-${run!.id}`);
  f.github.changeWorkflow(run!.workflowRunId!, { status: 'completed', conclusion: 'success' }); now += 61_000; await work.pulse();
  await f.waitFor(() => work.jobs.runs('project'), rows => !!rows.find(row => row.taskId === receipt.taskId)?.dispatchRefDeletedAt);
  expect(f.git(f.origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${run!.dispatchRef}`)).toBe('');
  const old = `jv/jobs/${now - 3 * 24 * 3_600_000}-old`, fresh = `jv/jobs/${now}-fresh`;
  for (const ref of [old, fresh]) f.git(f.origin, 'update-ref', `refs/heads/${ref}`, run!.commit);
  await work.jobs.cleanupWorkflowRefs('project');
  expect(f.git(f.origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${old}`)).toBe('');
  expect(f.git(f.origin, 'rev-parse', `refs/heads/${fresh}`)).toBe(run!.commit);
  const finished = (await work.jobs.runs('project'))[0]!;
  await expect(f.app.projectHub.putJobRun({ ...finished, summary: 'changed outcome' }, finished.revision)).rejects.toThrow('finished job receipt');
});
