import { expect, test } from 'vitest';
import type { LedgerEvent } from '../packages/core/dist/index.js';
import { conversationTurns } from '../apps/web/src/conversation-transcript.js';

const event = (id: number, type: LedgerEvent['type'], data: unknown): LedgerEvent => ({ schema: 'ledger-event-v1', id, type, data, t: '2026-09-29T10:00:00.000Z', stretch: 1 });
test('ordinary transcripts preserve streamed text/thinking/tool order and pair results', () => {
  const turns = conversationTurns([
    event(1, 'text', { delta: 'Inspecting ' }), event(2, 'text', { delta: '**files**.' }),
    event(3, 'thinking', { delta: 'Checking the configuration.' }),
    event(4, 'tool-start', { id: 'tool', name: 'Read', input: { path: 'fixture.ts' } }),
    event(5, 'text', { delta: 'The configuration is ready.' }),
    event(6, 'tool-end', { id: 'tool', ok: true, output: '[{"type":"text","text":"Readable output"}]' }),
  ], false);
  expect(turns.map(turn => turn.blocks[0]!.type)).toEqual(['text', 'thinking', 'tool', 'text']);
  expect(turns[0]!.blocks[0]).toEqual({ type: 'text', text: 'Inspecting **files**.' });
  expect(turns[2]!.blocks[0]).toMatchObject({ state: 'completed', output: 'Readable output' });
  expect(turns[2]!.id).toBe('ledger:4');
});
test('unfinished historical tools are recorded, active tools run, failed results retain their output', () => {
  const start = event(1, 'tool-start', { id: 'tool', name: 'Shell', input: { command: 'example' } });
  expect(conversationTurns([start], false)[0]!.blocks[0]).toMatchObject({ state: 'unknown' });
  expect(conversationTurns([start], true)[0]!.blocks[0]).toMatchObject({ state: 'running' });
  expect(conversationTurns([start, event(2, 'tool-end', { id: 'tool', ok: false, output: 'Failure details' })], false)[0]!.blocks[0]).toMatchObject({ state: 'failed', output: 'Failure details' });
});
