import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConversationIndexSchema, ConversationSchema, DecisionIndexSchema, DecisionRecordSchema, DeviceSchema, Homes, IndexReceiptSchema, OverrideRecordSchema, SecretRedactor, conversationIndex, decisionIndex, indexKind, type IndexDocument, type IndexUpdate } from '../packages/core/dist/index.js';
import { HubDatabase, HubIndexes, HubUnavailable, MemberHubClient, MemberIndexes, joinHub } from '../packages/mesh/dist/index.js';
import { ConversationLedger, ConversationWork, IndexDelivery } from '../packages/conversations/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string;
const deliveries: IndexDelivery[] = [];
const at = '2026-09-24T12:00:00Z';
const update = (document: IndexDocument, eventId = 1): IndexUpdate => ({ schema: 'index-update-v1', eventId, document });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-mesh-indexes-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', hub.document.id, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
});
afterEach(async () => { await Promise.all(deliveries.splice(0).map(delivery => delivery.close())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  const indexes = new MemberIndexes(client); const delivery = new IndexDelivery(indexes); deliveries.push(delivery);
  return { client, indexes, delivery };
}
function workFor(id = 'conversation', deviceId = 'left') {
  const homes = new Homes(join(root, `${deviceId}-home`), join(root, 'user'));
  const work = new ConversationWork(new ConversationLedger(homes, id), 24);
  work.create({ title: 'Shared title', projectId: 'project', ownerDeviceId: deviceId }); work.message('Private request stays on its owner.', 'message');
  return { work, homes };
}
function decision(conversationId = 'conversation') {
  return DecisionRecordSchema.parse({ schema: 'decision-v2', id: 'decision', conversationId, workId: 'work', n: 1, generation: 1, trigger: 'resume', at, latencyMs: 1,
    action: { chosen: 'reply', source: 'manual', allowed: ['reply'], probabilities: { reply: 1 } }, model: { chosen: 'model', source: 'manual', eligible: [{ modelId: 'model' }], excluded: [] },
    effort: { requested: 'high', effective: 'high', source: 'manual' }, context: { project: 'Detailed local context', action: 'reply', changeSize: 'small', riskyAreasTouched: [] },
    memory: { candidates: ['private-note'], chosen: ['private-note'], source: 'search-rank' }, correctionsShown: [], notices: [] });
}
function correction(id = 'correction') {
  return OverrideRecordSchema.parse({ schema: 'override-v1', id, request: { schema: 'correct-step-v1', clientRequestId: id, generation: 1, stretch: 1, mode: 'noted', choices: { effort: 'high' } }, conversationId: 'conversation', projectId: 'project', workId: 'work', decisionId: 'decision', at, action: 'reply', context: 'reply in Fixture, small change', changes: [{ field: 'effort', from: 'low', to: 'high' }] });
}

test('members read slim shared indexes while requests, memory selection and detailed decisions remain owner-local', async () => {
  const left = await member('left'); const right = await member('right'); const { work, homes } = workFor();
  const full = decision(); work.ledger.append({ type: 'decision', data: full });
  await left.indexes.publish(update(conversationIndex(work.load().conversation), 2)); await left.indexes.publish(update(decisionIndex(full), 3)); await left.indexes.publish(update(correction(), 4));
  expect(await right.indexes.conversations()).toEqual([conversationIndex(work.load().conversation)]); expect(await right.indexes.corrections()).toEqual([correction()]);
  const shared = JSON.stringify(app.hub.db.prepare("SELECT document FROM documents WHERE namespace IN ('conversations','decisions','overrides','index-cursors')").all());
  expect(shared).not.toContain('Private request'); expect(shared).not.toContain('private-note'); expect(shared).not.toContain('Detailed local context'); expect(shared).not.toContain('probabilities');
  expect(work.load().conversation.work?.request).toBe('Private request stays on its owner.'); expect(work.ledger.data(work.ledger.events().at(-1)!)).toEqual(full);
  expect(existsSync(homes.at('hub'))).toBe(false);
  expect(() => left.client.indexes({ schema: 'index-request-v1', operation: 'publish', update: { ...update(conversationIndex(work.load().conversation)), document: work.load().conversation } })).toThrow();
});

test('owner and ledger sequence govern updates, including delayed requests, replay and identifier collisions', async () => {
  const left = await member('left'); const right = await member('right'); const { work } = workFor(); const original = conversationIndex(work.load().conversation);
  await left.indexes.publish(update(original, 2));
  await expect(right.indexes.publish(update({ ...original, ownerDeviceId: 'right' }, 3))).rejects.toMatchObject({ status: 403 });
  await expect(right.indexes.publish(update(decisionIndex(decision()), 3))).rejects.toMatchObject({ status: 403 });
  await expect(left.indexes.publish(update({ ...original, projectId: 'other' }, 3))).rejects.toMatchObject({ status: 403 });
  const newer = { ...original, title: 'Newest title', updatedAt: '2020-01-01T00:00:00Z' };
  await left.indexes.publish(update(newer, 8)); const revision = app.hub.get('conversations', original.id, ConversationIndexSchema)!.revision;
  expect((await left.indexes.publish(update(original, 2))).eventId).toBe(8); await left.indexes.publish(update(newer, 8));
  expect(app.hub.get('conversations', original.id, ConversationIndexSchema)!.revision).toBe(revision); expect((await right.indexes.conversations())[0]!.title).toBe('Newest title');
  await expect(left.indexes.publish(update({ ...newer, title: 'Conflicting replay' }, 8))).rejects.toMatchObject({ status: 409 });
  await left.indexes.publish(update(decisionIndex(decision()), 9)); await left.indexes.publish(update({ ...newer, id: 'another' }, 10));
  await expect(left.indexes.publish(update(decisionIndex(decision('another')), 11))).rejects.toMatchObject({ status: 403 });
});

test('shared lists cross HTTP page boundaries without duplicates', async () => {
  const left = await member('left'); const { work } = workFor(); const hub = new HubIndexes(app.hub, 'left');
  hub.publish(update(conversationIndex(work.load().conversation), 2));
  for (let i = 0; i < 103; i++) { hub.publish(update({ ...conversationIndex(work.load().conversation), id: `list_${String(i).padStart(3, '0')}` })); hub.publish(update(correction(`correction_${String(i).padStart(3, '0')}`), i + 3)); }
  expect(new Set((await left.indexes.conversations()).map(record => record.id)).size).toBe(104); expect((await left.indexes.corrections()).map(record => record.id)).toEqual(Array.from({ length: 103 }, (_, i) => `correction_${String(i).padStart(3, '0')}`));
});

test('a failed acknowledgement write rolls back its index so retry cannot skip missing data', async () => {
  const left = await member('left'); const { work } = workFor(); const document = conversationIndex(work.load().conversation);
  const put = app.hub.put.bind(app.hub);
  const failure = vi.spyOn(app.hub, 'put').mockImplementation((namespace, ...args) => {
    if (namespace === 'index-cursors') throw new Error('Fixture acknowledgement write failed');
    return put(namespace, ...args);
  });
  await expect(left.indexes.publish(update(document, 2))).rejects.toThrow();
  expect(app.hub.get('conversations', document.id, ConversationIndexSchema)).toBeNull();
  failure.mockRestore(); await left.indexes.publish(update(document, 2)); expect(await left.indexes.conversations()).toEqual([document]);
});

test('a lost successful reply is retried without duplicate records and pending indexes can be rebuilt from the ledger', async () => {
  let lose = true;
  const left = await member('left', async (...args) => { const response = await fetch(...args); if (lose && String(args[0]).endsWith('/indexes')) { lose = false; await response.body?.cancel(); throw new Error('Fixture lost reply'); } return response; });
  const { work, homes } = workFor(); const initial = update(conversationIndex(work.load().conversation), work.ledger.events().at(-1)!.id);
  left.delivery.enqueue(initial); await expect(left.delivery.flush()).rejects.toBeInstanceOf(HubUnavailable);
  const revision = app.hub.get('conversations', 'conversation', ConversationIndexSchema)!.revision;
  await left.delivery.close();
  const recovered = new ConversationWork(new ConversationLedger(homes, 'conversation'), 24); const delivery = new IndexDelivery(left.indexes); deliveries.push(delivery);
  delivery.enqueue(update(conversationIndex(recovered.load().conversation), recovered.ledger.events().at(-1)!.id)); await delivery.flush();
  expect(app.hub.get('conversations', 'conversation', ConversationIndexSchema)!.revision).toBe(revision); expect(await left.indexes.conversations()).toEqual([initial.document]);
});

test('slow delivery does not stop owner writes and acknowledging an older in-flight update cannot erase its replacement', async () => {
  const left = await member('left'); const { work } = workFor(); const arrived = deferred(); const release = deferred(); let first = true;
  const delivery = new IndexDelivery({ ...left.indexes, conversations: () => left.indexes.conversations(), corrections: () => left.indexes.corrections(), publish: async input => {
    if (first) { first = false; arrived.resolve(); await release.promise; } return left.indexes.publish(input);
  } }); deliveries.push(delivery);
  delivery.enqueue(update(conversationIndex(work.load().conversation), 2)); const flushing = delivery.flush(); await arrived.promise;
  try {
    work.rename({ schema: 'rename-conversation-v1', clientRequestId: 'rename', previousTitle: 'Shared title', title: 'New title during delivery' }); work.message('Additional owner-local message.', 'later_message');
    delivery.enqueue(update(conversationIndex(work.load().conversation), work.ledger.events().at(-1)!.id)); expect(work.load().messages).toHaveLength(2);
  } finally { release.resolve(); }
  await flushing; expect((await left.indexes.conversations())[0]!.title).toBe('New title during delivery');
});

test('hub outages refuse authoritative reads and retrying delivery recovers without a member database', async () => {
  let offline = false; const left = await member('left', async (...args) => { if (offline) throw new Error('Fixture offline'); return fetch(...args); }); const { work, homes } = workFor();
  offline = true; left.delivery.enqueue(update(conversationIndex(work.load().conversation), 2)); await expect(left.delivery.flush()).rejects.toBeInstanceOf(HubUnavailable);
  await expect(left.indexes.conversations()).rejects.toBeInstanceOf(HubUnavailable); await expect(left.indexes.corrections()).rejects.toBeInstanceOf(HubUnavailable);
  expect(work.load().conversation.work?.request).toContain('Private request'); expect(existsSync(homes.at('hub'))).toBe(false);
  offline = false; await left.delivery.flush(); expect(await left.indexes.conversations()).toHaveLength(1);
});

test('a failed periodic delivery retries without another user action, while close prevents future retries', async () => {
  const { work } = workFor(); const document = conversationIndex(work.load().conversation); const publish = vi.fn(async (input: IndexUpdate) => IndexReceiptSchema.parse({ schema: 'index-receipt-v1', id: input.document.id, kind: indexKind(input.document), eventId: input.eventId }));
  publish.mockRejectedValueOnce(new Error('Fixture outage'));
  const delivery = new IndexDelivery({ publish, conversations: () => [], corrections: () => [] }, 10); deliveries.push(delivery); delivery.enqueue(update(document, 2));
  await expect(delivery.flush()).rejects.toThrow('outage'); await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  await delivery.close(); delivery.enqueue(update({ ...document, title: 'After closure' }, 3)); await delivery.flush(); expect(publish).toHaveBeenCalledTimes(2);
});

test('legacy full hub records migrate atomically into slim indexes without touching owner ledgers', async () => {
  const homes = new Homes(join(root, 'migration'), join(root, 'user')); const { work } = workFor(); const conversation = work.load().conversation; const full = decision();
  let hub = new HubDatabase(homes, 'hub'); hub.put('conversations', conversation.id, ConversationSchema, conversation, 0); hub.put('decisions', full.id, DecisionRecordSchema, full, 0); hub.close();
  hub = new HubDatabase(homes, 'hub'); expect(hub.get('conversations', conversation.id, ConversationIndexSchema)?.document).toEqual(conversationIndex(conversation)); expect(hub.get('decisions', full.id, DecisionIndexSchema)?.document).toEqual(decisionIndex(full)); hub.close();
  const db = new DatabaseSync(homes.at('hub', 'jevellan.db'));
  db.prepare("UPDATE documents SET document=? WHERE namespace='conversations'").run(JSON.stringify(conversation)); db.prepare("UPDATE documents SET document=? WHERE namespace='decisions'").run(JSON.stringify({ schema: 'broken-fixture' })); db.close();
  expect(() => new HubDatabase(homes, 'hub')).toThrow();
  const after = new DatabaseSync(homes.at('hub', 'jevellan.db')); expect(JSON.parse(String(after.prepare("SELECT document FROM documents WHERE namespace='conversations'").get()!.document))).toEqual(conversation); after.close();
  expect(work.load().conversation.work?.request).toContain('Private request');
});
