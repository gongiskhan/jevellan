import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOperationSchema, Homes } from '../packages/core/dist/index.js';
import { ContextOperations, ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { migrateContextOperations } from '../apps/daemon/dist/context-migration.js';

let root: string; let homes: Homes; let hub: HubDatabase; let target: ContextOperations;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-context-operations-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); hub = new HubDatabase(homes, 'hub'); target = new ContextOperations(homes); });
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
function record(id: string, ownerDeviceId = 'owner') {
  const work = new ConversationWork(new ConversationLedger(homes, `conversation_${id}`)); work.create({ title: 'Fixture context', projectId: 'project', ownerDeviceId }); work.message('Merge the instructions.', `message_${id}`);
  return ContextOperationSchema.parse({ schema: 'context-operation-v1', id, projectId: 'project', conversationId: work.ledger.id, workId: work.load().conversation.work!.id, createdAt: new Date().toISOString(), generation: 1,
    request: { schema: 'context-request-v1', clientRequestId: id, revision: 1, fingerprint: '0'.repeat(64), choice: 'merge' },
    before: { schema: 'project-context-v1', projectId: 'project', state: 'needs-decision', fingerprint: '0'.repeat(64), claudeReadsAgents: false, files: ['AGENTS.md', 'CLAUDE.md'].map(name => ({ name, kind: 'file', tracked: true, hash: '0'.repeat(64), content: `Private original ${name}` })) },
    status: 'draft-ready', draft: 'Private merged instructions.' });
}
test('migration preserves complete drafts locally and removes their shared copies only after every save', () => {
  const first = record('first'); const second = record('second'); for (const value of [first, second]) hub.put('context-operations', value.id, ContextOperationSchema, value, 0);
  const put = target.put.bind(target); vi.spyOn(target, 'put').mockImplementationOnce(put).mockImplementationOnce(() => { throw new Error('Simulated interrupted write'); });
  expect(() => migrateContextOperations(hub, homes, 'owner', target)).toThrow('interrupted'); expect(hub.list('context-operations', ContextOperationSchema)).toHaveLength(2); expect(target.get('first')).toEqual(first);
  vi.restoreAllMocks(); migrateContextOperations(hub, homes, 'owner', new ContextOperations(homes));
  expect(target.list()).toEqual([first, second]); expect(hub.list('context-operations', ContextOperationSchema)).toEqual([]);
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain('Private merged');
});
test('a divergent local draft and a foreign owner both retain the original shared document', () => {
  const value = record('first'); hub.put('context-operations', value.id, ContextOperationSchema, value, 0); target.put({ ...value, draft: 'A newer local edit.' });
  expect(() => migrateContextOperations(hub, homes, 'owner', target)).toThrow('differ'); expect(target.get('first')?.draft).toBe('A newer local edit.'); expect(hub.get('context-operations', value.id, ContextOperationSchema)?.document).toEqual(value);
  target.put(value); expect(() => migrateContextOperations(hub, homes, 'another_device', target)).toThrow('owning conversation'); expect(hub.list('context-operations', ContextOperationSchema)).toHaveLength(1);
});
test('owner-local operation identity cannot be transferred to a different conversation', () => {
  const value = record('first'); target.put(value); expect(() => target.put({ ...value, conversationId: 'unrelated' })).toThrow('different work'); expect(new ContextOperations(homes).get(value.id)).toEqual(value);
});
