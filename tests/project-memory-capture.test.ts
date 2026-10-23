import { afterEach, expect, test } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor, type MemoryCapture } from '../packages/core/dist/index.js';
import { ProjectCaptureQueue } from '../packages/memory/dist/index.js';
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'jv-capture-')); const homes = new Homes(join(directory, 'data'), join(directory, 'user')), redactor = new SecretRedactor();
  redactor.add('fixture-secret-never-share'); const queue = new ProjectCaptureQueue(homes, redactor), home = homes.ensure('homes', 'claude', 'fixture_account'), file = join(home, 'journal.jsonl');
  const source = { projectId: 'fixture', scope: 'thread' as const, threadId: 'thread_fixture', taskId: 'task_fixture', runtime: 'claude', model: 'fixture', sessionId: 'fixture_session', transcriptPath: file };
  return { homes, queue, home, file, source };
}
test('turn and hook capture share byte cursors, keep compaction history and redact across stream chunks', async () => {
  const f = fixture(), text = JSON.stringify({ text: `${'x'.repeat(65500)} fixture-secret-never-share SANDBOX_DATA_DIR is required.` }) + '\n'; writeFileSync(f.file, text);
  const send = async (capture: MemoryCapture, value: string) => f.queue.accept(capture, value);
  await Promise.all([f.queue.capture(f.source, f.home, send), f.queue.capture(f.source, f.home, send)]);
  expect(f.queue.slices('fixture')).toHaveLength(1); expect(f.queue.slices('fixture')[0]!.text).not.toContain('fixture-secret-never-share');
  appendFileSync(f.file, '{"type":"compact_boundary"}\n{"text":"CHANGELOG rule"}');
  await f.queue.capture(f.source, f.home, send);
  appendFileSync(f.file, '\n'); await f.queue.capture(f.source, f.home, send);
  const slices = f.queue.slices('fixture').sort((a,b) => a.capture.fromByte - b.capture.fromByte);
  expect(slices[0]!.capture.fromByte).toBe(0); expect(slices[0]!.capture.toByte).toBe(Buffer.byteLength(text));
  expect(slices[1]!.capture.fromByte).toBe(slices[0]!.capture.toByte); expect(slices[2]!.capture.fromByte).toBe(slices[1]!.capture.toByte);
  const input = f.queue.extractionInput('fixture'); expect(input.text).toContain('CHANGELOG rule'); expect(input.text).toContain('SANDBOX_DATA_DIR');
  f.queue.processed('fixture', input.captures, 'extraction_fixture'); expect(f.queue.slices('fixture')).toHaveLength(0);
});
test('offline delivery leaves its cursor for an identical retry; a shrinking journal never discards the earlier range', async () => {
  const f = fixture(); writeFileSync(f.file, 'First durable record.\n');
  await expect(f.queue.capture(f.source, f.home, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  await f.queue.capture(f.source, f.home, async (capture, text) => f.queue.accept(capture, text)); expect(f.queue.slices('fixture')[0]!.capture.fromByte).toBe(0);
  writeFileSync(f.file, 'short\n'); await expect(f.queue.capture(f.source, f.home, async () => {})).rejects.toThrow('shrank');
});
test('a large transcript record keeps every redacted character in retryable fragments instead of losing its beginning', async () => {
  const f = fixture(), text = `Beginning convention. ${'x'.repeat(600000)} fixture-secret-never-share End convention.\n`; writeFileSync(f.file, text);
  let count = 0;
  await expect(f.queue.capture(f.source, f.home, async (capture, value) => { if (++count === 2) throw new Error('offline'); f.queue.accept(capture, value); })).rejects.toThrow('offline');
  await f.queue.capture(f.source, f.home, async (capture, value) => f.queue.accept(capture, value));
  const fragments = f.queue.slices('fixture').sort((a,b) => a.capture.fragment!.index - b.capture.fragment!.index);
  expect(fragments).toHaveLength(3); const restored = fragments.map(slice => slice.text).join('');
  expect(restored).toContain('Beginning convention'); expect(restored).toContain('End convention'); expect(restored).not.toContain('fixture-secret-never-share');
  expect(fragments.every(slice => slice.capture.fromByte === 0 && slice.capture.toByte === Buffer.byteLength(text))).toBe(true);
});
test('extraction input is newest first and bounds non-ASCII text to 300 KB with an explicit trimming note', () => {
  const f = fixture(); mkdirSync(join(f.home, 'other'), { recursive: true });
  for (let n = 0; n < 4; n++) f.queue.accept({ ...f.source, schema: 'memory-capture-v1', id: `capture_${n}`, fromByte: n * 10000, toByte: (n+1)*10000,
    at: new Date(Date.parse('2026-10-12T00:00:00Z') + n*1000).toISOString(), processedAt: null, extractionId: null }, `new_${n} ${'ção '.repeat(40000)}`);
  const input = f.queue.extractionInput('fixture'); expect(Buffer.byteLength(input.text)).toBeLessThanOrEqual(300000); expect(input.text.indexOf('new_3')).toBeLessThan(input.text.indexOf('new_2'));
  expect(input.text).toContain('trimmed'); expect(input.captures).toHaveLength(4);
});

test('repeated extraction checks stay cheap with a large processed history and still see captures from another queue', () => {
  const f = fixture(), at = '2026-10-12T00:00:00.000Z';
  for (let n = 0; n < 256; n++) f.queue.accept({ ...f.source, schema: 'memory-capture-v1', id: `processed_${n}`, fromByte: n * 100_000, toByte: (n + 1) * 100_000,
    at, processedAt: at, extractionId: 'extraction_completed' }, 'A previously extracted convention. '.repeat(3_000));
  const next = { ...f.source, schema: 'memory-capture-v1' as const, id: 'capture_pending', fromByte: 0, toByte: 5000, at, processedAt: null, extractionId: null };
  f.queue.accept(next, 'One new durable convention. '.repeat(200));
  const expected = f.queue.extractionInput('fixture'); expect(expected.captures.map(row => row.id)).toEqual([next.id]);
  const started = process.cpuUsage();
  for (let n = 0; n < 8; n++) expect(f.queue.extractionInput('fixture')).toEqual(expected);
  const cpu = process.cpuUsage(started);
  expect((cpu.user + cpu.system) / 1000).toBeLessThan(150);
  const peer = new ProjectCaptureQueue(f.homes, new SecretRedactor());
  peer.processed('fixture', [next], 'extraction_peer');
  expect(f.queue.extractionInput('fixture').captures).toHaveLength(0);
  peer.accept({ ...next, id: 'capture_later', at: '2026-10-12T00:01:00.000Z' }, 'A later convention.');
  expect(f.queue.extractionInput('fixture').captures.map(row => row.id)).toEqual(['capture_later']);
  expect(f.queue.slices('fixture', false)).toHaveLength(258);
  const processed = join(f.queue.directory('fixture'), 'processed_0.json'), before = statSync(processed);
  writeFileSync(processed, ' '.repeat(before.size)); utimesSync(processed, before.atime, before.mtime);
  expect(() => f.queue.extractionInput('fixture')).toThrow();
});
