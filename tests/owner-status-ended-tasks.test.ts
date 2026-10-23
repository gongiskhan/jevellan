import { expect, test } from 'vitest';
import { ProjectStatusViewSchema } from '../packages/core/dist/index.js';
import { projectStatus, renderStatus, OwnerShortIds, type StatusInput } from '../packages/projects/dist/index.js';
import { MemoryStore, NOW, at, coordinator, goal, settings, task, thread } from './helpers/owner-fixtures.js';
import { projectFixture } from './helpers/project-fixture.js';

test('recent tasks cancelled or failed before a thread starts keep their ids, reasons and goal in finished status', () => {
  const ids = new OwnerShortIds(new MemoryStore());
  const tasks = [task('one', 'Optional parser cleanup', { goalId: 'goal' }), task('two', 'Admission could not start')];
  const input = (patch: Partial<StatusInput> = {}): StatusInput => ({
    project: { id: 'sandbox', name: 'sandbox' }, now: NOW, settings: settings(), coordinator: coordinator(), coordinatorStalled: false,
    tasks, goals: [goal('goal', 'Parser')], threads: [], decisions: [], jobs: [], dailies: [], runs: [], windows: [], deploys: [],
    budgets: [], deviceName: () => 'dev-box', deployPaused: false, ...patch,
  });
  expect(projectStatus(input(), ids).queued.map(row => row.id)).toEqual(['T1', 'T2']);
  const cancelled = { ...tasks[0]!, state: 'cancelled' as const, endedAt: at(2), endNote: 'Excluded from the requested batch.' };
  const failed = { ...tasks[1]!, state: 'failed' as const, endedAt: at(1), endNote: 'No eligible placement.' };
  const ended = [cancelled, failed,
    task('old', 'Old cancellation', { state: 'cancelled', endedAt: at(13 * 60) }),
    task('backed', 'A real stopped thread', { state: 'cancelled', threadId: 'stopped', endedAt: at(1) }),
    task('job_task', 'A real cancelled job', { state: 'cancelled', kind: 'job', jobRunId: 'job_run', endedAt: at(1) }),
  ];
  const view = ProjectStatusViewSchema.parse(projectStatus(input({ tasks: ended,
    threads: [thread('stopped', 'A real stopped thread', { state: 'stopped', endedAt: at(1) })] }), ids));
  expect(view.queued).toEqual([]);
  expect(view.finished.filter(row => ['T1', 'T2'].includes(row.id)).map(row => [row.id, row.state, row.detail, row.startedAt]))
    .toEqual([['T2', 'failed', failed.endNote, null], ['T1', 'cancelled', cancelled.endNote, null]]);
  expect(view.finished.filter(row => row.title === 'A real stopped thread')).toHaveLength(1);
  expect(view.finished.some(row => row.title === 'A real cancelled job' || row.title === 'Old cancellation')).toBe(false);
  expect(renderStatus(view, { section: 'finished', detail: true })).toContain('Excluded from the requested batch.');
  const filtered = projectStatus(input({ tasks: ended, goalFilter: 'Parser' }), ids);
  expect(filtered.finished.map(row => [row.id, row.label.name])).toEqual([['T1', 'Parser']]);
});

test('normal owner tools expose the recorded cancellation reason in their reply, inspect and finished status', async () => {
  const f = await projectFixture();
  const call = (name: string, args: Record<string, unknown>) => f.app.ownerTools.call(name, {
    schema: 'owner-tool-request-v1', caller: 'bridge:project', args,
  });
  try {
    await f.app.projectWork.createTask('project', { schema: 'task-create-request-v1', clientRequestId: 'held_cleanup', title: 'Optional parser cleanup',
      brief: 'Optional parser cleanup.', type: 'feature', goalId: null, now: false, held: true, after: [], needs: [], fixed: {} });
    expect((await call('status', {})).ok).toBe(true);
    expect((await f.app.projectWork.taskList('project')).tasks[0]?.threadId).toBeNull();
    const reason = 'Excluded from the requested batch.';
    const cancelled = await call('work', { action: 'cancel', task: 'T1', reason });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error('Expected a cancelled fixture task.');
    expect(cancelled.text).toContain('Cancelled T1');
    expect(cancelled.text).toContain(reason);
    const status = await call('status', { section: 'finished', detail: true });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error('Expected fixture status.');
    expect(ProjectStatusViewSchema.parse(status.data).finished).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'T1', state: 'cancelled', detail: reason, startedAt: null }),
    ]));
    expect(status.text).toContain(reason);
    const inspect = await call('work', { action: 'inspect', task: 'T1' });
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) throw new Error('Expected fixture task.');
    expect(inspect.text).toContain('State: cancelled');
    expect(inspect.text).toContain(`Reason: ${reason}`);
    expect(f.fake.turnStarts).toHaveLength(0);
  } finally { await f.close(); }
});
