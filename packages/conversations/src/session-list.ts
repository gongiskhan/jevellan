import { existsSync } from 'node:fs';
import { SessionListPreferencesSchema, SessionListUpdateSchema, applySessionListUpdate, defaultSessionListPreferences, readDocument, writeDocument, type Homes } from '@jevellan/core';
export function readSessionListPreferences(homes: Homes) {
  const path = homes.at('ui', 'session-list.json');
  return existsSync(path) ? readDocument(path, SessionListPreferencesSchema) : defaultSessionListPreferences();
}
/** Parse before the synchronous read/check/write so concurrent writers cannot share a revision. */
export function saveSessionListPreferences(homes: Homes, raw: unknown) {
  const input = SessionListUpdateSchema.parse(raw), current = readSessionListPreferences(homes), next = applySessionListUpdate(current, input);
  writeDocument(homes.at('ui', 'session-list.json'), SessionListPreferencesSchema, next); return next;
}
