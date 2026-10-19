import { expect, test } from 'vitest';
import { JobRunSpecSchema, WorkflowHandoffStateSchema, WorkflowSchedulerStateSchema } from '../packages/core/dist/index.js';

test('retired workflow snapshots retain scheduler and handoff history for old receipts', () => {
  const spec = JobRunSpecSchema.parse({ kind: 'github-workflow', workflow: 'nightly.yml', mode: 'watch', timeoutMinutes: 420, schedulerSwitch: { schema: 'workflow-scheduler-switch-v1', variable: 'NIGHTLY_SCHEDULER', dispatchValue: 'jevellan', watchOrder: 1 }, watchChain: { schema: 'workflow-watch-chain-v1', event: 'workflow_run', excludeTitle: '(not in the chain)', afterWorkflow: 'previous.yml' } });
  expect(spec.kind).toBe('github-workflow');
  const at = '2026-10-18T00:00:00Z';
  expect(WorkflowSchedulerStateSchema.parse({ schema: 'workflow-scheduler-state-v1', variable: 'NIGHTLY_SCHEDULER', checkedAt: at, mode: 'watch', reason: 'Historical variable read failed.' }).reason).toBe('Historical variable read failed.');
  expect(WorkflowHandoffStateSchema.parse({ schema: 'workflow-handoff-state-v1', pull: 1, checkedAt: at, state: 'merged' }).state).toBe('merged');
});
