import { ContextOperationSchema, stableJson, type Homes } from '@jevellan/core';
import { ContextOperations, ConversationLedger, ConversationWork } from '@jevellan/conversations';
import type { HubDatabase } from '@jevellan/mesh';

/** Save every owner-local copy before removing any old shared document. */
export function migrateContextOperations(hub: HubDatabase, homes: Homes, deviceId: string, target: ContextOperations): void {
  const records = hub.list('context-operations', ContextOperationSchema);
  for (const { document } of records) {
    const owner = new ConversationWork(new ConversationLedger(homes, document.conversationId)).load().conversation.ownerDeviceId;
    if (owner !== deviceId) throw new Error('Restore the owning conversation before migrating its context operation.');
    const saved = target.get(document.id);
    if (saved && stableJson(saved) !== stableJson(document)) throw new Error('Local and shared context operations differ. Preserve both copies before recovery.');
    target.put(document);
  }
  hub.transaction(() => {
    for (const { document } of records) hub.db.prepare("DELETE FROM documents WHERE namespace='context-operations' AND id=?").run(document.id);
  });
}
