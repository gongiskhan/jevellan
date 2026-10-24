import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JournalDocumentSchema, ProjectEventFrameSchema } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
const controllers: AbortController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) controller.abort(); await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); });

test('CPU075 concurrent authenticated browser streams catch up through hidden journal history and deliver the next reply', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), ledger = f.app.projectWork.coordinatorLedger(f.project.id);
  const first = ledger.lastId(), segment = ledger.segments().length + 1, count = 12000;
  mkdirSync(join(ledger.dir, 'ledger'), { recursive: true });
  const data = JournalDocumentSchema.parse({ schema: 'journal-document-v1', collection: 'task', key: 'historic',
    document: { schema: 'fixture-history-v1', text: 'Simulated historical snapshot. '.repeat(60) } });
  for (let offset = 0; offset < count; offset += 6000) {
    const rows = Array.from({ length: 6000 }, (_, index) => JSON.stringify({ schema: 'project-ledger-event-v1', id: first + offset + index + 1,
      t: '2026-10-23T10:00:00.000Z', type: 'journal-document', data }));
    writeFileSync(join(ledger.dir, 'ledger', `${String(segment + offset / 6000).padStart(6, '0')}.jsonl`), rows.join('\n') + '\n');
  }
  const head = first + count; expect(ledger.lastId()).toBe(head);
  const clone = structuredClone; let hiddenCopies = 0;
  vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if (value && typeof value === 'object' && 'schema' in value && value.schema === 'project-ledger-event-v1' && 'type' in value && value.type === 'journal-document') hiddenCopies++;
    return clone(value, options);
  });
  const started = performance.now();
  const readers = await Promise.all(Array.from({ length: 3 }, async () => {
    const abort = new AbortController(); controllers.push(abort);
    const response = await fetch(`${f.base}/api/projects/${f.project.id}/coordinator/events`, { headers: { Cookie: f.cookie }, signal: abort.signal });
    expect(response.status).toBe(200); expect(response.headers.get('X-Jevellan-Ledger-Head')).toBe(String(head));
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let text = '', consumed = 0;
    const through = async (id: number) => {
      for (;;) {
        for (let end = text.indexOf('\n\n', consumed); end >= 0; end = text.indexOf('\n\n', consumed)) {
          const block = text.slice(consumed, end); consumed = end + 2;
          const match = /^id: (\d+)\nevent: (project|cursor)\ndata: (.+)$/u.exec(block); if (!match) continue;
          if (match[2] === 'project') {
            const frame = ProjectEventFrameSchema.parse(JSON.parse(match[3]!));
            expect(frame.event.type).not.toBe('journal-document');
            if (frame.event.id >= id) return frame;
          } else if (Number(match[1]) >= id) return null;
        }
        const chunk = await reader.read(); if (chunk.done) throw new Error('Browser stream ended before its cursor.');
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await through(head); return { through };
  }));
  expect(performance.now() - started, 'Concurrent browser replay must not monopolize the daemon copying hidden history.').toBeLessThan(3000);
  const root = await fetch(f.base); expect(root.status).toBe(200); await root.body?.cancel();
  const next = ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Fresh reply.' } });
  for (const reader of readers) {
    const frame = await reader.through(next.id); expect(frame?.event).toMatchObject({ id: next.id, type: 'coordinator-text', data: { text: 'Fresh reply.' } });
  }
  expect(hiddenCopies, 'Chat replay must validate hidden history without copying its payloads for each browser.').toBe(0);
}, 60000);
