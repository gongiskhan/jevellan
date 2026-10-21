import type { CursorTurn } from './cursor-schemas.js';
import { prepareTranscriptGroups, type PreparedTranscriptGroup } from './transcript-presentation-schemas.js';
import { TranscriptTurnPresentationSchema, type TranscriptTurnPresentation } from './transcript-turn-presentation-schema.js';

export const TRANSCRIPT_PROMPT = 'Prompt';
export const THREAD_PROMPT_COLLAPSE_CHARACTERS = 1200;
export const HISTORY_PROMPT_COLLAPSE_CHARACTERS = 3000;

export function toolFiles(input: string) {
  try { const value: unknown = JSON.parse(input); if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>; return [...new Set([row.path, row.file_path, row.filePath].filter((item): item is string => typeof item === 'string'))];
  } catch { return []; }
}
export const userText = (turn: CursorTurn) => turn.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
export const transcriptPreview = (text: string) => { const line = text.trim().split('\n')[0]!.trim(); return line.length > 160 ? `${line.slice(0, 159)}…` : line; };

export type TranscriptTurnDisplayOptions = { active?: boolean | undefined; focus?: boolean | undefined; userLabel?: string | undefined; collapseLongUser?: number | undefined };
/** Copy and derived display flags shared by native, project, historical and conversation readers. */
export function transcriptTurnPresentation(turn: CursorTurn, options: TranscriptTurnDisplayOptions = {}, prepared: readonly PreparedTranscriptGroup[] = prepareTranscriptGroups(turn, options.active ?? false)): TranscriptTurnPresentation {
  const text = turn.role === 'user' && options.collapseLongUser !== undefined ? userText(turn) : '';
  return TranscriptTurnPresentationSchema.parse({ schema: 'transcript-turn-presentation-v1',
    label: turn.role === 'user' ? turn.automated ? 'Automatic update' : options.userLabel ?? 'You' : null,
    collapsed: !options.focus && options.collapseLongUser !== undefined && text.length > options.collapseLongUser,
    preview: transcriptPreview(text), groups: prepared.map(group => ({
      preview: group.type === 'text' ? transcriptPreview(group.text) || 'Message' : '',
      countLabel: group.type === 'tools' && group.calls.length > 1 ? `${group.calls.length} calls` : '',
      waitingSuffix: group.awaitingResult ? ' · Waiting for result' : '',
      calls: group.type !== 'tools' ? [] : group.calls.map(call => ({
        stateLabel: call.state === 'running' ? 'In progress' : call.state === 'unknown' ? 'Recorded' : call.state,
        files: toolFiles(call.input), noResultText: call.output !== undefined ? null : call.state === 'running' ? 'Waiting for the tool’s result…' : 'The saved transcript does not include this tool’s result.',
      })),
    })) });
}
