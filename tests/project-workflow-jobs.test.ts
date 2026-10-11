import { afterEach, expect, test } from 'vitest';
import { GitHubClient, type ProjectJobRun } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const request = (id: string) => ({ schema: 'project-run-request-v1', clientRequestId: id });
async function define(f: ProjectFixture, id: string, mode: 'watch' | 'dispatch', gate: string | null = null, requiredSteps: string[] = []) {
  await f.app.projectWork.prepareDailyWork('project');
  return f.app.projectWork.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: id, name: id, goalId: null, enabled: true, gate: gate ? { jobId: gate } : null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode, timeoutMinutes: 5, requiredSteps } });
}
async function completed(f: ProjectFixture, taskId: string): Promise<ProjectJobRun> {
  await f.waitFor(() => f.app.projectWork.tasks.read('project', taskId), task => ['done', 'failed', 'cancelled'].includes(task.state));
  return (await f.app.projectWork.jobs.runs('project')).find(run => run.taskId === taskId)!;
}
test('watch requires the actual test step, reports failed jobs/logs and cannot pass a successful scheduler with skipped tests', { timeout: 60_000 }, async () => {
  const f = fixture = await projectFixture(), job = await define(f, 'Actual_suite', 'watch', null, ['Run full suite']);
  f.github.addWorkflow({ jobs: [{ id: 12, name: 'Suite', status: 'completed', conclusion: 'success', steps: [{ name: 'Run full suite', status: 'completed', conclusion: 'skipped' }] }] });
  const skipped = await f.app.projectWork.daily.runJob('project', job.id, request('skipped'));
  expect(await completed(f, skipped.taskId)).toMatchObject({ conclusion: 'failed', workflowRunId: 1, summary: 'The required test jobs or steps did not run successfully.' });
  f.github.addWorkflow({ conclusion: 'failure', jobs: [{ id: 13, name: 'Suite', status: 'completed', conclusion: 'failure', logs: 'Assertion failed in the suite.', steps: [{ name: 'Run full suite', status: 'completed', conclusion: 'failure' }] }] });
  const failed = await f.app.projectWork.daily.runJob('project', job.id, request('failed'));
  const run = await completed(f, failed.taskId); expect(run).toMatchObject({ conclusion: 'failed', workflowRunId: 2 }); expect(run.logTail).toContain('Assertion failed');
  f.github.addWorkflow({ jobs: [{ id: 14, name: 'Suite', status: 'completed', conclusion: 'success', steps: [{ name: 'Run full suite', status: 'completed', conclusion: 'success' }] }] });
  const passed = await f.app.projectWork.daily.runJob('project', job.id, request('passed')); expect(await completed(f, passed.taskId)).toMatchObject({ conclusion: 'passed', workflowRunId: 3 });
});
test('dispatch records its returned run ID and uses a dedicated passing-commit ref for a gate', { timeout: 60_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  const gate = await define(f, 'Full_suite', 'watch'); f.github.addWorkflow({}); const first = await f.app.projectWork.daily.runJob('project', gate.id, request('gate')); const pass = await completed(f, first.taskId);
  const deploy = await define(f, 'Deploy', 'dispatch', gate.id), receipt = await f.app.projectWork.daily.runJob('project', deploy.id, request('deploy'));
  const run = await f.waitFor(async () => (await f.app.projectWork.jobs.runs('project')).find(run => run.taskId === receipt.taskId), run => !!run?.pollAfter);
  if (!run) throw new Error('The dispatched workflow has no receipt.');
  expect(run.workflowRunId).toBe(2); expect(run.dispatchRef).toBe(`jv/jobs/${run.id}`); expect(f.git(f.origin, 'rev-parse', `refs/heads/${run.dispatchRef}`)).toBe(pass.commit);
  const dispatch = f.github.requests.find(row => row.path.endsWith('/dispatches'))!; expect(dispatch.body).toEqual({ ref: run.dispatchRef, return_run_details: true }); expect(dispatch.headers.apiVersion).toBe('2026-03-10');
  // A newer unrelated run must not steal this receipt.
  f.github.addWorkflow({ conclusion: 'success' }); f.github.changeWorkflow(2, { status: 'completed', conclusion: 'failure', jobs: [{ id: 40, name: 'Deploy', status: 'completed', conclusion: 'failure' }] });
  now += 61_000; await f.app.projectWork.pulse(); expect(await completed(f, receipt.taskId)).toMatchObject({ workflowRunId: 2, conclusion: 'failed', commit: pass.commit });
});
test('missing runs time out, dispatch errors are explicit and a lost dispatch reply is never repeated', { timeout: 60_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), watch = await define(f, 'Wait', 'watch');
  const wait = await f.app.projectWork.daily.runJob('project', watch.id, request('wait'));
  await f.waitFor(() => f.app.projectWork.jobs.runs('project'), runs => runs.some(run => run.taskId === wait.taskId && run.phase === 'watching'));
  now += 5 * 60_000; await f.app.projectWork.pulse(); expect(await completed(f, wait.taskId)).toMatchObject({ conclusion: 'timed-out', summary: 'No run of nightly.yml started today.' });
  const dispatch = await define(f, 'Dispatch', 'dispatch'); f.github.failNext('POST', /dispatches$/u, 403, 'Resource not accessible by token.');
  const denied = await f.app.projectWork.daily.runJob('project', dispatch.id, request('denied')); expect((await completed(f, denied.taskId)).summary).toBe('Resource not accessible by token.');
  f.github.loseNextDispatchReply(); const lost = await f.app.projectWork.daily.runJob('project', dispatch.id, request('lost'));
  expect((await completed(f, lost.taskId)).conclusion).toBe('failed'); expect(f.github.workflows).toHaveLength(1);
  const sends = f.github.requests.filter(row => row.path.endsWith('/dispatches')).length; await f.restart(); await f.app.projectWork.pulse(); expect(f.github.requests.filter(row => row.path.endsWith('/dispatches'))).toHaveLength(sends);
  const client = new GitHubClient({ token: async () => f.token, fetch: async () => new Response(null, { status: 204 }) });
  await expect(client.dispatchWorkflow({ owner: 'fixture', repo: 'repo' }, 'nightly.yml', 'main')).rejects.toThrow('unexpected response');
});

