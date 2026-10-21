import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { SessionListPreferencesSchema, SessionListUpdateSchema } from './session-list-schemas.js';
export const SessionListViewSchema = z.strictObject({ schema: z.literal('session-list-view-v1'), deviceId: IdSchema, preferences: SessionListPreferencesSchema });
export type SessionListPreferences = z.infer<typeof SessionListPreferencesSchema>;
export type SessionListChange = { operation: 'rename'; id: string; title: string } | { operation: 'order'; order: string[] };
export function defaultSessionListPreferences(): SessionListPreferences { return SessionListPreferencesSchema.parse({ schema: 'session-list-preferences-v1', revision: 0, titles: {}, order: [] }); }
export function acceptSessionListPreferences(current: SessionListPreferences, next: SessionListPreferences): SessionListPreferences { return next.revision >= current.revision ? next : current; }
export function prepareSessionListUpdate(current: SessionListPreferences, change: SessionListChange) { return SessionListUpdateSchema.parse({ schema: 'session-list-update-v1', revision: current.revision, ...change }); }
export function applySessionListUpdate(current: SessionListPreferences, raw: unknown): SessionListPreferences {
  const input = SessionListUpdateSchema.parse(raw);
  if (input.revision !== current.revision) throw Object.assign(new Error('The session list changed elsewhere. Try again with the refreshed list.'), { status: 409 });
  return SessionListPreferencesSchema.parse({ ...current, revision: current.revision + 1,
    ...(input.operation === 'rename' ? { titles: { ...current.titles, [input.id]: input.title } } : { order: [...new Set(input.order)] }) });
}
export function sessionListView(deviceId: string, preferences: SessionListPreferences) { return SessionListViewSchema.parse({ schema: 'session-list-view-v1', deviceId, preferences }); }
