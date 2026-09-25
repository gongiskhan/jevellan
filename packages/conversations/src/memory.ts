import { MemoryAppliedSchema, MemoryProposalInputSchema, MemoryProposalSchema, newId, stableJson, type Action, type MemoryApplied, type MemoryNote } from '@jevellan/core';
import type { ProjectMemory } from './bridge.js';
import type { MemoryExcerpt } from './brief.js';
import { ConversationWork } from './work.js';

type Proposal = ReturnType<typeof MemoryProposalSchema.parse>;
export function queueMemory(work: ConversationWork, stretch: number, raw: unknown, source: Proposal['source'] = 'agent'): { id: string; eventId: number; queued: true } {
  const view = work.load(); const step = view.stretches.find((entry) => entry.n === stretch);
  if (!step || step.status === 'undone') throw new Error('Memory proposal belongs to no active step.');
  const input = MemoryProposalInputSchema.parse(work.ledger.redact(raw));
  const proposed = { ...input, source, conversationId: work.ledger.id, workId: step.workId, projectId: view.conversation.projectId, stretch };
  const previous = work.ledger.events().filter((event) => event.type === 'memory-queued' && event.stretch === stretch)
    .map((event) => ({ event, proposal: MemoryProposalSchema.parse(work.ledger.data(event)) }))
    .find(({ proposal }) => stableJson({ title: proposal.title, content: proposal.content, reason: proposal.reason, source: proposal.source, conversationId: proposal.conversationId, workId: proposal.workId, projectId: proposal.projectId, stretch: proposal.stretch }) === stableJson(proposed));
  if (previous) return { id: previous.proposal.id, eventId: previous.event.id, queued: true };
  const proposal = MemoryProposalSchema.parse({ schema: 'memory-proposal-v1', id: newId('memory'), ...proposed });
  const event = work.ledger.append({ type: 'memory-queued', stretch, data: proposal });
  return { id: proposal.id, eventId: event.id, queued: true };
}

export type QueuedMemory = Pick<ProjectMemory, 'write' | 'assertOwnership'> & { findTitle(title: string, signal: AbortSignal): Promise<MemoryNote | null> };
export class MemoryQueue {
  #pending: Promise<unknown> = Promise.resolve();
  constructor(readonly work: ConversationWork) {}
  captureHandoff(stretch: number): void {
    const handoff = this.work.ledger.handoffs().find((entry) => entry.stretch === stretch);
    if (!handoff) throw new Error('Memory capture requires an accepted handoff.');
    for (const finding of handoff.findings.filter((entry) => entry.claim.startsWith('memory:'))) {
      const title = finding.claim.slice('memory:'.length).trim();
      if (!title) continue;
      queueMemory(this.work, stretch, { title, content: `Source: ${finding.pointer}\n\n[Conversation](/conversations/${this.work.ledger.id})`, reason: 'Durable finding from the accepted handoff.' }, 'handoff');
    }
  }
  pending(workId: string): Proposal[] {
    const events = this.work.ledger.events();
    const applied = new Set(events.filter((event) => event.type === 'git').flatMap((event) => {
      const value = MemoryAppliedSchema.safeParse(this.work.ledger.data(event)); return value.success ? value.data.notes.map((note) => note.proposalId) : [];
    }));
    const active = new Set(this.work.load().stretches.filter((entry) => entry.workId === workId && entry.status !== 'undone').map((entry) => entry.n));
    return events.filter((event) => event.type === 'memory-queued').map((event) => MemoryProposalSchema.parse(this.work.ledger.data(event)))
      .filter((proposal) => proposal.workId === workId && active.has(proposal.stretch) && !applied.has(proposal.id));
  }
  apply(workId: string, memory: QueuedMemory, checkpoint: (summary: string) => Promise<string | null>, signal: AbortSignal): Promise<MemoryApplied | null> {
    const operation = this.#pending.then(async () => {
      const boundary = () => {
        signal.throwIfAborted(); const current = this.work.load();
        if (current.conversation.work?.id !== workId || current.stretches.some((step) => step.status === 'running')) throw new Error('Memory is applied only at a settled boundary of its open work.');
        return current;
      };
      const view = boundary();
      const queued = this.pending(workId); if (!queued.length) return null;
      await memory.assertOwnership(); boundary();
      const notes: MemoryApplied['notes'] = [];
      for (const proposal of queued) {
        boundary(); await memory.assertOwnership(); boundary();
        const existing = await memory.findTitle(proposal.title, signal);
        boundary();
        const note = existing ?? await memory.write({ title: proposal.title, content: proposal.content }, signal);
        notes.push({ proposalId: proposal.id, title: note.title, permalink: note.permalink, outcome: existing ? 'existing' : 'written' });
      }
      // Always checkpoint before the receipt, including recovery after a note write.
      // Existing titles are preserved, so a lost receipt cannot duplicate or overwrite them.
      boundary(); await memory.assertOwnership(); boundary();
      const commit = await checkpoint(`Capture ${notes.length} project ${notes.length === 1 ? 'note' : 'notes'}`);
      const receipt = MemoryAppliedSchema.parse({ schema: 'memory-applied-v1', workId, projectId: view.conversation.projectId, notes, commit });
      this.work.ledger.append({ type: 'git', data: receipt }); return receipt;
    });
    this.#pending = operation.then(() => undefined, () => undefined); return operation;
  }
}

export async function searchMemoryCandidates(memory: Pick<ProjectMemory, 'search'>, input: { request: string; latestMessage: string; action: Action }, signal: AbortSignal) {
  // A whole natural-language request becomes an impossible AND/phrase in FTS.
  // Search literal words from each section, letting the provider rank the union.
  const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 64);
  const query = [...new Set([input.request, input.latestMessage, input.action].flatMap(words))].join(' OR ');
  return (await memory.search(query, signal)).notes.slice(0, 12);
}
export async function recallBySearchRank(memory: Pick<ProjectMemory, 'search'>, input: { request: string; latestMessage: string; action: Action }, signal: AbortSignal): Promise<{ candidates: string[]; chosen: string[]; source: 'search-rank'; excerpts: MemoryExcerpt[] }> {
  const notes = await searchMemoryCandidates(memory, input, signal);
  const selected = notes.slice(0, 5);
  return { candidates: notes.map((note) => note.permalink), chosen: selected.map((note) => note.permalink), source: 'search-rank',
    excerpts: selected.map((note) => ({ title: note.title, permalink: note.permalink, excerpt: note.content.slice(0, 300), unresolved: note.unresolved })) };
}
