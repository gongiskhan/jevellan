import { z } from 'zod';
import { MemoryNoteSchema, type Action, type MemoryNote } from '@jevellan/core';
import type { JevClient } from './client.js';
import { JevError, type JevQuestions, type JevResponse } from './contract.js';

export const MemorySelectionSchema = z.strictObject({
  schema: z.literal('memory-selection-v1'), candidates: z.array(z.string()).max(12), chosen: z.array(z.string()).max(5),
  source: z.enum(['jev', 'search-rank']), scores: z.record(z.string(), z.number().min(0).max(3)).optional(),
  excerpts: z.array(z.strictObject({ title: z.string(), permalink: z.string(), excerpt: z.string().max(300), unresolved: z.boolean() })).max(5),
});
export type MemorySelection = z.infer<typeof MemorySelectionSchema>;

export function memoryQuestions(notes: MemoryNote[], action: Action): JevQuestions {
  return Object.fromEntries(notes.slice(0, 12).map((raw, index) => {
    const note = MemoryNoteSchema.parse(raw);
    return [`memory_${index}`, { type: 'score', instructions: `How useful is this note for the next step (${action}) of this work? Note: ${note.title}${note.unresolved ? ' (conflicting versions, unresolved)' : ''}: ${note.content.slice(0, 300)}`, criteria: ['not useful', 'marginally useful', 'useful', 'essential'] }];
  }));
}

export async function selectMemory(client: Pick<JevClient, 'decide'>, input: { notes: MemoryNote[]; action: Action; state: string; model: string }, signal?: AbortSignal): Promise<{ selection: MemorySelection; response?: JevResponse }> {
  if (signal?.aborted) throw new JevError('cancelled');
  const notes = input.notes.slice(0, 12).map((note) => MemoryNoteSchema.parse(note));
  let response: JevResponse | undefined;
  let selected = notes.slice(0, 5); let scores: Record<string, number> | undefined;
  if (notes.length) {
    try {
      const result = await client.decide({ schema: 'jev-request-v1', model: input.model, state: input.state, questions: memoryQuestions(notes, input.action) }, signal);
      if (signal?.aborted) throw new JevError('cancelled');
      const ranked = notes.map((note, index) => {
        const answer = result.answers[`memory_${index}`];
        if (answer?.type !== 'score') throw new JevError('invalid-response');
        return { note, score: answer.score, index };
      });
      scores = Object.fromEntries(ranked.map(({ note, score }) => [note.permalink, score]));
      selected = ranked.filter(({ score }) => score >= 2).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5).map(({ note }) => note);
      response = result;
    } catch (error) {
      if (!(error instanceof JevError) || error.kind === 'cancelled') throw error;
      if (signal?.aborted) throw new JevError('cancelled');
    }
  }
  return { selection: MemorySelectionSchema.parse({ schema: 'memory-selection-v1', candidates: notes.map((note) => note.permalink), chosen: selected.map((note) => note.permalink), source: response ? 'jev' : 'search-rank', ...(scores ? { scores } : {}),
    excerpts: selected.map((note) => ({ title: note.title, permalink: note.permalink, excerpt: note.content.slice(0, 300), unresolved: note.unresolved })) }), ...(response ? { response } : {}) };
}
