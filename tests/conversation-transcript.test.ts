import { expect, test } from 'vitest';
import type { LedgerEvent } from '../packages/core/dist/index.js';
import { conversationActivity, conversationAnswerTurns, conversationFallbackAnswer, conversationTurns, hasConversationAnswer, repeatedClosingNotice } from '../apps/web/src/conversation-transcript.js';

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

test('tool groups stay between responses and preserve failures, outputs and thought order', () => {
  const turns = conversationTurns([
    event(1, 'text', { delta: 'I will inspect the files.' }),
    event(2, 'tool-start', { id: 'read', name: 'Read', input: { path: 'fixture.ts' } }),
    event(3, 'tool-end', { id: 'read', ok: true, output: 'File contents' }),
    event(4, 'tool-start', { id: 'command', name: 'Bash', input: { command: 'example' } }),
    event(5, 'tool-end', { id: 'command', ok: false, output: 'The command failed' }),
    event(6, 'thinking', { delta: 'I can explain the failure.' }),
    event(7, 'text', { delta: 'The configuration needs one change.' }),
    event(8, 'tool-start', { id: 'edit', name: 'Edit', input: { path: 'fixture.ts' } }),
  ], true);
  const activity = conversationActivity(turns);
  expect(activity.map(item => item.kind)).toEqual(['response', 'tools', 'response', 'response', 'tools']);
  const group = activity[1]!;
  expect(group.kind).toBe('tools');
  if (group.kind !== 'tools') throw new Error('Expected a tool group');
  expect(group.turns).toHaveLength(2);
  expect(group.turns[1]!.blocks[0]).toMatchObject({ state: 'failed', output: 'The command failed' });
  expect(activity[2]).toMatchObject({ turn: { blocks: [{ type: 'thinking', text: 'I can explain the failure.' }] } });
  expect(activity.at(-1)).toMatchObject({ turns: [{ blocks: [{ state: 'running' }] }] });
});

test('only visible assistant prose replaces the handoff fallback answer', () => {
  expect(hasConversationAnswer(conversationTurns([event(1, 'thinking', { delta: 'Considering the answer.' }), event(2, 'tool-start', { id: 'read', name: 'Read', input: {} })], false))).toBe(false);
  expect(hasConversationAnswer(conversationTurns([event(1, 'text', { delta: ' \n ' })], false))).toBe(false);
  expect(hasConversationAnswer(conversationTurns([event(1, 'text', { delta: 'Here is the short answer.' })], false))).toBe(true);
});

test('progress before a substantive tool does not hide a useful handoff answer', () => {
  const progress = event(1, 'text', { delta: 'I will check the project.' });
  const read = event(2, 'tool-start', { id: 'read', name: 'Read', input: { path: 'fixture.ts' } });
  const handoff = event(3, 'tool-start', { id: 'handoff', name: 'mcp__jevellan__jevellan_handoff', input: {} });
  expect(hasConversationAnswer(conversationTurns([progress, read, handoff], false))).toBe(false);
  const final = event(3, 'text', { delta: 'The fixture is safe to retire.' });
  expect(conversationAnswerTurns(conversationTurns([progress, read, final, { ...handoff, id: 4 }], false)).map(turn => turn.id)).toEqual(['ledger:3']);
  expect(hasConversationAnswer(conversationTurns([progress, read, final, { ...handoff, id: 4 }], false))).toBe(true);
  expect(hasConversationAnswer(conversationTurns([final, event(4, 'tool-start', { id: 'search', name: 'ToolSearch', input: {} }), { ...handoff, id: 5 }], false))).toBe(true);
});

test('fallback summaries are preserved without repeating exact prose even before an older tool', () => {
  const summary = 'The fixture is safe to retire.';
  const read = event(2, 'tool-start', { id: 'read', name: 'Read', input: {} });
  expect(conversationFallbackAnswer(conversationTurns([event(1, 'text', { delta: 'I will check the project.' }), read], false), summary)).toBe(summary);
  expect(conversationFallbackAnswer(conversationTurns([event(1, 'text', { delta: 'The fixture is safe\nto retire.' }), read], false), summary)).toBeUndefined();
  expect(conversationFallbackAnswer(conversationTurns([], false), summary)).toBe(summary);
});

test('only exact closing copies of a saved or streamed answer are suppressed', () => {
  const summary = 'The fixture is safe to retire.';
  const turns = conversationTurns([event(1, 'text', { delta: 'The requested summary is ready.' })], false);
  expect(repeatedClosingNotice({ kind: 'closing', text: summary }, [summary], [])).toBe(true);
  expect(repeatedClosingNotice({ kind: 'closing', text: 'The requested summary is ready.' }, [], turns)).toBe(true);
  expect(repeatedClosingNotice({ kind: 'info', text: summary }, [summary], turns)).toBe(false);
  expect(repeatedClosingNotice({ kind: 'error', text: summary }, [summary], turns)).toBe(false);
  expect(repeatedClosingNotice({ kind: 'closing', text: 'Finished without tests.' }, [summary], turns)).toBe(false);
});