test('a handoff watches without effects before owner merge, then dispatches pinned inputs and refuses a moved run head', { timeout: 60_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  f.git(f.checkout, 'push', 'origin', 'HEAD:handoff');
  const client = new GitHubClient({ token: async () => f.token, baseUrl: f.github.url });
  const pr = await client.createPull({ owner: 'fixture', repo: 'repo' }, { title: 'Handoff', head: 'handoff', base: 'main', body: 'Owner handoff' });
  const definition = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'handoff', name: 'Deploy', goalId: null, enabled: true, gate: null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5, inputs: { expensive: 'true', sha: 'overwritten' }, commitInput: 'sha', dispatchAfterMerge: { schema: 'workflow-dispatch-handoff-v1', pull: pr.number, watchOrder: 2 } } });
  await work.prepareDailyWork('project'); f.github.addWorkflow({});
  const watched = await work.daily.runJob('project', definition.id, request('watch_handoff')); expect(await completed(f, watched.taskId)).toMatchObject({ conclusion: 'passed', spec: { mode: 'watch' } });
  expect((await work.tasks.read('project', watched.taskId)).workflowHandoff?.state).toBe('waiting'); expect(f.github.requests.some(row => row.path.endsWith('/dispatches'))).toBe(false);
  f.github.markMerged(pr.number);
  const dispatched = await work.daily.runJob('project', definition.id, request('dispatch_handoff'));
  const run = await f.waitFor(async () => (await work.jobs.runs('project')).find(row => row.taskId === dispatched.taskId), run => !!run?.pollAfter); if (!run) throw new Error('No run receipt');
  expect((await work.tasks.read('project', dispatched.taskId)).workflowHandoff?.state).toBe('merged');
  expect(f.github.requests.find(row => row.path.endsWith('/dispatches'))?.body).toEqual({ ref: `jv/jobs/${run.id}`, return_run_details: true, inputs: { expensive: 'true', sha: run.commit } });
  expect(f.git(f.origin, 'rev-parse', `refs/heads/jv/jobs/${run.id}`)).toBe(run.commit);
  f.github.changeWorkflow(run.workflowRunId!, { head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'success' }); now += 61_000; await work.pulse();
  expect(await completed(f, dispatched.taskId)).toMatchObject({ conclusion: 'failed', commit: run.commit, summary: 'The workflow run does not match its recorded commit.' });
});

