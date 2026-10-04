import { ThreadIndexSchema, stableJson, type ProjectHub, type ThreadIndex } from '@jevellan/core';

export type IndexUpdate = { index: ThreadIndex; eventId: number };
const status = (error: unknown) => (error as { status?: unknown } | undefined)?.status;

/**
 * Publishes thread indexes to the hub (brief 5.6, D10). Mirrors `IndexDelivery`: the latest update per thread wins,
 * older event ids are ignored, a failed drain retries after `retryMs`, and pending data is rebuilt from thread.json at
 * startup (never read authority). A hub 409 for an event id means an earlier run published different content for the
 * same id (a crash between the state file and its ledger event); `conflict` appends a fresh event and returns the new
 * update so the index can move forward; other refusals except 401, 408 and 429 drop the update (D139).
 */
export class ThreadIndexPublisher {
  readonly #pending = new Map<string, IndexUpdate>();
  #conflict: ((threadId: string) => IndexUpdate | undefined) | undefined;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  constructor(private readonly hub: Pick<ProjectHub, 'publishThread'>, private readonly retryMs = 30_000) {}
  onConflict(handler: (threadId: string) => IndexUpdate | undefined): void { this.#conflict = handler; }
  get pending(): number { return this.#pending.size; }
  enqueue(index: ThreadIndex, eventId: number): void {
    if (this.#closed) return;
    const update = { index: ThreadIndexSchema.parse(index), eventId };
    if (!Number.isSafeInteger(eventId) || eventId < 1) throw new Error('Invalid thread index event.');
    const pending = this.#pending.get(update.index.id);
    if (pending && (pending.eventId > eventId || stableJson(pending) === stableJson(update))) return;
    this.#pending.set(update.index.id, update);
    queueMicrotask(() => { if (!this.#closed && !this.#timer) void this.flush().catch(() => undefined); });
  }
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    if (this.#running) return this.#running;
    this.#running = this.#drain().catch((error: unknown) => {
      if (!this.#closed) { this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush().catch(() => undefined); }, this.retryMs); this.#timer.unref(); }
      throw error;
    }).finally(() => {
      this.#running = undefined;
      if (!this.#closed && !this.#timer && this.#pending.size) queueMicrotask(() => { void this.flush().catch(() => undefined); });
    });
    return this.#running;
  }
  async #drain(): Promise<void> {
    while (!this.#closed && this.#pending.size) {
      const [threadId, update] = this.#pending.entries().next().value!;
      let receipt: { eventId: number };
      try { receipt = await this.hub.publishThread(update.index, update.eventId); }
      catch (error) {
        const code = status(error); const current = this.#pending.get(threadId) === update;
        const next = code === 409 && current ? this.#conflict?.(threadId) : undefined;
        if (next && next.eventId > update.eventId) { if (this.#pending.get(threadId) === update) this.#pending.set(threadId, next); continue; }
        // Any other refusal can never succeed; dropping it keeps one thread from holding back every other index.
        // Authentication, timeouts and rate limits are passing conditions and retry.
        if (typeof code === 'number' && code >= 400 && code < 500 && ![401, 408, 429].includes(code)) { if (current) this.#pending.delete(threadId); continue; }
        throw error;
      }
      if (receipt.eventId < update.eventId) throw new Error('The hub did not acknowledge this thread index.');
      if (this.#pending.get(threadId) === update) this.#pending.delete(threadId);
    }
  }
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    await this.#running?.catch(() => undefined);
  }
}
