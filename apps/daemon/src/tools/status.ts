import { renderStatus } from '@jevellan/projects';
import type { OwnerHandler } from '../owner-tools.js';

type Section = 'waiting' | 'running' | 'queued' | 'landed' | 'finished';
/** `status` (read): the project's status in the fixed order. */
export const status: OwnerHandler = async ({ tools, project, args }) => {
  const options = { ...(typeof args.goal === 'string' ? { goal: args.goal } : {}), ...(typeof args.section === 'string' ? { section: args.section as Section } : {}), detail: args.detail === true };
  const view = await tools.status(project, options.goal);
  return { text: renderStatus(view, options), data: view };
};
