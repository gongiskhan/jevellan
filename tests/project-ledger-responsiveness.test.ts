import { afterEach, expect, test } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Homes } from '../packages/core/dist/index.js';
import { ProjectLedger, ProjectPaths } from '../packages/projects/dist/index.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function history(count = 12000) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-ledger-response-'))); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure(); const paths = new ProjectPaths(homes), ledger = new ProjectLedger(paths, 'project');
  mkdirSync(join(ledger.dir, 'ledger'), { recursive: true });
  const text = 'Simulated café history. '.repeat(60);
  for (let offset = 0; offset < count; offset += 6000) {
    const rows = Array.from({ length: Math.min(6000, count - offset) }, (_, index) => JSON.stringify({ schema: 'project-ledger-event-v1', id: offset + index + 1,
      t: '2026-10-23T10:00:00.000Z', type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text } }));
    writeFileSync(join(ledger.dir, 'ledger', `${String(offset / 6000 + 1).padStart(6, '0')}.jsonl`), rows.join('\n') + '\n');
  }
  return { paths, ledger, count, text };
}

test('CPU075 repeated idle history polls leave the owner request callback responsive', async () => {
  const { ledger, count } = history(); expect(ledger.lastId()).toBe(count);
  let callbackAt = 0; const started = performance.now(), callback = new Promise<void>(resolve => setImmediate(() => { callbackAt = performance.now(); resolve(); }));
  for (let n = 0; n < 20; n++) { expect(ledger.lastId()).toBe(count); expect(ledger.events(count, 1)).toEqual([]); }
  await callback;
  expect(callbackAt - started, 'Idle ledger polls must not starve an owner request behind repeated full-history parsing.').toBeLessThan(1000);
}, 60000);

test('CPU075 new records from independent handles remain responsive on a large history', async () => {
  const { ledger, paths, count } = history(), other = new ProjectLedger(paths, 'project'); expect(ledger.lastId()).toBe(count); expect(other.lastId()).toBe(count);
  const started = performance.now();
  for (let n = 1; n <= 12; n++) {
    const writer = n % 2 ? ledger : other, reader = n % 2 ? other : ledger;
    expect(writer.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: `New ${n}` } }).id).toBe(count + n);
    expect(reader.events(count + n - 1, 1)[0]?.id).toBe(count + n);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(performance.now() - started, 'Appending a small tail must not repeatedly parse the validated history.').toBeLessThan(1500);
}, 60000);

test('CPU075 warm reads preserve corruption checks outside the selected range and returned-value isolation', () => {
  const { ledger, text } = history(3), event = ledger.events()[0]!;
  (event.data as { text: string }).text = 'Caller mutation'; expect(ledger.payload(ledger.events()[0]! as typeof event & { type: 'coordinator-text' })).toEqual({ schema: 'coordinator-text-v1', text });
  const file = ledger.segments()[0]!, before = statSync(file), bytes = readFileSync(file, 'utf8');
  writeFileSync(file, bytes.replace('"id":1,', '"id":2,')); utimesSync(file, before.atime, before.mtime);
  expect(() => ledger.events(3, 1)).toThrow('sequence'); expect(() => ledger.lastId()).toThrow('sequence');
});

test('CPU075 warm readers reject invalid records, notice replacement files and retain interrupted tails', () => {
  const { ledger, paths } = history(2), other = new ProjectLedger(paths, 'project'); expect(ledger.lastId()).toBe(2);
  const file = ledger.segments()[0]!, valid = readFileSync(file, 'utf8');
  writeFileSync(file, valid.replace('"schema":"project-ledger-event-v1"', '"schema":"project-ledger-event-v0"'));
  expect(() => ledger.events(2, 1)).toThrow('invalid record');
  rmSync(file); writeFileSync(file, valid); expect(ledger.lastId()).toBe(2);
  appendFileSync(file, '{"interrupted":'); expect(ledger.lastId()).toBe(2);
  expect(other.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'After interruption' } }).id).toBe(3);
  expect(readFileSync(file, 'utf8')).toBe(valid + '{"interrupted":'); expect(ledger.events(2, 1).map(row => row.id)).toEqual([3]);
  writeFileSync(join(ledger.dir, 'ledger', '000003.jsonl'), '');
  expect(ledger.lastId()).toBe(3); expect(ledger.events(2, 1).map(row => row.id)).toEqual([3]);
});

test('selected ledger types retain ordered isolated payloads and validate omitted records', () => {
  const { ledger } = history(3);
  const start = ledger.append({ type: 'coordinator-turn-start', data: { schema: 'coordinator-turn-v1', turn: 1, fresh: false, runtime: 'fake', modelLabel: 'Fake', effort: 'medium', accountLabel: 'Test', eventIds: [] } });
  const end = ledger.append({ type: 'coordinator-turn-end', data: { schema: 'coordinator-turn-end-v1', turn: 1, status: 'completed' } });
  const types = ['coordinator-turn-start', 'coordinator-turn-end'] as const;
  expect(ledger.events(0, 1, types).map(event => event.id)).toEqual([start.id]);
  expect(ledger.events(start.id, 2, types).map(event => event.id)).toEqual([end.id]);
  const selected = ledger.events(0, 2, types); (selected[0]!.data as { turn: number }).turn = 99;
  expect(ledger.events(0, 2, types)[0]!.data).toMatchObject({ turn: 1 });
  expect(ledger.events(0, 1, [])).toEqual([]);
  const file = ledger.segments()[0]!, bytes = readFileSync(file, 'utf8');
  writeFileSync(file, bytes.replace('"id":1,', '"id":2,'));
  expect(() => ledger.events(end.id, 1, types)).toThrow('sequence');
  expect(() => ledger.events(0, 1, [])).toThrow('sequence');
});
