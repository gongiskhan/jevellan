// The conversation ledger's invariants hold for project ledgers (design 5.2.11): listener timing, rolling, spill, redaction,
// interrupted writes, corruption, aliases and lock recovery, plus payload validation per event type (D2, D99, D100).
import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor } from '../packages/core/dist/index.js';
import { BLOB_SPILL_BYTES, ConversationLedger, JsonlLedger } from '../packages/conversations/dist/index.js';
import { ProjectLedger, ProjectLedgers, ProjectPaths, publicProjectData } from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let paths: ProjectPaths;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-project-ledger-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); paths = new ProjectPaths(homes); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const said = (text: string) => ({ schema: 'coordinator-text-v1', text });
const notice = (text: string) => ({ type: 'notice' as const, data: { schema: 'project-notice-v1', text, kind: 'info' } });
const deadPid = () => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));

test('project ledgers are generic ledgers in the coordinator and thread folders, and notify outside the append lock', async () => {
  const coordinator = new ProjectLedger(paths, 'proj_a'); const thread = new ProjectLedger(paths, 'proj_a', 'thread_a');
  expect(coordinator).toBeInstanceOf(JsonlLedger);
  expect(coordinator.dir).toBe(join(homes.root, 'projects', 'proj_a')); expect(thread.dir).toBe(join(homes.root, 'projects', 'proj_a', 'threads', 'thread_a'));
  const seen: number[] = []; let brokenCalls = 0;
  coordinator.subscribe(() => { brokenCalls++; throw new Error('Disconnected viewer'); });
  const unsubscribe = coordinator.subscribe((event) => {
    seen.push(event.id); expect(coordinator.read(`ledger/${event.id}`)).toEqual(event);
    if (event.id === 1) coordinator.append({ type: 'coordinator-text', data: said('Written by the callback after the first lock was released.') });
  });
  coordinator.append({ type: 'coordinator-text', turn: 1, data: said('Durable first') }); expect(seen).toEqual([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(seen).toEqual([1, 2]); expect(brokenCalls).toBe(1);
  unsubscribe(); coordinator.append(notice('After disconnect')); await Promise.resolve(); expect(seen).toEqual([1, 2]);
  // A thread ledger is its own sequence; the coordinator folder holds only its ledger, blobs and the threads.
  expect(thread.append(notice('Thread first')).id).toBe(1);
  expect(readdirSync(coordinator.dir).sort()).toEqual(['blobs', 'ledger', 'threads']);
  expect(readdirSync(thread.dir).sort()).toEqual(['blobs', 'ledger']);
  // One instance per directory, so stream subscribers see every writer.
  const ledgers = new ProjectLedgers(paths);
  expect(ledgers.coordinator('proj_a')).toBe(ledgers.coordinator('proj_a')); expect(ledgers.thread('proj_a', 'thread_a')).toBe(ledgers.thread('proj_a', 'thread_a'));
  expect(ledgers.thread('proj_a', 'thread_a')).not.toBe(ledgers.coordinator('proj_a'));
});

test('independent handles roll segments, keep ids contiguous and never rewrite a closed segment', () => {
  const a = new ProjectLedger(paths, 'proj_a', undefined, { rollBytes: 400 }); const b = new ProjectLedger(paths, 'proj_a', undefined, { rollBytes: 400 });
  a.append({ type: 'coordinator-text', data: said('first') }); b.append({ type: 'coordinator-text', data: said('second') });
  for (let i = 0; i < 30; i++) a.append({ type: 'coordinator-text', data: said(`item ${i}`) });
  expect(a.segments().length).toBeGreaterThan(2);
  const first = readFileSync(a.segments()[0]!);
  b.append({ type: 'coordinator-text', data: said('last') });
  expect(readFileSync(a.segments()[0]!)).toEqual(first);
  expect(a.events().map((event) => event.id)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
  expect(b.events(31, 1).map((event) => event.id)).toEqual([32]);
  expect(new ProjectLedger(paths, 'proj_a').events(32)[0]?.data).toEqual(said('last'));
  expect(a.lastId()).toBe(33);
});

test('large payloads spill to verified, deduplicated blobs and read back through the typed payload', () => {
  const ledger = new ProjectLedger(paths, 'proj_a'); const content = said(`${'é'.repeat(BLOB_SPILL_BYTES)} exact-needle`);
  const a = ledger.append({ type: 'coordinator-text', data: content }); const b = ledger.append({ type: 'coordinator-text', data: content });
  expect(a.data).toEqual(b.data); expect(a.data).toMatchObject({ schema: 'blob-ref-v1' });
  expect(readdirSync(join(ledger.dir, 'blobs'))).toHaveLength(1);
  expect(ledger.payload(a as typeof a & { type: 'coordinator-text' })).toEqual(content);
  expect(ledger.search('exact-needle')[0]?.pointer).toBe('ledger/1');
  expect(ledger.read('ledger/1')).toMatchObject({ data: content });
  const ref = (a.data as { ref: string }).ref;
  writeFileSync(join(ledger.dir, ref), '{}'); expect(() => ledger.read(ref)).toThrow('integrity');
});

test('credentials are redacted before the ledger and its blobs are written', () => {
  const redactor = new SecretRedactor(); const secret = ['fixture', 'project', 'sensitive'].join('-'); redactor.add(secret);
  const ledger = new ProjectLedger(paths, 'proj_a', 'thread_a', { redactor });
  ledger.append({ type: 'coordinator-text', data: said(`${secret}${'z'.repeat(BLOB_SPILL_BYTES)}`) });
  ledger.append(notice(`Token ${secret} seen.`));
  ledger.putBlob({ stdout: secret, stderr: '' });
  for (const directory of ['ledger', 'blobs']) for (const name of readdirSync(join(ledger.dir, directory))) expect(readFileSync(join(ledger.dir, directory, name), 'utf8')).not.toContain(secret);
  expect(ledger.events()[1]!.data).toMatchObject({ text: 'Token [redacted] seen.' });
});

test('an interrupted trailing write is kept and later ids stay contiguous; corrupt records and missing segments stop the writer', () => {
  const ledger = new ProjectLedger(paths, 'proj_a'); ledger.append(notice('acknowledged'));
  const first = ledger.segments()[0]!; appendFileSync(first, '{"schema":"project-ledger-event-v1","id":2');
  const before = readFileSync(first);
  expect(ledger.events()).toHaveLength(1);
  expect(ledger.append(notice('after restart')).id).toBe(2);
  expect(readFileSync(first)).toEqual(before); expect(ledger.segments()).toHaveLength(2);
  expect(ledger.events().map((event) => event.id)).toEqual([1, 2]);
  const corrupt = new ProjectLedger(paths, 'proj_corrupt'); corrupt.append(notice('first'));
  appendFileSync(corrupt.segments()[0]!, '{bad json}\n');
  expect(() => corrupt.events()).toThrow('Project ledger contains an invalid record.');
  expect(() => corrupt.append(notice('second'))).toThrow('Project ledger contains an invalid record.');
  // A record in another ledger's envelope is invalid here too.
  const foreign = new ProjectLedger(paths, 'proj_foreign'); foreign.append(notice('first'));
  appendFileSync(foreign.segments()[0]!, `${JSON.stringify({ schema: 'ledger-event-v1', t: new Date().toISOString(), id: 2, type: 'text', data: 'conversation' })}\n`);
  expect(() => foreign.events()).toThrow('Project ledger contains an invalid record.');
  const missing = new ProjectLedger(paths, 'proj_missing', undefined, { rollBytes: 1 });
  missing.append(notice('one')); missing.append(notice('two')); unlinkSync(missing.segments()[0]!);
  expect(() => missing.events()).toThrow('Project ledger segment is missing.');
});

test('payloads are validated per event type, unknown types are refused both ways, and views drop native session ids', () => {
  const ledger = new ProjectLedger(paths, 'proj_a', 'thread_a');
  expect(() => ledger.append({ type: 'unknown', data: {} } as never)).toThrow();
  expect(() => ledger.append({ type: 'thread-state', data: { schema: 'thread-state-v1', from: null, to: 'invented', changed: [] } })).toThrow();
  expect(() => ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', text: 'Extra field.', kind: 'info', extra: true } })).toThrow();
  // Coordinator tool lines must name a bridge tool (D99).
  const line = (tool: string) => ({ type: 'coordinator-tool' as const, data: { schema: 'coordinator-tool-v1', tool, ok: true, summary: 'Started a thread.' } });
  expect(() => ledger.append(line('rm_everything'))).toThrow();
  expect(ledger.append(line('jevellan_thread_start')).id).toBe(1);
  expect(ledger.lastId()).toBe(1);
  // The conversation ledger keeps refusing project event types.
  expect(() => new ConversationLedger(homes, 'conversation').append({ type: 'thread-report', data: {} } as never)).toThrow();
  expect(() => new ConversationLedger(homes, 'conversation').append({ type: 'coordinator-text', data: said('x') } as never)).toThrow();
  expect(publicProjectData({ thread: { nativeSessionId: 'abc', state: 'idle' }, list: [{ nativeSessionId: 'def', id: 'x' }] })).toEqual({ thread: { state: 'idle' }, list: [{ id: 'x' }] });
});

test('ids and folders cannot escape or alias the projects home', () => {
  expect(() => new ProjectLedger(paths, '../escape')).toThrow();
  expect(() => new ProjectLedger(paths, 'proj_a', '../../escape')).toThrow();
  const ledger = new ProjectLedger(paths, 'proj_a'); ledger.append(notice('first'));
  expect(() => ledger.read('blobs/../../outside')).toThrow();
  expect(() => ledger.read('handoffs/1')).toThrow('Project pointer does not exist.');
  const outside = join(root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(ledger.dir, 'blobs', 'a'.repeat(64)));
  expect(() => ledger.read(`blobs/${'a'.repeat(64)}`)).toThrow('alias');
  symlinkSync(ledger.dir, join(homes.root, 'projects', 'proj_alias'));
  expect(() => new ProjectLedger(paths, 'proj_alias')).toThrow('Project files cannot alias another location.');
  // A thread folder linked to another thread's folder, or out of the home, is refused.
  const other = new ProjectLedger(paths, 'proj_a', 'thread_other'); other.append(notice('first'));
  symlinkSync(other.dir, join(ledger.dir, 'threads', 'thread_alias'));
  expect(() => new ProjectLedger(paths, 'proj_a', 'thread_alias')).toThrow('Project files cannot alias another location.');
  symlinkSync(outside, join(ledger.dir, 'threads', 'thread_out'));
  expect(() => new ProjectLedger(paths, 'proj_a', 'thread_out')).toThrow('Path escapes the Jevellan home.');
});

test('startup recovers dead writers on every coordinator and thread ledger but never steals a live append lock', () => {
  const coordinator = new ProjectLedger(paths, 'proj_a'); const thread = new ProjectLedger(paths, 'proj_a', 'thread_a');
  coordinator.append(notice('first')); thread.append(notice('first'));
  const coordinatorLock = join(coordinator.dir, '.append-lock'); const threadLock = join(thread.dir, '.append-lock');
  writeFileSync(coordinatorLock, JSON.stringify({ schema: 'ledger-lock-v1', pid: process.pid }));
  expect(() => coordinator.append(notice('second'))).toThrow('Project ledger is locked by another writer; recover it at owner startup.');
  expect(() => coordinator.recoverAbandonedWrite()).toThrow('Project ledger writer is still alive.');
  expect(() => new ProjectLedgers(paths).recoverAll()).toThrow('Project ledger writer is still alive.');
  const pid = deadPid();
  for (const lock of [coordinatorLock, threadLock]) writeFileSync(lock, JSON.stringify({ schema: 'ledger-lock-v1', pid }));
  new ProjectLedgers(paths).recoverAll();
  expect(existsSync(coordinatorLock)).toBe(false); expect(existsSync(threadLock)).toBe(false);
  expect(coordinator.append(notice('second')).id).toBe(2); expect(thread.append(notice('second')).id).toBe(2);
});
