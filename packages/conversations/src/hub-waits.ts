import { CheckpointBlockSchema, ConversationNoticeSchema, HubWaitSchema, newId, type HubWait } from '@jevellan/core';
import { HubUnavailable } from '@jevellan/mesh';
import type { ConversationWork } from './work.js';

type Options = {
  shouldRetry?(): boolean;
  beforeRetry?(): void | Promise<void>;
  checkpoint?: HubWait['checkpoint'];
  owner?: Pick<HubWait, 'workId' | 'generation'>;
};

/** Only the running daemon owns continuations. The ledger stores evidence, never executable work. */
export class HubWaits {
  #revision = 0;
  readonly #wake = new Set<() => void>();
  reachable(): void { this.#revision++; for (const wake of [...this.#wake]) wake(); }

  async retry<T>(work: ConversationWork, signal: AbortSignal, boundary: HubWait['boundary'], run: () => Promise<T>, options: Options = {}): Promise<T> {
    let record: HubWait | undefined;
    const save = (status: HubWait['status']) => {
      if (record) work.ledger.append({ type: 'notice', data: HubWaitSchema.parse({ ...record, status, at: new Date().toISOString() }) });
    };
    try {
      for (;;) {
        signal.throwIfAborted(); const revision = this.#revision;
        try {
          const result = await run(); save('completed'); return result;
        } catch (error) {
          if (!(error instanceof HubUnavailable) || options.shouldRetry?.() === false) throw error;
          signal.throwIfAborted();
          if (!record) {
            const current = work.load().conversation;
            const owner = options.owner ?? (current.work ? { workId: current.work.id, generation: current.generation } : undefined);
            if (!owner) throw error;
            record = HubWaitSchema.parse({ schema: 'hub-wait-v1', id: newId('hub_wait'), ...owner,
              boundary, status: 'waiting', message: error.message, at: new Date().toISOString(), ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) });
            save('waiting');
            work.ledger.append({ type: 'notice', data: ConversationNoticeSchema.parse({ schema: 'conversation-notice-v1', kind: 'info', text: error.message }) });
            if (current.work?.id === owner.workId && current.state !== 'running') work.pause(error.message, 'blocked');
          }
          await this.#wait(signal, revision);
          await options.beforeRetry?.();
        }
      }
    } catch (error) { save('interrupted'); throw error; }
  }

  #wait(signal: AbortSignal, revision: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const clean = () => { this.#wake.delete(wake); signal.removeEventListener('abort', abort); };
      const wake = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      this.#wake.add(wake); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (revision !== this.#revision) wake();
    });
  }
}

export function recoverHubWaits(work: ConversationWork): void {
  const records = new Map<string, HubWait>();
  for (const event of work.ledger.events()) {
    if (event.type !== 'notice') continue;
    const parsed = HubWaitSchema.safeParse(work.ledger.data(event));
    if (parsed.success) records.set(parsed.data.id, parsed.data);
  }
  for (const record of records.values()) {
    if (record.status !== 'waiting') continue;
    const reason = 'Jevellan restarted while waiting for the hub. Review this work before continuing; no step was relaunched.';
    work.ledger.append({ type: 'notice', data: HubWaitSchema.parse({ ...record, status: 'interrupted', at: new Date().toISOString() }) });
    if (record.checkpoint) work.ledger.append({ type: 'git', stretch: record.checkpoint.stretch, data: CheckpointBlockSchema.parse({
      schema: 'checkpoint-block-v1', workId: record.workId, ...record.checkpoint, reason,
    }) });
    const current = work.load().conversation;
    if (current.work?.id === record.workId && current.state !== 'running') work.pause(reason, 'waiting-for-you');
    work.ledger.append({ type: 'notice', data: ConversationNoticeSchema.parse({ schema: 'conversation-notice-v1', kind: 'info', text: reason }) });
  }
}
