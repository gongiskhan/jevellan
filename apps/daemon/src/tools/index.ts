import type { OwnerToolName } from '@jevellan/core';
import type { OwnerHandler } from '../owner-tools.js';
import { status } from './status.js';
import { activity } from './activity.js';
import { askCoordinator } from './ask-coordinator.js';
import { work } from './work.js';
import { respond } from './respond.js';
import { thread } from './thread.js';
import { config } from './config.js';
import { login } from './login.js';
import { jobs } from './jobs.js';
import { goals } from './goals.js';
import { jev } from './jev.js';
import { override } from './override.js';


/** One handler per owner tool (bridge specification, "Tool handlers"): each only calls services and renders text. */
export const OWNER_HANDLERS: Record<OwnerToolName, OwnerHandler> = {
  status, activity, ask_coordinator: askCoordinator, work, goals, jobs, thread,
  respond, override, jev, config, login,
};
