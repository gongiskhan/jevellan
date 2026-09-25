import { IndexReceiptSchema, IndexUpdateSchema, indexKind, stableJson, type IndexUpdate, type SharedIndexes } from '@jevellan/core';

/** Pending data is rebuilt from owner ledgers on startup, never used as read authority. */
export class IndexDelivery {
  readonly #pending = new Map<string, IndexUpdate>();
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  constructor(readonly store: SharedIndexes, private readonly retryMs = 30_000) {}
  enqueue(raw: IndexUpdate): void {
    if (this.#closed) return;
    const update = IndexUpdateSchema.parse(raw); const key = `${indexKind(update.document)}:${update.document.id}`;
    const pending = this.#pending.get(key);
    if (pending && (pending.eventId > update.eventId || stableJson(pending) === stableJson(update))) return;
    this.#pending.set(key, update);
    queueMicrotask(() => { if (!this.#closed && !this.#timer) void this.flush().catch(() => undefined); });
  }
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    if (this.#running) return this.#running;
    this.#running = this.#drain().catch(error => {
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
      // A decision or correction can only be accepted after its owner is known.
      const [key, update] = [...this.#pending.entries()].find(([, value]) => indexKind(value.document) === 'conversations') ?? this.#pending.entries().next().value!;
      const receipt = IndexReceiptSchema.parse(await this.store.publish(update));
      if (receipt.id !== update.document.id || receipt.kind !== indexKind(update.document) || receipt.eventId < update.eventId) throw new Error('The hub did not acknowledge this index update.');
      if (this.#pending.get(key) === update) this.#pending.delete(key);
    }
  }
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    await this.#running?.catch(() => undefined);
  }
}
