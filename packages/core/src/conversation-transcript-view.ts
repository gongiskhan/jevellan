import { ConversationNoticeSchema } from './conversation-schemas.js';
import { ConversationTranscriptSourceSchema, ConversationTranscriptViewSchema, type ConversationTranscriptView } from './conversation-transcript-view-schemas.js';
import type { CursorTurn } from './cursor-schemas.js';
import type { LedgerEvent } from './schemas.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function display(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try { return display(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value) && value.every(part => typeof record(part).text === 'string')) return value.map(part => record(part).text).join('\n');
  return JSON.stringify(value, null, 2);
}

/** Preserve ledger order while joining streamed deltas and pairing tool results. */
export function conversationTurns(events: LedgerEvent[], running: boolean): CursorTurn[] {
  const turns: CursorTurn[] = [];
  const tools = new Map<string, Extract<CursorTurn['blocks'][number], { type: 'tool' }>>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === 'text' || event.type === 'thinking') {
      const text = typeof data.delta === 'string' ? data.delta : '';
      if (!text) continue;
      const previous = turns.at(-1)?.blocks.at(-1);
      if (previous?.type === event.type) previous.text += text;
      else turns.push({ id: `ledger:${event.id}`, role: 'assistant', blocks: [{ type: event.type, text }] });
    } else if (event.type === 'tool-start') {
      const tool: Extract<CursorTurn['blocks'][number], { type: 'tool' }> = {
        type: 'tool', id: String(data.id ?? event.id), name: String(data.name ?? 'Tool'), input: display(data.input), state: running ? 'running' : 'unknown',
      };
      tools.set(tool.id, tool); turns.push({ id: `ledger:${event.id}`, role: 'assistant', blocks: [tool] });
    } else if (event.type === 'tool-end') {
      const tool = tools.get(String(data.id));
      if (tool) { tool.state = data.ok === false ? 'failed' : 'completed'; if (data.output !== undefined) tool.output = display(data.output); }
    }
  }
  return turns;
}

export type ConversationActivity =
  | { kind: 'response'; id: string; turn: CursorTurn }
  | { kind: 'tools'; id: string; turns: CursorTurn[] };

/** Collapse consecutive tool calls without moving them past the assistant's response. */
export function conversationActivity(turns: CursorTurn[]): ConversationActivity[] {
  const activity: ConversationActivity[] = [];
  for (const turn of turns) {
    if (turn.blocks.every(block => block.type === 'tool')) {
      const previous = activity.at(-1);
      if (previous?.kind === 'tools') previous.turns.push(turn);
      else activity.push({ kind: 'tools', id: turn.id, turns: [turn] });
    } else activity.push({ kind: 'response', id: turn.id, turn });
  }
  return activity;
}

/** Only prose after substantive tools is a final reply; bridge bookkeeping does not start new work. */
export function conversationAnswerTurns(turns: CursorTurn[]): CursorTurn[] {
  let answers: CursorTurn[] = [];
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === 'tool' && !['ToolSearch', 'jevellan_handoff', 'jevellan_finding', 'memory_propose'].includes(block.name.split('__').at(-1)!)) answers = [];
      else if (block.type === 'text' && block.text.trim()) answers.push(turn);
    }
  }
  return [...new Map(answers.map(turn => [turn.id, turn])).values()];
}

/** A saved handoff is a fallback answer, not a second copy of the final streamed reply. */
export function hasConversationAnswer(turns: CursorTurn[]): boolean {
  return conversationAnswerTurns(turns).length > 0;
}

/** Exact copies already shown in the stream need no extra visible summary. */
export function conversationFallbackAnswer(turns: CursorTurn[], summary: string): string | undefined {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (hasConversationAnswer(turns) || turns.some(turn => turn.blocks.some(block => block.type === 'text' && normalize(block.text) === normalize(summary)))) return undefined;
  return summary;
}

/** Closing messages repeat the saved reply; operational and unrelated notices still need their own place. */
export function repeatedClosingNotice(notice: { kind: string; text: string }, summaries: string[], turns: CursorTurn[]): boolean {
  if (notice.kind !== 'closing') return false;
  const same = (text: string) => text.trim() === notice.text.trim();
  return summaries.some(same) || turns.some(turn => turn.blocks.some(block => block.type === 'text' && same(block.text)));
}

