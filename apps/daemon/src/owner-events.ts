import type { ServerResponse } from 'node:http';
import { OwnerEventSchema, ProjectLedgerDataSchemas, type OwnerEvent, type ProjectLedgerEvent } from '@jevellan/core';
import type { ProjectLedger } from '@jevellan/projects';
import type { Application } from './application.js';

const KEEP = 5000;
const cut = (text: string, max = 600) => { const one = text.replace(/\s+/gu, ' ').trim(); return one.length > max ? `${one.slice(0, max - 3)}...` : one; };

/**
 * The owner event stream (bridge specification, "Event stream"): coordinator and thread events, state changes and pushes, numbered
 * with a monotonic `seq` so `jevellan watch` and the forwarder resume where they left off. Numbers start from the clock at start-up,
 * so they keep growing across restarts; events from before a restart are not replayed.
 */
export class OwnerEvents {
  readonly #events: OwnerEvent[] = [];
  readonly #listeners = new Set<(event: OwnerEvent) => void>();
  #seq: number;
  #threadSources = new Map<string, string>();
  constructor(private readonly app: Application, now: () => number = Date.now) {
    this.#seq = now() * 1000;
    app.projectWork.ledgers.subscribe((ledger, event) => { try { this.#fromLedger(ledger, event); } catch { /* a malformed payload never breaks a writer */ } });
  }
  /** Remember a thread's display id once a view assigned it. */
  noteSource(threadId: string, shortId: string): void { this.#threadSources.set(threadId, shortId); }
  #source(ledger: ProjectLedger): string {
    if (!ledger.threadId) return 'C';
    const known = this.#threadSources.get(ledger.threadId); if (known) return known;
    try {
      const short = this.app.ownerTools.ids.shortOf(ledger.projectId, ledger.threadId);
      if (short) { this.#threadSources.set(ledger.threadId, short); return short; }
    } catch { /* members have no ids */ }
    return 'T?';
  }
  #fromLedger(ledger: ProjectLedger, event: ProjectLedgerEvent): void {
    const data = ledger.data(event) as Record<string, unknown> | undefined; if (!data) return;
    const source = this.#source(ledger); const at = event.t; const projectId = ledger.projectId;
    const emit = (kind: OwnerEvent['kind'], text: string) => this.publish({ projectId, source, kind, text: cut(text, 4000), at });
    switch (event.type) {
      case 'coordinator-text': { const parsed = ProjectLedgerDataSchemas['coordinator-text'].safeParse(data); if (parsed.success) emit('text', parsed.data.text); return; }
      case 'coordinator-tool': { const parsed = ProjectLedgerDataSchemas['coordinator-tool'].safeParse(data); if (parsed.success) emit(parsed.data.tool === 'jevellan_task_create' ? 'decide' : 'tool', `${parsed.data.tool}: ${parsed.data.summary}`); return; }
      case 'coordinator-turn-end': { const parsed = ProjectLedgerDataSchemas['coordinator-turn-end'].safeParse(data); if (parsed.success) emit('done', `turn ${parsed.data.turn} ${parsed.data.status}${parsed.data.error ? `: ${parsed.data.error}` : ''}`); return; }
      case 'thread-state': { const parsed = ProjectLedgerDataSchemas['thread-state'].safeParse(data); if (parsed.success) emit('state', `${parsed.data.from ?? 'new'} to ${parsed.data.to}${parsed.data.reason ? ` (${parsed.data.reason})` : ''}`); return; }
      case 'thread-turn-start': { const parsed = ProjectLedgerDataSchemas['thread-turn-start'].safeParse(data); if (parsed.success) emit('state', `turn ${parsed.data.turn} started on ${parsed.data.model} ${parsed.data.effort}`); return; }
      case 'thread-turn-end': { const parsed = ProjectLedgerDataSchemas['thread-turn-end'].safeParse(data); if (parsed.success) emit('done', `turn ${parsed.data.turn} ${parsed.data.status}${parsed.data.error ? `: ${parsed.data.error}` : ''}`); return; }
      case 'thread-report': { const parsed = ProjectLedgerDataSchemas['thread-report'].safeParse(data); if (parsed.success) emit('text', `report ${parsed.data.status}: ${parsed.data.summary}`); return; }
      case 'thread-verification': { const parsed = ProjectLedgerDataSchemas['thread-verification'].safeParse(data); if (parsed.success) emit('land', `checks ${parsed.data.status} (attempt ${parsed.data.attempt})`); return; }
      case 'thread-publication': { const parsed = ProjectLedgerDataSchemas['thread-publication'].safeParse(data); if (parsed.success && ['landed', 'main-published'].includes(parsed.data.result)) emit('land', `landed as ${(parsed.data.commit ?? '').slice(0, 7)}`); return; }
      default: return;
    }
  }
  publish(input: Omit<OwnerEvent, 'schema' | 'seq' | 'at'> & { at?: string }): OwnerEvent {
    const event = OwnerEventSchema.parse({ schema: 'owner-event-v1', seq: ++this.#seq, at: input.at ?? new Date().toISOString(), projectId: input.projectId, source: input.source, kind: input.kind, text: this.app.redactor.text(input.text) });
    this.#events.push(event); if (this.#events.length > KEEP) this.#events.splice(0, this.#events.length - KEEP);
    for (const listener of this.#listeners) listener(event);
    return event;
  }
  since(after: number, projectId?: string): OwnerEvent[] { return this.#events.filter(event => event.seq > after && (!projectId || event.projectId === projectId)); }
  subscribe(listener: (event: OwnerEvent) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

  /** Server-Sent Events from `after`, then live; a comment every 15 seconds keeps the connection open. */
  stream(response: ServerResponse, after: number, projectId?: string): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: OwnerEvent) => { if (!projectId || event.projectId === projectId) response.write(`id: ${event.seq}\nevent: owner\ndata: ${JSON.stringify(event)}\n\n`); };
    for (const event of this.since(after, projectId)) send(event);
    const stop = this.subscribe(send);
    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000); keepAlive.unref();
    response.on('close', () => { stop(); clearInterval(keepAlive); });
  }
}