test('the nightly handoff decision freezes current watch order through restart and changes only in the next window', { timeout: 60_000 }, async () => {
  let now = Date.parse('2026-10-11T12:00:00Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), work = f.app.projectWork;
  await work.prepareDailyWork('project'); const current = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...current, refill: { enabled: false, minIntervalMinutes: 30 }, nightlyWindow: { enabled: true, time: '01:00', timezone: 'Europe/Lisbon' } }, 0);
  f.git(f.checkout, 'push', 'origin', 'HEAD:handoff'); const client = new GitHubClient({ token: async () => f.token, baseUrl: f.github.url });
  const pr = await client.createPull({ owner: 'fixture', repo: 'repo' }, { title: 'Handoff', head: 'handoff', base: 'main', body: '' });
  for (const [name, order, watchOrder] of [['Legal', 1, 1], ['Full', 2, 3], ['Deploy', 3, 2]] as const) {
    const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: name, name, goalId: null, enabled: true, gate: null, run: { kind: 'github-workflow', workflow: `${name}.yml`, mode: 'dispatch', timeoutMinutes: 5, dispatchAfterMerge: { schema: 'workflow-dispatch-handoff-v1', pull: pr.number, watchOrder } } });
    await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: name, name, goalId: null, order, enabled: true, target: { kind: 'job', jobId: job.id } });
  }
  now = Date.parse('2026-10-12T00:00:00Z'); await work.daily.sweep('project'); const window = (await work.daily.window('project'))!;
  expect(window.plans.map(row => row.title)).toEqual(['Legal', 'Deploy', 'Full']); expect(window.plans.every(row => row.workflowHandoff?.state === 'waiting')).toBe(true);
  expect(f.github.requests.filter(row => row.method === 'GET' && row.path.endsWith(`/pulls/${pr.number}`))).toHaveLength(1);
  f.github.markMerged(pr.number); await f.restart(); expect((await f.app.projectWork.daily.window('project'))?.plans).toEqual(window.plans);
  now += 24 * 3_600_000; await f.app.projectWork.daily.sweep('project');
  expect((await f.app.projectWork.daily.window('project'))?.plans.map(row => row.title)).toEqual(['Legal', 'Full', 'Deploy']);
});

test('an unreadable handoff is a durable blocker and cannot dispatch after restart', { timeout: 60_000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork; await work.prepareDailyWork('project');
  const definition = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'blocked_handoff', name: 'Blocked', goalId: null, enabled: true, gate: null,
    run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5, dispatchAfterMerge: { schema: 'workflow-dispatch-handoff-v1', pull: 99, watchOrder: 1 } } });
  f.github.failNext('GET', /pulls\/99$/u, 403, 'Actions access requires a project token.');
  const task = await work.daily.runJob('project', definition.id, request('blocked')); expect(await completed(f, task.taskId)).toMatchObject({ conclusion: 'failed', workflowHandoff: { state: 'blocked', pull: 99 } });
  await f.restart(); await f.app.projectWork.pulse(); expect(f.github.requests.some(row => row.path.endsWith('/dispatches'))).toBe(false);
});
