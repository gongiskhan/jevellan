import { ConversationSidebarRequestSchema, conversationSidebarView } from '@jevellan/core';
import { readSessionListPreferences } from '@jevellan/conversations';
import { UiAuth } from '@jevellan/mesh';
import type { Application } from './application.js';
import { conversationListSource } from './conversation-list-source.js';
import { cursorListSource } from './cursor-api.js';

/** Normal owner/native readers, with an owner token held only for the lifetime of headless peer reads. */
export async function ownerConversationSidebar(app: Application, raw: unknown = { schema: 'conversation-sidebar-request-v1' }, ownerToken?: string) {
  const request = ConversationSidebarRequestSchema.parse(raw);
  const auth = app.auth;
  if (!ownerToken && !(auth instanceof UiAuth)) throw Object.assign(new Error('Owner tools must run on the state point.'), { status: 409 });
  const token = ownerToken ?? (auth as UiAuth).issue(); app.redactor.add(token);
  try {
    const [sourceRead, nativeRead, rosterRead] = await Promise.allSettled([conversationListSource(app), cursorListSource(app, token), app.roster()]);
    if (sourceRead.status === 'rejected') throw sourceRead.reason;
    if (nativeRead.status === 'rejected') throw nativeRead.reason;
    if (rosterRead.status === 'rejected') throw rosterRead.reason;
    const source = sourceRead.value, native = nativeRead.value, roster = rosterRead.value;
    return conversationSidebarView(app.redactor.document({ schema: 'conversation-sidebar-facts-v1', source, native,
      devices: roster.devices.filter(row => !row.revoked).map(({device}) => ({id:device.id,name:device.name})), preferences:readSessionListPreferences(app.homes) }), request);
  } finally { if (!ownerToken) (auth as UiAuth).logout(token); }
}
