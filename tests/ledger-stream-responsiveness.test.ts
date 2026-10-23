import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Homes } from '../packages/core/dist/index.js';
import { ProjectLedger, ProjectPaths } from '../packages/projects/dist/index.js';
import { streamLedger } from '../apps/daemon/dist/conversation-events.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test('CPU075 a browser stream catches up through large hidden history without repeatedly copying the complete ledger', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-stream-response-')));
  mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'data'), join(root, 'user')); homes.ensure();
  const ledger = new ProjectLedger(new ProjectPaths(homes), 'project');
  mkdirSync(join(ledger.dir, 'ledger'), { recursive: true });
  const count = 12000, text = 'Simulated recorded history. '.repeat(60);
  for (let offset = 0; offset < count; offset += 6000) {
    const rows = Array.from({ length: 6000 }, (_, index) => JSON.stringify({ schema: 'project-ledger-event-v1', id: offset + index + 1,
      t: '2026-10-23T10:00:00.000Z', type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text } }));
    writeFileSync(join(ledger.dir, 'ledger', `${String(offset / 6000 + 1).padStart(6, '0')}.jsonl`), rows.join('\n') + '\n');
  }
  expect(ledger.lastId()).toBe(count);
  const cursors: number[] = []; let head: unknown, payloadFrames = 0, resolve!: () => void;
  const caughtUp = new Promise<void>(done => { resolve = done; });
  const response = Object.assign(new EventEmitter(), {
    writeHead: (_status: number, headers: Record<string, string>) => { head = headers['X-Jevellan-Ledger-Head']; },
    flushHeaders: () => {}, end: () => {}, destroy: () => {},
    write: (chunk: string) => {
      const cursor = /^id: (\d+)\nevent: cursor\n/.exec(chunk);
      if (cursor) { cursors.push(Number(cursor[1])); if (Number(cursor[1]) === count) resolve(); }
      else payloadFrames++;
      return true;
    },
  }) as unknown as ServerResponse;
  const started = performance.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    streamLedger(ledger, { headers: {} } as IncomingMessage, response, new URL('http://fixture.invalid/'), () => true,
      { name: 'project', payload: event => ({ id: event.id }), skip: () => true, invalidCursor: 'Invalid', aheadCursor: 'Ahead' });
    await Promise.race([caughtUp, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('History replay did not finish.')), 30000); })]);
    expect(head).toBe(String(count));
    expect(payloadFrames).toBe(0);
    expect(cursors).toEqual(Array.from({ length: Math.ceil(count / 64) }, (_, index) => Math.min(count, (index + 1) * 64)));
    expect(performance.now() - started, 'A caught-up browser must not spend seconds copying hidden history for every replay batch.').toBeLessThan(1500);
  } finally { clearTimeout(deadline); response.emit('close'); }
}, 60000);
