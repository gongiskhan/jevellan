import type { OwnerToolName } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { status } from './status.js';
import { activity } from './activity.js';
import { askCoordinator } from './ask-coordinator.js';
import { work } from './work.js';
import { respond } from './respond.js';
import { thread } from './thread.js';
import { config } from './config.js';
import { login } from './login.js';

const later = (name: string): OwnerHandler => async () => { throw new OwnerRefusal(`${name} is not available in this version yet.`, 'not_available', 501); };

/** One handler per owner tool (bridge specification, "Tool handlers"): each only calls services and renders text. */
export const OWNER_HANDLERS: Record<OwnerToolName, OwnerHandler> = {
  status, activity, ask_coordinator: askCoordinator, work, goals: later('goals'), jobs: later('jobs'), thread,
  respond, override: later('override'), jev: later('jev'), config, login,
};
