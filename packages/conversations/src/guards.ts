import { ActionSchema, type Action, type Guards, type Work } from '@jevellan/core';

export function allowedActions(work: Work, guards: Guards, hasTestCommand: boolean, decisionsThisWork: number): Action[] {
  return actions(guards, hasTestCommand, work.counters.reviews, decisionsThisWork);
}
export function allowedInitialActions(guards: Guards, hasTestCommand: boolean): Action[] { return actions(guards, hasTestCommand, 0, 0); }
function actions(guards: Guards, hasTestCommand: boolean, reviews: number, decisions: number): Action[] {
  return ActionSchema.options.filter((action) => action !== 'integrate'
    && !(action === 'done' && decisions === 0)
    && !(action === 'test' && !hasTestCommand)
    && !(['review', 'adversarial-review'].includes(action) && reviews >= guards.reviewCap));
}
export type GuardStop = { kind: 'steps' | 'no-progress' | 'test-failures' | 'cost'; notice: string };
/** Called at a finished stretch/Jev-call boundary, not to veto a user's resume. */
export function checkGuards(work: Work, guards: Guards): GuardStop | null {
  const counters = work.counters;
  if (counters.stretches >= work.allowance.stretches) return { kind: 'steps', notice: `Stopped after ${counters.stretches} steps on this work. Reply to continue for up to ${guards.maxStretchesPerWork} more steps, or close the work.` };
  if (counters.noProgress >= guards.noProgressLimit) return { kind: 'no-progress', notice: `The last ${counters.noProgress} steps changed nothing. What should change?` };
  if (counters.testFailures >= guards.testFailureLimit) return { kind: 'test-failures', notice: `Tests failed ${counters.testFailures} times in a row. How should I proceed?` };
  if (guards.workCostCapUsd !== null && counters.costUsd >= guards.workCostCapUsd) return { kind: 'cost', notice: `This work has spent about $${counters.costUsd.toFixed(2)} of its $${guards.workCostCapUsd.toFixed(2)} cap${counters.unknownCostStretches ? `, plus ${counters.unknownCostStretches} steps with unknown cost` : ''}. Reply to continue, or close the work.` };
  return null;
}
