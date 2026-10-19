import type { OwnerToolName } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { status } from './status.js';

const later = (name: string): OwnerHandler => async () => { throw new OwnerRefusal(`${name} is not available in this version yet.`, 'not_available', 501); };

/** One handler per owner tool (bridge specification, "Tool handlers"): each only calls services and renders text. */
export const OWNER_HANDLERS: Record<OwnerToolName, OwnerHandler> = {
  status, activity: later('activity'), ask_coordinator: later('ask_coordinator'), work: later('work'), goals: later('goals'), jobs: later('jobs'), thread: later('thread'),
  respond: later('respond'), override: later('override'), jev: later('jev'), config: later('config'), login: later('login'),
};
