import { z } from 'zod';
import { CursorBlockSchema, type CursorTurn } from './cursor-schemas.js';
import { transcriptGroups, toolAwaitingResult } from './transcript-groups.js';

export const PreparedTranscriptGroupSchema = z.discriminatedUnion('type', [
  CursorBlockSchema.options[0].extend({ active: z.boolean(), awaitingResult: z.literal(false) }),
  CursorBlockSchema.options[1].extend({ active: z.boolean(), awaitingResult: z.literal(false) }),
  z.strictObject({ type: z.literal('tools'), name: z.string(), calls: z.array(CursorBlockSchema.options[2]).min(1), active: z.boolean(), awaitingResult: z.boolean() }),
]);
export type PreparedTranscriptGroup = z.infer<typeof PreparedTranscriptGroupSchema>;
export function prepareTranscriptGroups(turn: CursorTurn, active: boolean): PreparedTranscriptGroup[] {
  const groups = transcriptGroups(turn.blocks);
  return groups.map((group, index) => {
    const current = active && turn.role === 'assistant' && index === groups.length - 1;
    return PreparedTranscriptGroupSchema.parse({ ...group, active: current, awaitingResult: group.type === 'tools' && current && toolAwaitingResult(group.calls.at(-1)!) });
  });
}
