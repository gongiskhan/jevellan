import type { CursorTurn } from '@jevellan/core/client';

type Block = CursorTurn['blocks'][number];
export type ToolBlock = Extract<Block, { type: 'tool' }>;
export type TranscriptGroup = Exclude<Block, ToolBlock> | { type: 'tools'; name: string; calls: ToolBlock[] };

/** Only adjacent calls with the same exact tool name share an area. */
export function transcriptGroups(blocks: readonly Block[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.type !== 'tool') groups.push(block);
    else if (previous?.type === 'tools' && previous.name === block.name) previous.calls.push(block);
    else groups.push({ type: 'tools', name: block.name, calls: [block] });
  }
  return groups;
}

export function joinToolTurns(previous: CursorTurn, next: CursorTurn): CursorTurn | undefined {
  const end = previous.blocks.at(-1); const start = next.blocks[0];
  if (previous.role !== 'assistant' || next.role !== 'assistant' || end?.type !== 'tool' || start?.type !== 'tool' || end.name !== start.name) return;
  return { ...previous, blocks: [...previous.blocks, ...next.blocks] };
}

/** Native journals can store each call in a separate assistant record. */
export function mergeTranscriptTurns(turns: readonly CursorTurn[]): CursorTurn[] {
  const result: CursorTurn[] = [];
  for (const turn of turns) {
    const previous = result.at(-1); const joined = previous && joinToolTurns(previous, turn);
    if (joined) result[result.length - 1] = joined; else result.push(turn);
  }
  return result;
}
