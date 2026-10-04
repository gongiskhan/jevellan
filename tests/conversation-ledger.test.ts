import { afterEach, beforeEach, expect, test } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { HandoffSchema, Homes, SecretRedactor, StretchSchema } from '../packages/core/dist/index.js';
import { BLOB_SPILL_BYTES, ConversationLedger, JsonlLedger, type LedgerSpec } from '../packages/conversations/dist/index.js';

let root: string; let homes: Homes;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-ledger-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const start = (ledger: ConversationLedger, n = 1) => ledger.append({ type: 'stretch-start', stretch: n, data: StretchSchema.parse({ schema: 'stretch-v2', n, workId: 'work', action: 'plan', modelId: 'model', runtime: 'codex', model: 'model', effortRequested: 'high', effortEffective: 'high', accountId: 'account', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }) });
const handoff = () => HandoffSchema.parse({ schema: 'handoff-v2', stretch: 1, action: 'plan', status: 'done', summary: 'A full plan is attached.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [] });

test('durable notifications run outside the append lock and a failed viewer cannot stop the writer', async () => {
  const ledger = new ConversationLedger(homes, 'notifications'); const seen: number[] = []; let brokenCalls = 0;
  ledger.subscribe(() => { brokenCalls++; throw new Error('Disconnected viewer'); });
  const unsubscribe = ledger.subscribe((event) => {
    seen.push(event.id); expect(ledger.read(`ledger/${event.id}`)).toEqual(event);
    if (event.id === 1) ledger.append({ type: 'notice', data: 'Written by the callback after the first lock was released.' });
  });
  ledger.append({ type: 'text', data: 'Durable first' }); expect(seen).toEqual([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(seen).toEqual([1, 2]); expect(brokenCalls).toBe(1);
  unsubscribe(); ledger.append({ type: 'text', data: 'After disconnect' }); await Promise.resolve(); expect(seen).toEqual([1, 2]);
});

test('adapted Garrison ordering and rolling: independent owner handles retain ids and immutable segments', () => {
  const a = new ConversationLedger(homes, 'conversation', { rollBytes: 400 }); const b = new ConversationLedger(homes, 'conversation', { rollBytes: 400 });
  a.append({ type: 'text', data: { text: 'first' } }); b.append({ type: 'text', data: { text: 'second' } });
  for (let i = 0; i < 30; i++) a.append({ type: 'text', data: { text: `item ${i}` } });
  expect(a.segments().length).toBeGreaterThan(2);
  const first = readFileSync(a.segments()[0]!);
  b.append({ type: 'text', data: { text: 'last' } });
  expect(readFileSync(a.segments()[0]!)).toEqual(first);
  expect(a.events().map((event) => event.id)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
  expect(b.events(31, 1).map((event) => event.id)).toEqual([32]);
  expect(new ConversationLedger(homes, 'conversation').events(32)[0]?.data).toEqual({ text: 'last' });
});
test('adapted Garrison spill: large UTF-8 payloads are preserved, deduplicated, searchable and verified', () => {
  const ledger = new ConversationLedger(homes, 'conversation'); const content = { text: 'é'.repeat(BLOB_SPILL_BYTES) + ' exact-needle' };
  const a = ledger.append({ type: 'text', data: content }); const b = ledger.append({ type: 'text', data: content });
  expect(a.data).toEqual(b.data); expect(readdirSync(join(ledger.dir, 'blobs'))).toHaveLength(1);
  expect(ledger.data(a)).toEqual(content); expect(ledger.search('exact-needle')[0]?.pointer).toBe('ledger/1');
  expect(ledger.read('ledger/1')).toMatchObject({ data: content });
  const ref = (a.data as { ref: string }).ref;
  writeFileSync(join(ledger.dir, ref), '{}'); expect(() => ledger.read(ref)).toThrow('integrity');
});
test('redacts before ledger, blob and handoff persistence', () => {
  const redactor = new SecretRedactor(); const secret = ['fixture', 'only', 'sensitive'].join('-'); redactor.add(secret);
  const ledger = new ConversationLedger(homes, 'conversation', { redactor });
  ledger.append({ type: 'text', data: { text: secret + 'z'.repeat(BLOB_SPILL_BYTES) } });
  start(ledger); ledger.acceptHandoff({ ...handoff(), summary: secret });
  for (const directory of ['ledger', 'blobs', 'handoffs']) for (const name of readdirSync(join(ledger.dir, directory))) expect(readFileSync(join(ledger.dir, directory, name), 'utf8')).not.toContain(secret);
});
test('an interrupted trailing write is preserved and subsequent complete ids remain contiguous', () => {
  const ledger = new ConversationLedger(homes, 'conversation'); ledger.append({ type: 'text', data: 'acknowledged' });
  const first = ledger.segments()[0]!; appendFileSync(first, '{"schema":"ledger-event-v1","id":2');
  const before = readFileSync(first);
  expect(ledger.events()).toHaveLength(1);
  expect(ledger.append({ type: 'notice', data: 'after restart' }).id).toBe(2);
  expect(readFileSync(first)).toEqual(before); expect(ledger.segments()).toHaveLength(2);
  expect(ledger.events().map((event) => event.id)).toEqual([1, 2]);
});
test('complete corrupt records and missing segments stop the writer instead of silently skipping history', () => {
  const ledger = new ConversationLedger(homes, 'corrupt'); ledger.append({ type: 'text', data: 'first' });
  appendFileSync(ledger.segments()[0]!, '{bad json}\n');
  expect(() => ledger.events()).toThrow('invalid record'); expect(() => ledger.append({ type: 'text', data: 'second' })).toThrow('invalid record');
  const missing = new ConversationLedger(homes, 'missing', { rollBytes: 1 });
  missing.append({ type: 'text', data: 1 }); missing.append({ type: 'text', data: 2 }); unlinkSync(missing.segments()[0]!);
  expect(() => missing.events()).toThrow('segment is missing');
});
test('handoffs are current-stretch guarded, immutable and idempotent after restart', () => {
  const ledger = new ConversationLedger(homes, 'conversation');
  expect(() => ledger.acceptHandoff(handoff())).toThrow('current stretch'); start(ledger);
  expect(() => ledger.acceptHandoff({ ...handoff(), action: 'implement' })).toThrow('action');
  const result = ledger.putBlob('# Complete plan\nKeep every step and evidence reference.');
  const raw = { ...handoff(), result: { type: 'plan', ref: result.ref } };
  const first = ledger.acceptHandoff(raw); expect(first.repeated).toBe(false);
  ledger.append({ type: 'stretch-end', stretch: 1, data: { status: 'completed' } });
  const reopened = new ConversationLedger(homes, 'conversation');
  expect(reopened.acceptHandoff(raw)).toEqual({ ...first, repeated: true });
  expect(() => reopened.acceptHandoff({ ...raw, summary: 'Rewritten output' })).toThrow('already handed off');
  expect(reopened.handoffs()).toHaveLength(1); expect(reopened.read(result.ref)).toContain('every step');
});
test('recovers a handoff committed before its materialised file, without accepting a new handoff', () => {
  const ledger = new ConversationLedger(homes, 'conversation'); start(ledger); ledger.acceptHandoff(handoff());
  const file = join(ledger.dir, 'handoffs/0001.json'); unlinkSync(file);
  new ConversationLedger(homes, 'conversation').recoverHandoffs();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(handoff()); expect(ledger.handoffs()).toHaveLength(1);
  writeFileSync(file, JSON.stringify({ ...handoff(), summary: 'unauthorised replacement' }));
  expect(() => ledger.recoverHandoffs()).toThrow('Immutable handoff');
});
test('refuses traversal, aliases, unknown documents and oversized search result sets', () => {
  expect(() => new ConversationLedger(homes, '../escape')).toThrow();
  const ledger = new ConversationLedger(homes, 'conversation');
  for (let i = 0; i < 23; i++) ledger.append({ type: 'text', data: `needle ${i}` });
  expect(ledger.search('needle')).toHaveLength(20);
  expect(() => ledger.read('blobs/../../outside')).toThrow();
  expect(() => ledger.append({ type: 'unknown', data: {} } as never)).toThrow();
  const outside = join(root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(ledger.dir, 'blobs', 'a'.repeat(64)));
  expect(() => ledger.read(`blobs/${'a'.repeat(64)}`)).toThrow('alias');
  symlinkSync(ledger.dir, homes.at('conversations', 'alias'));
  expect(() => new ConversationLedger(homes, 'alias')).toThrow('alias');
});
test('owner startup can recover a dead writer but never steals a live append lock', () => {
  const ledger = new ConversationLedger(homes, 'conversation'); ledger.append({ type: 'text', data: 'first' });
  const lock = join(ledger.dir, '.append-lock');
  writeFileSync(lock, JSON.stringify({ schema: 'ledger-lock-v1', pid: process.pid }));
  expect(() => ledger.append({ type: 'text', data: 'second' })).toThrow('another writer');
  expect(() => ledger.recoverAbandonedWrite()).toThrow('still alive');
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  writeFileSync(lock, JSON.stringify({ schema: 'ledger-lock-v1', pid }));
  ledger.recoverAbandonedWrite(); expect(existsSync(lock)).toBe(false);
  expect(ledger.append({ type: 'text', data: 'second' }).id).toBe(2);
});

const TestEventSchema = z.strictObject({ schema: z.literal('test-ledger-event-v1'), t: z.iso.datetime(), id: z.number().int().positive(), type: z.enum(['opened', 'noted']), turn: z.number().int().positive().optional(), data: z.unknown() });
type TestEvent = z.infer<typeof TestEventSchema>;
const testLedger: LedgerSpec<TestEvent> = { schema: TestEventSchema, literal: 'test-ledger-event-v1', label: 'Project', folders: ['', 'ledger', 'blobs'] };
const at = '2026-10-03T10:00:00.000Z';

test('a generic ledger keeps the segment, blob and lock format under its own envelope, folders and error prefix', async () => {
  const dir = homes.at('projects', 'project'); const ledger = new JsonlLedger(dir, testLedger, { now: () => at, rollBytes: 400 });
  expect(ledger.events()).toEqual([]); expect(ledger.lastId()).toBe(0); expect(existsSync(dir)).toBe(false);
  const seen: TestEvent[] = []; ledger.subscribe((event) => seen.push(event));
  const opened = ledger.append({ type: 'opened', turn: 1, data: { text: 'first' } });
  expect(opened).toEqual({ type: 'opened', turn: 1, data: { text: 'first' }, schema: 'test-ledger-event-v1', id: 1, t: at });
  expect(readFileSync(ledger.segments()[0]!, 'utf8')).toBe(`${JSON.stringify(opened)}\n`);
  const content = { text: 'é'.repeat(BLOB_SPILL_BYTES) + ' spilled-needle' };
  const spilled = ledger.append({ type: 'noted', data: content });
  expect(spilled.data).toMatchObject({ schema: 'blob-ref-v1' }); expect(ledger.data(spilled)).toEqual(content);
  expect(ledger.read('ledger/2')).toMatchObject({ id: 2, data: content }); expect(ledger.search('spilled-needle')[0]?.pointer).toBe('ledger/2');
  expect(JSON.parse(readFileSync(join(dir, (spilled.data as { ref: string }).ref), 'utf8'))).toMatchObject({ schema: 'conversation-blob-v1' });
  for (let i = 0; i < 5; i++) ledger.append({ type: 'noted', data: { text: `item ${i}` } });
  expect(ledger.segments().length).toBeGreaterThan(1); expect(ledger.lastId()).toBe(7);
  expect(new JsonlLedger(dir, testLedger).events(6).map((event) => event.id)).toEqual([7]);
  expect(readdirSync(dir).sort()).toEqual(['blobs', 'ledger']);
  await new Promise<void>((resolve) => setImmediate(resolve)); expect(seen.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(() => ledger.append({ type: 'opened', data: { text: 'later' }, stretch: 1 } as never)).toThrow();
  expect(() => ledger.append({ type: 'unknown', data: {} } as never)).toThrow(); expect(ledger.lastId()).toBe(7);
  expect(() => ledger.read('handoffs/1')).toThrow('Project pointer does not exist.');
  expect(() => ledger.read('ledger/8')).toThrow('Project pointer does not exist.');
  expect(() => ledger.readBlob('blobs/short')).toThrow('Invalid project blob reference.');
  const lock = join(dir, '.append-lock'); writeFileSync(lock, JSON.stringify({ schema: 'ledger-lock-v1', pid: process.pid }));
  expect(() => ledger.append({ type: 'noted', data: 'locked' })).toThrow('Project ledger is locked by another writer; recover it at owner startup.');
  expect(() => ledger.recoverAbandonedWrite()).toThrow('Project ledger writer is still alive.'); unlinkSync(lock);
  appendFileSync(ledger.segments().at(-1)!, '{bad json}\n');
  expect(() => ledger.events()).toThrow('Project ledger contains an invalid record.'); expect(() => ledger.lastId()).toThrow('Project ledger contains an invalid record.');
  expect(() => ledger.append({ type: 'noted', data: 'after corruption' })).toThrow('Project ledger contains an invalid record.');
  unlinkSync(ledger.segments()[0]!); expect(() => ledger.events()).toThrow('Project ledger segment is missing.');
});
test('a generic ledger refuses relative and aliased directories', () => {
  expect(() => new JsonlLedger('relative/ledger', testLedger)).toThrow('Project directories cannot alias another location.');
  const real = homes.ensure('projects', 'real'); symlinkSync(real, join(homes.root, 'projects', 'alias'));
  expect(() => new JsonlLedger(join(homes.root, 'projects', 'alias'), testLedger)).toThrow('Project directories cannot alias another location.');
  const ledger = new JsonlLedger(real, testLedger); ledger.append({ type: 'opened', data: 'ok' });
  symlinkSync(join(root, 'user'), join(real, 'blobs', 'b'.repeat(64)));
  expect(() => ledger.read(`blobs/${'b'.repeat(64)}`)).toThrow('Project files cannot alias another location.');
});
test('conversation ledgers are generic ledgers with their exact error texts and folders', () => {
  const ledger = new ConversationLedger(homes, 'conversation'); expect(ledger).toBeInstanceOf(JsonlLedger);
  expect(ledger.dir).toBe(join(homes.root, 'conversations', 'conversation')); expect(ledger.id).toBe('conversation'); expect(ledger.lastId()).toBe(0);
  ledger.append({ type: 'text', stretch: 1, data: 'first' }); expect(ledger.lastId()).toBe(1);
  expect(readdirSync(ledger.dir).sort()).toEqual(['blobs', 'handoffs', 'ledger']);
  expect(() => ledger.read('handoffs/1')).toThrow(/^Conversation pointer does not exist\.$/);
  expect(() => ledger.read('ledger/2')).toThrow(/^Conversation pointer does not exist\.$/);
  expect(() => ledger.readBlob('blobs/short')).toThrow(/^Invalid conversation blob reference\.$/);
  expect(() => ledger.writeProjection('thread.json', HandoffSchema, {})).toThrow(/^Invalid conversation projection path\.$/);
  writeFileSync(join(ledger.dir, '.append-lock'), JSON.stringify({ schema: 'ledger-lock-v1', pid: process.pid }));
  expect(() => ledger.append({ type: 'text', data: 'locked' })).toThrow(/^Conversation ledger is locked by another writer; recover it at owner startup\.$/);
  expect(() => ledger.recoverAbandonedWrite()).toThrow(/^Conversation ledger writer is still alive\.$/); unlinkSync(join(ledger.dir, '.append-lock'));
  appendFileSync(ledger.segments()[0]!, '{"schema":"ledger-event-v1","t":"2026-10-03T10:00:00.000Z","id":3,"type":"text","data":"gap"}\n');
  expect(() => ledger.events()).toThrow(/^Conversation ledger event sequence is broken\.$/);
  expect(() => new ConversationLedger(homes, 'rolled', { rollBytes: 0 })).toThrow(/^Invalid ledger roll size\.$/);
  expect(() => ledger.events(-1)).toThrow(/^Invalid ledger range\.$/);
});
