import type { Action } from './schemas.js';

export const ACTION_DESCRIPTIONS: Record<Action, string> = {
  reply: 'Answer the user; no changes needed.',
  plan: 'Work out a plan before changing anything.',
  implement: 'Make or fix the change.',
  test: 'Run and add tests for what changed.',
  review: 'Have an independent model review the change.',
  'adversarial-review': 'Try hard to break the change before calling it done.',
  integrate: 'Resolve a publication conflict while preserving both sides of the work.',
  'ask-you': 'Stop and ask the user something only they can answer.',
  done: 'The request is complete.',
};
