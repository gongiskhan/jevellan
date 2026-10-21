import { afterEach, expect, test, vi } from 'vitest';
import { ProjectJobRunSchema } from '../packages/core/dist/index.js';
import { ProjectDailyWork } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('a reserved job is not started by recovery while its project is paused', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), id = f.project.id;
  await f.app.projectHub.assignCoordinator(id, f.app.device.deviceId, 0);
  // Run now is refused while paused, so the job is queued first and the project pauses with its run reserved.
  const job = await f.app.projectWork.daily.createJob(id, { schema: 'job-create-request-v1', clientRequestId: 'job', name: 'A recovered command', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  const receipt = await f.app.projectWork.daily.runJob(id, job.id, { schema: 'project-run-request-v1', clientRequestId: 'run' });
  const settings = (await f.app.projectWork.settingsView(id)).settings;
  await f.app.projectHub.putSettings({ ...settings, status: 'paused' }, settings.revision);
  const task = await f.app.projectWork.tasks.read(id, receipt.taskId), runId = 'reserved_job';
  await f.app.projectWork.tasks.save({ ...task, state: 'active', jobRunId: runId });
  await f.app.projectHub.putJobRun(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: runId, projectId: id, revision: 0, jobId: job.id, taskId: task.id,
    commit: f.git(f.checkout, 'rev-parse', 'HEAD'), deviceId: f.app.device.deviceId, projectDay: new Date().toISOString().slice(0, 10), startedAt: new Date().toISOString(), conclusion: null,
    summary: '', logTail: '', spec: job.run, baseBranch: 'main', phase: 'reserved', setupCommand: null, watchAfter: new Date().toISOString() }), 0);
  await f.app.projectWork.jobs.sweep(id);
  await f.app.projectWork.idle(id);
  expect(f.app.projectWork.jobs.busy(id)).toBe(false);
  expect((await f.app.projectHub.jobRun(runId))?.document).toMatchObject({ phase: 'reserved', conclusion: null });
  expect(f.git(f.checkout, 'worktree', 'list', '--porcelain')).not.toContain(f.homes.at('worktrees', id, 'jobs', runId));
  const paused = await f.app.projectWork.admission.settings(id);
  await f.app.projectHub.putSettings({ ...paused, status: 'active' }, paused.revision);
  await f.app.projectWork.jobs.sweep(id);
  await f.waitFor(() => f.app.projectHub.jobRun(runId), row => row?.document.conclusion === 'passed');
});

test('Run now cannot start a memory dream in a paused project', async () => {
  const f = fixture = await projectFixture(), id = f.project.id;
  await f.app.projectHub.assignCoordinator(id, f.app.device.deviceId, 0);
  const settings = (await f.app.projectWork.settingsView(id)).settings;
  await f.app.projectHub.putSettings({ ...settings, status: 'paused' }, settings.revision);
  const memoryDream = vi.fn(async () => ({ schema: 'memory-dream-run-receipt-v1' as const, id: 'dream', accepted: true as const }));
  const daily = new ProjectDailyWork({ ...f.app.projectWork.daily.o, memoryDream });
  const definition = await daily.createDaily(id, { schema: 'daily-create-request-v1', clientRequestId: 'dream', name: 'Dream', goalId: null, order: 1, enabled: true, target: { kind: 'memory-dream' } });
  await expect(daily.runDaily(id, definition.id, { schema: 'project-run-request-v1', clientRequestId: 'run' })).rejects.toThrow('The project is paused.');
  expect(memoryDream).not.toHaveBeenCalled();
});

test('a pause arriving after admission prevents worktree preparation and preserves the first turn', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), admission = f.app.projectWork.admission;
  const admit = admission.admit.bind(admission); let calls = 0;
  vi.spyOn(admission, 'admit').mockImplementation(async (...args) => {
    const result = await admit(...args);
    if (++calls === 2) {
      const settings = await admission.settings(f.project.id);
      await f.app.projectHub.putSettings({ ...settings, status: 'paused' }, settings.revision);
    }
    return result;
  });
  const receipt = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'pause-race', title: 'Pending work', task: 'Inspect the checkout.' });
  await f.waitFor(() => f.thread(receipt.threadId), row => row.state === 'idle');
  expect(f.thread(receipt.threadId).cwd).toBe('');
  expect(f.local(receipt.threadId).pendingTurn?.reason).toBe('task');
  expect(f.fake.turnStarts).toHaveLength(0);
});
