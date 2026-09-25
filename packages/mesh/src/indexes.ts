import { createHash } from 'node:crypto';
import {
  ConversationIndexSchema, ConversationSchema, CorrectionRecordSchema, DecisionIndexSchema, DecisionRecordSchema, IdSchema, IndexCursorSchema, IndexDocumentSchema, IndexReceiptSchema, IndexRequestSchema, IndexResultSchema, IndexUpdateSchema,
  conversationIndex, decisionIndex, indexConversation, indexKind, stableJson, type IndexUpdate, type SharedIndexes,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }

/** Existing full records become slim indexes atomically; owner ledgers stay intact. */
export function migrateSharedIndexes(hub: HubDatabase): void {
  hub.transaction(() => {
    for (const row of hub.db.prepare("SELECT namespace,id,document FROM documents WHERE namespace IN ('conversations','decisions')").all()) {
      const value: unknown = JSON.parse(String(row.document)); const conversation = row.namespace === 'conversations';
      const current = conversation ? ConversationIndexSchema.safeParse(value) : DecisionIndexSchema.safeParse(value);
      if (current.success) continue;
      const document = conversation ? conversationIndex(ConversationSchema.parse(value)) : decisionIndex(DecisionRecordSchema.parse(value));
      if (document.id !== row.id) throw new Error('Stored index identity does not match its key.');
      hub.db.prepare('UPDATE documents SET document=?,revision=revision+1 WHERE namespace=? AND id=?').run(JSON.stringify(document), String(row.namespace), String(row.id));
    }
  });
}

export class HubIndexes implements SharedIndexes {
  constructor(readonly hub: HubDatabase, readonly deviceId: string) { IdSchema.parse(deviceId); }
  publish(raw: IndexUpdate) {
    const update = IndexUpdateSchema.parse(raw); const document = update.document;
    const conversationId = indexConversation(document); const kind = indexKind(document);
    return this.hub.transaction(() => {
      const conversation = this.hub.get('conversations', conversationId, ConversationIndexSchema)?.document;
      if (document.schema === 'conversation-index-v1') {
        if (document.ownerDeviceId !== this.deviceId || conversation && (conversation.ownerDeviceId !== this.deviceId || conversation.projectId !== document.projectId)) refuse('This conversation belongs to another owner or project.', 403);
      } else {
        if (!conversation || conversation.ownerDeviceId !== this.deviceId) refuse('Only the conversation owner can publish its index.', 403);
        if ('projectId' in document && document.projectId !== conversation.projectId) refuse('The correction belongs to another project.', 403);
      }
      const key = digest(`${kind}\0${document.id}`); const cursor = this.hub.get('index-cursors', key, IndexCursorSchema);
      const previous = this.hub.get(kind, document.id, IndexDocumentSchema); const contentDigest = digest(stableJson(document));
      if (previous && indexConversation(previous.document) !== conversationId) refuse('This index identifier belongs to another conversation.', 403);
      if (cursor && (cursor.document.deviceId !== this.deviceId || cursor.document.conversationId !== conversationId)) refuse('This index belongs to another owner.', 403);
      if (cursor && update.eventId <= cursor.document.eventId) {
        if (update.eventId === cursor.document.eventId && contentDigest !== cursor.document.digest) refuse('This ledger event already published a different index.');
        return IndexReceiptSchema.parse({ schema: 'index-receipt-v1', kind, id: document.id, eventId: cursor.document.eventId });
      }
      if (!previous || stableJson(previous.document) !== stableJson(document)) this.hub.put(kind, document.id, IndexDocumentSchema, document, previous?.revision ?? 0);
      const receipt = IndexReceiptSchema.parse({ schema: 'index-receipt-v1', kind, id: document.id, eventId: update.eventId });
      this.hub.put('index-cursors', key, IndexCursorSchema, { ...receipt, schema: 'index-cursor-v1', conversationId, deviceId: this.deviceId, digest: contentDigest }, cursor?.revision ?? 0);
      return receipt;
    });
  }
  conversations() { return this.hub.list('conversations', ConversationIndexSchema).map(row => row.document); }
  corrections() { return this.hub.list('overrides', CorrectionRecordSchema).map(row => row.document); }
  request(raw: unknown) {
    const request = IndexRequestSchema.parse(raw);
    if (request.operation === 'publish') return IndexResultSchema.parse({ schema: 'index-result-v1', operation: 'publish', receipt: this.publish(request.update) });
    const records = (request.operation === 'conversations' ? this.conversations() : this.corrections()).filter(record => !request.after || record.id > request.after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return IndexResultSchema.parse({ schema: 'index-result-v1', operation: request.operation, records: records.slice(0, 100), next: records.length > 100 ? records[99]!.id : null });
  }
}

export class MemberIndexes implements SharedIndexes {
  constructor(readonly client: MemberHubClient) {}
  async publish(update: IndexUpdate) {
    const result = await this.client.indexes({ schema: 'index-request-v1', operation: 'publish', update });
    if (result.operation !== 'publish' || result.receipt.id !== update.document.id || result.receipt.kind !== indexKind(update.document) || result.receipt.eventId < update.eventId) throw new HubProtocolError();
    return result.receipt;
  }
  async #list(operation: 'conversations' | 'corrections') {
    const records = []; let after: string | undefined;
    for (;;) {
      const result = await this.client.indexes({ schema: 'index-request-v1', operation, ...(after ? { after } : {}) });
      if (result.operation !== operation) throw new HubProtocolError();
      let previous = after;
      for (const record of result.records) { if (previous && record.id <= previous) throw new HubProtocolError(); previous = record.id; records.push(record); }
      if (result.next === null) return records;
      if (!result.records.length || result.next !== previous || after && result.next <= after) throw new HubProtocolError();
      after = result.next;
    }
  }
  async conversations() { return (await this.#list('conversations')).map(value => ConversationIndexSchema.parse(value)); }
  async corrections() { return (await this.#list('corrections')).map(value => CorrectionRecordSchema.parse(value)); }
}
