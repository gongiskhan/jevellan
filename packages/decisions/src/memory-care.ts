import {
  ContextRuleJudgmentSchema, MemoryCareCandidatesSchema, MemoryCareJudgmentSchema, stableJson,
  type ContextRuleJudgment, type MemoryCareCandidates, type MemoryCareJudgment,
} from '@jevellan/core';
import { JevError, type JevQuestions } from './contract.js';
import type { DecisionClient } from './engine.js';

export type JudgedNote = { title: string; content: string };
const excerpt = (note: JudgedNote | undefined) => note ? `${note.title}: ${note.content.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '(missing note)';
/** A pair is merged at or above this probability; a stale note is archived at or below the stale threshold. */
export const SAME_NOTE_THRESHOLD = 0.7;
export const STILL_USEFUL_THRESHOLD = 0.3;
export const WORKING_RULE_THRESHOLD = 0.7;

/** Question keys are not shown to Jev, so every question carries the notes it asks about. */
export function memoryCareQuestions(raw: MemoryCareCandidates, notes: ReadonlyMap<string, JudgedNote>): JevQuestions {
  const candidates = MemoryCareCandidatesSchema.parse(raw); const questions: JevQuestions = {};
  candidates.pairs.forEach((pair, index) => {
    questions[`pair_${index}`] = { type: 'noul', instructions: `These two notes describe the same thing. Note A: ${excerpt(notes.get(pair.a))} Note B: ${excerpt(notes.get(pair.b))}`,
      criteria: { true: 'Both notes describe the same fact, rule or subject and should become one note.', false: 'The notes describe different things, or both are needed separately.' } };
  });
  candidates.stale.forEach((path, index) => {
    questions[`stale_${index}`] = { type: 'noul', instructions: `This note is still useful for work on this project. Note: ${excerpt(notes.get(path))}`,
      criteria: { true: 'The note is still useful for future work on this project.', false: 'The note is obsolete or no longer useful for this project.' } };
  });
  return questions;
}

/** One batched request: a Noul per candidate pair and per stale note, with recent handoff summaries as state. */
export async function judgeMemoryCare(client: DecisionClient, input: { candidates: MemoryCareCandidates; notes: ReadonlyMap<string, JudgedNote>; project: string; handoffs: string[]; model: string }, signal: AbortSignal): Promise<MemoryCareJudgment> {
  const candidates = MemoryCareCandidatesSchema.parse(input.candidates);
  const empty = MemoryCareJudgmentSchema.parse({ schema: 'memory-care-judgment-v1', requestedModel: input.model, returnedModel: input.model, pairs: [], stale: [] });
  const questions = memoryCareQuestions(candidates, input.notes); if (!Object.keys(questions).length) return empty;
  if (signal.aborted) throw new JevError('cancelled');
  const response = await client.decide({ schema: 'jev-request-v1', model: input.model, questions,
    state: stableJson({ project: input.project, recentHandoffSummaries: input.handoffs.slice(0, 10).map(summary => summary.slice(0, 500)) }) }, signal);
  if (signal.aborted) throw new JevError('cancelled');
  const probability = (key: string) => { const answer = response.answers[key]; if (answer?.type !== 'noul') throw new JevError('invalid-response'); return answer.noul; };
  return MemoryCareJudgmentSchema.parse({ schema: 'memory-care-judgment-v1', requestedModel: input.model, returnedModel: response.model,
    pairs: candidates.pairs.map((pair, index) => ({ a: pair.a, b: pair.b, probability: probability(`pair_${index}`) })),
    stale: candidates.stale.map((path, index) => ({ path, probability: probability(`stale_${index}`) })) });
}

/** A Noul per group of related notes: whether together they state a working rule for the project. */
export async function judgeContextRules(client: DecisionClient, input: { groups: string[][]; notes: ReadonlyMap<string, JudgedNote>; project: string; instructions: string; model: string }, signal: AbortSignal): Promise<ContextRuleJudgment> {
  const questions: JevQuestions = Object.fromEntries(input.groups.map((group, index) => [`rule_${index}`, { type: 'noul' as const,
    instructions: `These notes state a working rule for this project. ${group.map((path, n) => `Note ${n + 1}: ${excerpt(input.notes.get(path))}`).join(' ')}`,
    criteria: { true: 'Together the notes state one rule about how to work in this project.', false: 'The notes are facts, history or unrelated remarks rather than one working rule.' } }]));
  if (!input.groups.length) return ContextRuleJudgmentSchema.parse({ schema: 'context-rule-judgment-v1', requestedModel: input.model, returnedModel: input.model, groups: [] });
  if (signal.aborted) throw new JevError('cancelled');
  const response = await client.decide({ schema: 'jev-request-v1', model: input.model, questions,
    state: stableJson({ project: input.project, currentInstructionFile: input.instructions.slice(0, 4000) }) }, signal);
  if (signal.aborted) throw new JevError('cancelled');
  return ContextRuleJudgmentSchema.parse({ schema: 'context-rule-judgment-v1', requestedModel: input.model, returnedModel: response.model,
    groups: input.groups.map((paths, index) => { const answer = response.answers[`rule_${index}`]; if (answer?.type !== 'noul') throw new JevError('invalid-response'); return { paths, probability: answer.noul }; }) });
}
