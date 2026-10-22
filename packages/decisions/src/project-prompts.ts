import { MergePromptSchema, PlacementPromptSchema, type MergePrompt, type PlacementPrompt } from '@jevellan/core';
import { MERGE_CRITERIA, MERGE_INSTRUCTIONS } from './merge-route.js';
import { PLACEMENT_INSTRUCTIONS, PLACEMENT_ISOLATION_CRITERIA } from './placement.js';

/** Named lines preserve the existing imported p-v1 and m-v1 text formats. */
function namedLines(text: string, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n').map(value => value.trim()).filter(Boolean)) {
    const name = allowed.find(key => line.startsWith(`${key}:`));
    if (!name || Object.hasOwn(result, name)) throw new Error('Each prompt field must appear exactly once.');
    result[name] = line.slice(name.length + 1).trim();
  }
  return result;
}
export function placementPromptText(): string {
  return [...Object.entries(PLACEMENT_INSTRUCTIONS).map(([key, value]) => `${key}: ${value}`),
    ...Object.entries(PLACEMENT_ISOLATION_CRITERIA).map(([key, value]) => `isolation ${key}: ${value}`)].join('\n');
}
export function parsePlacementPrompt(text: string): PlacementPrompt {
  const lines = namedLines(text, ['isolation', 'pick_model', 'effort', 'device', 'isolation main', 'isolation worktree']);
  return PlacementPromptSchema.parse({ schema: 'placement-prompt-v1',
    instructions: { isolation: lines.isolation, pick_model: lines.pick_model, effort: lines.effort, device: lines.device },
    isolation: { main: lines['isolation main'], worktree: lines['isolation worktree'] } });
}
export function mergePromptText(): string {
  return [`instructions: ${MERGE_INSTRUCTIONS}`, ...Object.entries(MERGE_CRITERIA).map(([key, value]) => `${key}: ${value}`)].join('\n');
}
export function parseMergePrompt(text: string): MergePrompt {
  const lines = namedLines(text, ['instructions', 'merge', 'test-then-merge', 'ask-owner']);
  // Imported m-v1 v1 had only three criteria. Its original instruction stays fixed; a new code default is a proposal.
  return MergePromptSchema.parse({ schema: 'merge-prompt-v1', instructions: lines.instructions ?? 'Choose how this checked pull request reaches main.',
    criteria: { merge: lines.merge, 'test-then-merge': lines['test-then-merge'], 'ask-owner': lines['ask-owner'] } });
}
