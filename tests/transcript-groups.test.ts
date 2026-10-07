import { expect, test } from 'vitest';
import type { CursorTurn } from '../packages/core/dist/client.js';
import { mergeTranscriptTurns, transcriptGroups } from '../apps/web/src/transcript-groups.js';
import { mergeThreadToolTurns } from '../apps/web/src/project-work-model.js';
const tool = (id: string, name = 'Read', state: 'running' | 'completed' | 'failed' = 'completed'): CursorTurn['blocks'][number] => ({ type: 'tool', id, name, input: id, output: `result ${id}`, state });
const turn = (id: string, blocks: CursorTurn['blocks'], role: CursorTurn['role'] = 'assistant'): CursorTurn => ({ id, blocks, role });

test('adjacent identical calls share an area across native assistant records, retaining every result and state', () => {
  const raw = [turn('a', [tool('one')]), turn('b', [tool('two', 'Read', 'failed')]), turn('c', [tool('three', 'Read', 'running')])];
  const merged = mergeTranscriptTurns(raw);
  expect(merged).toHaveLength(1); expect(merged[0]!.id).toBe('a');
  expect(transcriptGroups(merged[0]!.blocks)).toEqual([{ type: 'tools', name: 'Read', calls: raw.flatMap(t => t.blocks) }]);
  expect(raw.every(t => t.blocks.length === 1)).toBe(true);
});
test.each(['thinking', 'text'] as const)('%s ends the current group even when the same tool follows', type => {
  const groups = transcriptGroups([tool('one'), { type, text: 'boundary' }, tool('two'), tool('three')]);
  expect(groups.map(g => g.type)).toEqual(['tools', type, 'tools']);
  expect(groups[2]).toMatchObject({ calls: [{ id: 'two' }, { id: 'three' }] });
});
test('changing tools and user messages ends the current group', () => {
  expect(transcriptGroups([tool('one'), tool('two', 'Bash'), tool('three')])).toHaveLength(3);
  expect(mergeTranscriptTurns([turn('a', [tool('one')]), turn('u', [{ type: 'text', text: 'stop' }], 'user'), turn('b', [tool('two')])])).toHaveLength(3);
});
test('reports remain boundaries between thread tool groups', () => {
  const report = { kind: 'report' as const, report: { schema: 'thread-report-v1' as const, turn: 1, status: 'progress' as const, summary: 'Checked', changedFiles: [], synthesized: false } };
  expect(mergeThreadToolTurns([{ kind: 'turn', turn: turn('a', [tool('one')]) }, report, { kind: 'turn', turn: turn('b', [tool('two')]) }])).toHaveLength(3);
});
