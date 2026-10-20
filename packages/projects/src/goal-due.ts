import type { GoalLine, ProjectDaily, ProjectGoal, ProjectJobRun, ProjectWindow, ProjectWorkTask } from '@jevellan/core';

/** Shared due rules; clients render these results without inferring overdue work. */
export function goalDue(goal: ProjectGoal, counts: { running: number; queued: number }, input: {
  tasks: readonly ProjectWorkTask[]; dailies: readonly ProjectDaily[]; runs: readonly ProjectJobRun[]; windows: readonly ProjectWindow[];
}): GoalLine['due'] {
  if (goal.state === 'done') return [];
  const due: GoalLine['due'] = [], lastWindow = [...input.windows].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
  const dailyByJob = new Map(input.dailies.flatMap(daily => daily.target.kind === 'job' ? [[daily.target.jobId, daily] as const] : []));
  if (lastWindow?.state === 'finished') for (const daily of input.dailies.filter(row => row.goalId === goal.id && row.enabled)) {
    const ran = input.tasks.some(task => task.dailyId === daily.id && task.nightlyWindowId === lastWindow.id)
      || input.runs.some(run => dailyByJob.get(run.jobId)?.id === daily.id && run.startedAt >= lastWindow.openedAt);
    if (!ran) due.push({ type: 'daily_item', ref: daily.id, text: `${daily.name} (not run last night)` });
  }
  if (goal.state === 'active' && counts.running + counts.queued === 0) due.push({ type: 'idle_goal', ref: goal.id, text: 'nothing queued or running' });
  return due;
}
