import { stableJson, type DecisionRecord, type LedgerEvent } from '@jevellan/core';
import { RuntimeEventSchema } from '@jevellan/runtime-contract';
import type { ConversationLedger } from './ledger.js';
import type { ConversationView, ConversationWork, WorkMessage } from './work.js';

function latestMessage(view: ConversationView): WorkMessage | undefined {
  const current = view.conversation.work;
  if (!current) return undefined;
  const ids = new Set([current.requestEventId, ...current.messageEventIds]);
  return view.messages.findLast(message => ids.has(String(message.id)));
}

/** A routing decision cannot replace a response to a new message. */
export function latestMessageNeedsResponse(work: ConversationWork, decisions: readonly DecisionRecord[]): boolean {
  const view = work.load(); const current = view.conversation.work; const latest = latestMessage(view);
  if (!current || !latest) return false;
  const records = new Map(decisions.filter(record => record.workId === current.id).map(record => [record.id, record]));
  const starts = new Map(work.ledger.events().filter(event => event.type === 'stretch-start').map(event => [event.stretch, event.id]));
  return !view.stretches.some(stretch => {
    if (stretch.workId !== current.id || stretch.status !== 'completed') return false;
    const handoff = view.handoffs.find(entry => entry.stretch === stretch.n);
    if (!handoff || handoff.status === 'failed') return false;
    const decision = records.get(stretch.decisionId);
    if (!decision) return false;
    // Older decisions did not record their input message. The durable start
    // must follow it; a message queued after launch stays unanswered.
    return decision.latestMessageEventId === undefined
      ? (starts.get(stretch.n) ?? 0) > latest.id
      : decision.latestMessageEventId >= latest.id;
  });
}

type Exchange = { at: number; assistant: boolean; heading: string; text: string; pointer: string };
const omitted = '[Conversation history shortened. Inspect the source pointers for omitted text.]';
const render = (entry: Exchange) => `${entry.heading}\n${entry.text}`;

function excerpt(entry: Exchange, maxChars: number): string {
  const full = render(entry);
  if (full.length <= maxChars) return full;
  const marker = `[Excerpt truncated; inspect source ${entry.pointer}.]`;
  const available = maxChars - entry.heading.length - marker.length - 3;
  if (available < 8) return `[History omitted; read ${entry.pointer}]`.slice(0, maxChars);
  const first = Math.ceil(available * 0.75); const last = available - first;
  return `${entry.heading}\n${entry.text.slice(0, first)}\n${marker}\n${last ? entry.text.slice(-last) : ''}`;
}

/** Actual exchanges remain available after work closes, without reviving its obligations. */
export function conversationHistory(view: ConversationView, ledger: ConversationLedger, maxChars = 8000): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error('Invalid conversation history budget.');
  if (!maxChars) return '';
  const current = view.conversation.work;
  const latestId = current ? Number(current.messageEventIds.at(-1) ?? current.requestEventId) : undefined;
  const events = ledger.events(); const exchanges: Exchange[] = [];
  for (const message of view.messages) {
    if (message.id === latestId) continue;
    exchanges.push({ at: message.id, assistant: false, heading: `${message.type === 'note' ? 'Your queued message' : 'You'} (ledger/${message.id})`, text: message.text, pointer: `ledger/${message.id}` });
  }
  const textEvents = new Map<number, LedgerEvent[]>(); const handoffEvents = new Map<number, number>();
  for (const event of events) {
    if (event.stretch === undefined) continue;
    if (event.type === 'text') {
      const group = textEvents.get(event.stretch) ?? []; group.push(event); textEvents.set(event.stretch, group);
    } else if (event.type === 'handoff') handoffEvents.set(event.stretch, event.id);
  }
  for (const stretch of view.stretches) {
    if (stretch.status === 'undone') continue;
    const handoff = view.handoffs.find(entry => entry.stretch === stretch.n);
    const group = textEvents.get(stretch.n) ?? [];
    const streamed = group.map(event => {
      const parsed = RuntimeEventSchema.parse(ledger.data(event));
      if (parsed.type !== 'text') throw new Error('Conversation text event has another runtime type.');
      return parsed.delta;
    }).join('');
    let text = ''; let pointer = ''; let source = ''; let at = handoffEvents.get(stretch.n) ?? 0;
    if (handoff?.result?.type === 'answer') {
      const result = ledger.readBlob(handoff.result.ref);
      text = typeof result === 'string' ? result : stableJson(result); pointer = handoff.result.ref; source = pointer;
    }
    if (!text.trim()) {
      text = streamed; pointer = `ledger/${group[0]?.id}`; at = group.at(-1)?.id ?? at;
      source = group.length > 1 ? `${pointer} through ledger/${group.at(-1)!.id}` : pointer;
    }
    if (!text.trim()) { text = handoff?.summary ?? ''; pointer = `handoffs/${stretch.n}`; source = pointer; }
    if (!text.trim()) continue;
    const handoffPointer = handoff && source !== `handoffs/${stretch.n}` ? `; handoffs/${stretch.n}` : '';
    exchanges.push({ at, assistant: true,
      heading: `Assistant (step ${stretch.n}, ${stretch.action}, ${stretch.status}; ${source}${handoffPointer})`, text, pointer });
  }
  exchanges.sort((a, b) => a.at - b.at);
  const full = exchanges.map(render).join('\n\n');
  if (full.length <= maxChars) return full;

  // Reserve the latest answer before filling the remainder from newest to
  // oldest, so a long user message cannot displace what they are referring to.
  const protectedEntry = exchanges.findLast(entry => entry.assistant) ?? exchanges.at(-1)!;
  const contentBudget = Math.max(0, maxChars - omitted.length - 2);
  if (!contentBudget) return omitted.slice(0, maxChars);
  const protectedBudget = Math.min(render(protectedEntry).length, Math.max(Math.floor(contentBudget * 0.6), protectedEntry.heading.length + 100), contentBudget);
  const chosen = new Map<Exchange, string>([[protectedEntry, excerpt(protectedEntry, protectedBudget)]]);
  let remaining = contentBudget - chosen.get(protectedEntry)!.length;
  for (const entry of [...exchanges].reverse()) {
    if (entry === protectedEntry) continue;
    const available = remaining - 2;
    if (available < entry.heading.length + 100) continue;
    const value = excerpt(entry, available); chosen.set(entry, value); remaining -= value.length + 2;
  }
  return `${omitted}\n\n${exchanges.filter(entry => chosen.has(entry)).map(entry => chosen.get(entry)!).join('\n\n')}`;
}
