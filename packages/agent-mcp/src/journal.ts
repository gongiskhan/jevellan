import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CursorTranscriptSchema, type SecretRedactor } from '@jevellan/core';
import { AgentEventPageSchema, AgentOutputEventSchema, type AgentEventPage, type AgentOutputEvent } from './schemas.js';

const source = z.strictObject({ id: z.number().int().positive(), type: z.string().min(1), t: z.string().optional(), turn: z.number().int().positive().optional(), data: z.unknown() });
export type AgentSourceEvent = z.infer<typeof source>;
const observedBlock = z.strictObject({ id: z.string(), turnId: z.string(), groupId: z.string(),
  kind: z.enum(['text', 'thinking', 'tool']), text: z.string().optional(), input: z.string().optional(), output: z.string().optional(), state: z.string().optional() });
export const LegacyAgentOutputJournalSchema = z.strictObject({
  schema: z.literal('agent-output-journal-v1'), sourceAfter: z.number().int().nonnegative(),
  events: z.array(AgentOutputEventSchema), blocks: z.record(z.string(), observedBlock),
  lastSourceGroup: z.strictObject({ id: z.string(), kind: z.string(), toolName: z.string().optional(), turnId: z.string().optional() }).optional(),
});
export const AgentOutputJournalSchema = LegacyAgentOutputJournalSchema.extend({ schema: z.literal('agent-output-journal-v2') });
export const AgentOutputJournalDocumentSchema = z.union([AgentOutputJournalSchema, LegacyAgentOutputJournalSchema]);
export type AgentOutputJournal = z.infer<typeof AgentOutputJournalSchema>;
const publicId = (...parts: string[]) => `out_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const printed = (value: unknown): string | undefined => value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value);

export function emptyAgentJournal(): AgentOutputJournal {
  return AgentOutputJournalSchema.parse({ schema: 'agent-output-journal-v2', sourceAfter: 0, events: [], blocks: {} });
}

/** Pure reconciliation; callers serialize and atomically persist one journal per target. Reading never launches work. */
export function reconcileAgentJournal(previous: AgentOutputJournal, input: { ledger?: readonly AgentSourceEvent[]; transcript?: z.infer<typeof CursorTranscriptSchema> | null; redactor?: SecretRedactor }): AgentOutputJournal {
  const journal = AgentOutputJournalSchema.parse(structuredClone(previous));
  const append = (event: Omit<AgentOutputEvent, 'schema' | 'id'>) => journal.events.push(AgentOutputEventSchema.parse({ schema: 'agent-output-event-v1', id: journal.events.length + 1, ...event }));
  const history = (input.ledger ?? []).map(row => source.parse(row)).sort((a, b) => a.id - b.id);
  const fresh = history.filter(row => row.id > journal.sourceAfter);
  const deferred: AgentSourceEvent[] = [];
  // Pending credential fragments never enter the journal. Rebuild cumulative ledger blocks from their
  // durable source on every read, including after process restart, and publish only newly safe prefixes.
  const replay = input.redactor ? sourceReplay(history, journal.sourceAfter, input.redactor, append) : undefined;
  for (const row of fresh) {
    // The native snapshot contains the final tool/text output. End states follow that output in a fresh poll.
    if (input.transcript && /(?:turn|stretch)-end$|^thread-report$|^thread-publication$/u.test(row.type)) deferred.push(row);
    else if (replay) replay(row); else appendSource(row, journal, append);
    journal.sourceAfter = Math.max(journal.sourceAfter, row.id);
  }
  if (input.transcript) {
    const transcript = CursorTranscriptSchema.parse(input.transcript);
    let group: { id: string; kind: string; toolName?: string } | undefined;
    for (const turn of transcript.turns) {
      const turnId = publicId('turn', turn.id, turn.role);
      // SDK journals can put adjacent calls in separate assistant records. A user turn or a real non-tool block ends the group.
      if (turn.role !== 'assistant') group = undefined;
      for (const [index, block] of turn.blocks.entries()) {
        const blockId = publicId(turnId, block.type, block.type === 'tool' ? block.id || String(index) : String(index));
        if (block.type === 'tool' && group?.kind === 'tool' && group.toolName === block.name) {
          // Consecutive calls keep the first call's group; thinking/text/another tool starts a new one.
        } else group = { id: blockId, kind: block.type, ...(block.type === 'tool' ? { toolName: block.name } : {}) };
        const old = journal.blocks[blockId];
        const common = { blockId, groupId: group.id, turnId, role: turn.role };
        if (block.type === 'text' || block.type === 'thinking') {
          const before = old?.text ?? ''; const text = input.redactor?.streamText(block.text) ?? block.text;
          if (text !== before) {
            const prefix = text.startsWith(before);
            append({ ...common, kind: block.type, text: prefix ? text.slice(before.length) : text,
              offset: prefix ? before.length : 0, ...(prefix ? {} : { replace: true }) });
          }
          journal.blocks[blockId] = { id: blockId, turnId, groupId: group.id, kind: block.type, text };
        } else {
          const toolInput = input.redactor?.streamToolText(block.input) ?? block.input;
          const output = block.output === undefined ? undefined : input.redactor?.streamToolText(block.output) ?? block.output;
          if (!old || old.input !== toolInput || old.output !== output || old.state !== block.state) {
            append({ ...common, kind: 'tool', toolName: block.name, input: toolInput,
              ...(output === undefined ? {} : { output }), state: block.state, ...(old ? { replace: true } : {}) });
          }
          journal.blocks[blockId] = { id: blockId, turnId, groupId: group.id, kind: 'tool', input: toolInput,
            ...(output === undefined ? {} : { output }), state: block.state };
        }
      }
    }
  }
  for (const row of deferred) { if (replay) replay(row); else appendSource(row, journal, append); }
  return AgentOutputJournalSchema.parse(journal);
}

function sourceReplay(history: readonly AgentSourceEvent[], after: number, redactor: SecretRedactor,
  append: (event: Omit<AgentOutputEvent, 'schema' | 'id'>) => unknown): (row: AgentSourceEvent) => void {
  if (history.length && history[0]?.id !== 1 || after > 0 && !history.some(row => row.id === after)) throw new Error('Credential-safe output requires complete source history.');
  const scratch = emptyAgentJournal(); const textBlocks = new Map<string, { raw: string; safe: string }>();
  let current = 0;
  const collect = (event: Omit<AgentOutputEvent, 'schema' | 'id'>) => {
    scratch.events.push(AgentOutputEventSchema.parse({ ...event, schema: 'agent-output-event-v1', id: scratch.events.length + 1 }));
    if (event.kind === 'text' || event.kind === 'thinking') {
      const blockId = event.groupId ?? event.blockId; const old = textBlocks.get(blockId) ?? { raw: '', safe: '' };
      const raw = old.raw + (event.text ?? ''); const safe = redactor.streamText(raw);
      if (current > after && safe !== old.safe) {
        const prefix = safe.startsWith(old.safe);
        append({ ...event, blockId, text: prefix ? safe.slice(old.safe.length) : safe, offset: prefix ? old.safe.length : 0, ...(prefix ? {} : { replace: true }) });
      }
      textBlocks.set(blockId, { raw, safe });
    } else if (current > after) {
      // A completed mail/report/status record is not a native output delta. Tool payloads can still
      // receive late cumulative patches after their state changes, so their prefixes stay protected.
      append(event.kind === 'tool' ? { ...redactor.document(event),
        ...(event.input === undefined ? {} : { input: redactor.streamToolText(event.input) }),
        ...(event.output === undefined ? {} : { output: redactor.streamToolText(event.output) }) } : redactor.document(event));
    }
  };
  for (const row of history.filter(row => row.id <= after)) { current = row.id; appendSource(row, scratch, collect); }
  return row => { current = row.id; appendSource(row, scratch, collect); };
}

function appendSource(row: AgentSourceEvent, journal: AgentOutputJournal, append: (event: Omit<AgentOutputEvent, 'schema' | 'id'>) => unknown): void {
  const data = object(row.data);
  const turnId = row.turn === undefined ? undefined : `turn_${row.turn}`;
  const blockId = `event_${row.id}`;
  const common = { blockId, ...(turnId === undefined ? {} : { turnId }) };
  const toolId = string(data.id);
  const toolBlockId = toolId === undefined ? blockId : publicId(turnId ?? 'unknown-turn', 'tool', toolId);
  const start = row.type === 'tool-end' ? journal.events.findLast(event => event.kind === 'tool' && event.blockId === toolBlockId) : undefined;
  const name = string(data.name) ?? string(data.tool) ?? start?.toolName;
  if (row.type === 'thinking') {
    const text = string(data.delta) ?? string(data.text) ?? '';
    const prior = journal.lastSourceGroup;
    const groupId = prior?.kind === 'thinking' && prior.turnId === turnId ? prior.id : blockId;
    append({ ...common, groupId, kind: 'thinking', text });
    journal.lastSourceGroup = { id: groupId, kind: 'thinking', ...(turnId === undefined ? {} : { turnId }) }; return;
  }
  if (row.type === 'coordinator-text' || row.type === 'text' || row.type === 'user-message' || row.type === 'note') {
    const text = string(data.delta) ?? string(data.text) ?? string(row.data);
    if (text !== undefined) {
      const role = row.type === 'user-message' || row.type === 'note' ? 'user' : 'assistant';
      const prior = journal.lastSourceGroup;
      const groupId = prior?.kind === `${role}-text` && prior.turnId === turnId ? prior.id : blockId;
      append({ ...common, groupId, kind: 'text', text, role });
      journal.lastSourceGroup = { id: groupId, kind: `${role}-text`, ...(turnId === undefined ? {} : { turnId }) }; return;
    }
  }
  if (name !== undefined && (row.type === 'coordinator-tool' || row.type === 'tool-start' || row.type === 'tool-end')) {
    const prior = journal.lastSourceGroup;
    const groupId = start?.groupId ?? (prior?.kind === 'tool' && prior.toolName === name && prior.turnId === turnId ? prior.id : toolBlockId);
    append({ ...common, blockId: toolBlockId, groupId, kind: 'tool', toolName: name,
      ...(data.input === undefined ? {} : { input: printed(data.input) }),
      ...(data.output === undefined && data.summary === undefined ? {} : { output: printed(data.output ?? data.summary) }),
      state: data.ok === false ? 'failed' : row.type === 'tool-start' ? 'running' : 'completed', ...(start ? { replace: true } : {}) });
    // A late result updates the original tool area; it does not move that call after an intervening response.
    if (!start) journal.lastSourceGroup = { id: groupId, kind: 'tool', toolName: name, ...(turnId === undefined ? {} : { turnId }) }; return;
  }
  const kind: AgentOutputEvent['kind'] = row.type.includes('report') || row.type === 'handoff' ? 'report'
    : row.type.includes('decision') ? 'decision' : row.type.includes('mail') ? 'mail' : row.type === 'notice' || row.type === 'error' ? 'notice' : 'status';
  append({ ...common, groupId: blockId, kind, text: string(data.text) ?? string(data.summary) ?? string(data.reason) ?? row.type,
    ...(string(data.to) === undefined && string(data.status) === undefined ? {} : { state: string(data.to) ?? string(data.status) }), data: row.data });
  journal.lastSourceGroup = { id: blockId, kind, ...(turnId === undefined ? {} : { turnId }) };
}

/** A cursor ahead of stored history is refused; callers cannot silently skip a reset or the wrong target. */
export function agentJournalPage(raw: AgentOutputJournal, after: number, limit: number, state?: string): AgentEventPage {
  const journal = AgentOutputJournalSchema.parse(raw);
  z.number().int().nonnegative().parse(after); z.number().int().min(1).max(200).parse(limit);
  if (after > journal.events.length) throw new Error('The output cursor is ahead of stored history.');
  const events = journal.events.slice(after, after + limit);
  return AgentEventPageSchema.parse({ schema: 'agent-event-page-v1', events, nextCursor: events.at(-1)?.id ?? after,
    hasMore: after + events.length < journal.events.length, ...(state === undefined ? {} : { state }) });
}