export type ConversationTranscriptInput = { projectId: string; conversationId: string; step: number; head: number; running: boolean; events: LedgerEvent[]; summary?: string | undefined; summaries?: string[] | undefined; notices?: LedgerEvent[] | undefined };
export function conversationTranscriptSources(events: LedgerEvent[], steps: { n: number; status: string }[]) {
  const tails = new Map<number, number>();
  for (const event of events) if (event.stretch !== undefined) tails.set(event.stretch, event.id);
  return steps.map(step => ConversationTranscriptSourceSchema.parse({ step: step.n, tail: tails.get(step.n) ?? 0, running: step.status === 'running' }));
}
function transcriptSnapshotMatches(view: ConversationTranscriptView | undefined, input: ConversationTranscriptInput): view is ConversationTranscriptView {
  return !!view && view.projectId === input.projectId && view.conversationId === input.conversationId && view.step === input.step && view.running === input.running && view.tail === (input.events.findLast(event => event.stretch === input.step)?.id ?? 0) && view.summary === (input.summary ?? null);
}
export function conversationStepTranscriptView(input: ConversationTranscriptInput): ConversationTranscriptView {
  const events = input.events.filter(event => event.stretch === input.step), turns = conversationTurns(events, input.running);
  const activity = conversationActivity(turns).map(row => row.kind === 'response' ? { kind: 'response' as const, id: row.id, turnId: row.turn.id } : { kind: 'tools' as const, id: row.id, turnIds: row.turns.map(turn => turn.id) });
  const hiddenNoticeIds = (input.notices ?? []).flatMap(event => { const notice = ConversationNoticeSchema.safeParse(event.data); return notice.success && repeatedClosingNotice(notice.data, input.summaries ?? [], turns) ? [event.id] : []; });
  return ConversationTranscriptViewSchema.parse({ schema: 'conversation-transcript-view-v1', projectId: input.projectId, conversationId: input.conversationId, step: input.step, tail: events.at(-1)?.id ?? 0, head: input.head, running: input.running, summary: input.summary ?? null,
    turns, activity, answerIds: conversationAnswerTurns(turns).map(turn => turn.id), fallbackAnswer: input.summary === undefined ? null : conversationFallbackAnswer(turns, input.summary) ?? null, hiddenNoticeIds });
}
export function selectConversationTranscriptView(view: ConversationTranscriptView | undefined, input: ConversationTranscriptInput): ConversationTranscriptView {
  return transcriptSnapshotMatches(view, input) ? view : conversationStepTranscriptView(input);
}
/** Rendering references use the same turns rather than repeating tool output in the wire document. */
export function conversationTranscriptProjection(view: ConversationTranscriptView) {
  const byId = new Map(view.turns.map(turn => [turn.id, turn]));
  const activity: ConversationActivity[] = view.activity.flatMap((row): ConversationActivity[] => {
    if (row.kind === 'response') { const turn = byId.get(row.turnId); return turn ? [{ kind: 'response', id: row.id, turn }] : []; }
    return [{ kind: 'tools', id: row.id, turns: row.turnIds.flatMap(id => { const turn = byId.get(id); return turn ? [turn] : []; }) }];
  });
  return { transcript: view.turns, activity, finalTurns: view.answerIds.flatMap(id => { const turn = byId.get(id); return turn ? [turn] : []; }), fallbackAnswer: view.fallbackAnswer ?? undefined };
}
export function conversationNoticeHidden(view: ConversationTranscriptView | undefined, event: LedgerEvent, input: ConversationTranscriptInput): boolean {
  const notice = ConversationNoticeSchema.safeParse(event.data); if (!notice.success) return false;
  if (transcriptSnapshotMatches(view, input) && view.head === input.head) return view.hiddenNoticeIds.includes(event.id);
  return repeatedClosingNotice(notice.data, input.summaries ?? [], conversationTurns(input.events, false));
}
