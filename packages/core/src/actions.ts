import type { Action } from './schemas.js';

export const ACTION_DESCRIPTIONS: Record<Action, string> = {
  reply: 'Answer an informational question or explain how to do something. Read-only, with no shell execution. Do not choose this for a request to carry out a command or change project state.',
  plan: 'Work out a plan before changing anything.',
  implement: 'Carry out the requested work using shell and write tools: make or fix code, run commands, or update project state. Includes short operational requests such as git pull, installing dependencies or running a build, even when no code edit is needed. Existing Git and safety guards still apply.',
  test: 'Run and add tests for what changed.',
  review: 'Have an independent model review the change.',
  'adversarial-review': 'Try hard to break the change before calling it done.',
  integrate: 'Resolve a publication conflict while preserving both sides of the work.',
  'ask-you': 'Stop and ask the user something only they can answer.',
  done: 'The request is complete.',
};
