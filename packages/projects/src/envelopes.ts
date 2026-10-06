import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  INBOX_SEEN_LIMIT, InboxSeenSchema, OutboxEntrySchema, OutboxSeqSchema, ProjectEnvelopeSchema, compareEnvelopes, readDocument, stableJson, writeDocument,
  boundedRedaction, type OutboxEntry, type ProjectEnvelope, type ProjectHub, type SecretRedactor, type UnreadableEnvelope,
} from '@jevellan/core';
import { derivedId } from './decision-items.js';
import type { ProjectPaths } from './paths.js';

type EnvelopeBody = ProjectEnvelope['body'];
export type EnvelopeOf<K extends EnvelopeBody['kind']> = Omit<ProjectEnvelope, 'body'> & { body: Extract<EnvelopeBody, { kind: K }> };
const ENTRY_FILE = /^\d{12}-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;

/** A refusal that can never succeed: a 4xx other than authentication, timeout and rate limit (the D139 rule). Anything else is retried. */
export function permanentRefusal(error: unknown): boolean {
  const code = (error as { status?: unknown } | undefined)?.status;
  return typeof code === 'number' && code >= 400 && code < 500 && ![401, 408, 429].includes(code);
}
/** The delay before the next attempt after `failures` failed drains in a row: `retryMs` doubling up to `maxMs` (10, 20, 40, 60, 60 s). */
export function outboxRetryDelay(failures: number, retryMs: number, maxMs: number): number {
  return Math.min(retryMs * 2 ** Math.max(0, failures - 1), maxMs);
}
/** What a message is about: coordinator events by event id, starts by thread id, commands by command id. */
function bodyKey(body: EnvelopeBody): string {
  switch (body.kind) {
    case 'coordinator-event': return body.event.id;
    case 'thread-start': return body.thread.id;
    case 'thread-command': return body.commandId;
  }
}

export type OutboxOptions = {
  paths: ProjectPaths; hub: Pick<ProjectHub, 'putEnvelope' | 'coordinator'>; deviceId: string; redactor: SecretRedactor;
  timers: { outboxRetryMs: number; outboxMaxMs: number; now(): number };
  /** The hub holds `envelope` now (the facade wakes its own inbox when this device is the target). */
  delivered?(envelope: ProjectEnvelope): void;
};

/**
 * The durable sender side of the hub relay (D40, brief phase 5). Each message is a file under `<home>/projects/<pid>/outbox/`
 * named by a per-project sequence, put on the hub strictly in that order and deleted once the hub holds it. Envelope ids derive
 * from the source, project and message identity, so a message enqueued again repeats its envelope (the hub and the target
 * dedupe it). Coordinator events resolve their target from the hub assignment when first sent, and keep it (D261). A refusal
 * that can never succeed drops its entry (D262); any other failure stops the drain and retries after 10, 20, 40, 60, 60 s.
 */
export class Outbox {
  readonly #o: OutboxOptions;
  #running: Promise<void> = Promise.resolve();
  #queued: Promise<void> | undefined;
  #active = false;
  #failures = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  constructor(options: OutboxOptions) { this.#o = options; }
  #entries(projectId: string): Array<{ file: string; entry: OutboxEntry }> {
    const directory = this.#o.paths.outbox(projectId); if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => ENTRY_FILE.test(name)).sort().map((name) => {
      const entry = readDocument(join(directory, name), OutboxEntrySchema);
      if (entry.envelope.projectId !== projectId || !name.endsWith(`-${entry.envelope.id}.json`)) throw new Error('An outbox entry does not match its file.');
      return { file: join(directory, name), entry };
    });
  }
  /** Undelivered messages in delivery order, of one project or of all. */
  pending(projectId?: string): OutboxEntry[] {
    return (projectId === undefined ? this.#o.paths.projectIds() : [projectId]).flatMap((id) => this.#entries(id).map(({ entry }) => entry));
  }
  /** A drain is running or waiting to run (the `ProjectWork.idle` test seam); a scheduled retry is not. */
  get busy(): boolean { return this.#active || this.#queued !== undefined; }
  /**
   * Queues a message for `target`, a device id, or `coordinator` for coordinator events (and only them), then drains. The
   * sequence file is written before the entry, so a crash leaves a gap, never a reused number. A message still waiting is
   * returned as it is; the same message id with other content is refused.
   */
  enqueue(projectId: string, target: string, raw: EnvelopeBody, options: { handover?: string } = {}): OutboxEntry {
    // Redaction never lengthens a text that was checked against its maximum (P8 review S-1).
    const body = ProjectEnvelopeSchema.shape.body.parse(boundedRedaction(this.#o.redactor, raw));
    if ((body.kind === 'coordinator-event') !== (target === 'coordinator')) throw new Error('Coordinator events, and only they, go to the coordinator device.');
    if (body.kind === 'thread-start' && (body.thread.projectId !== projectId || body.thread.ownerDeviceId !== target)) throw new Error('A thread starts on its owner device.');
    const entries = this.#entries(projectId); const key = bodyKey(body);
    const waiting = entries.find(({ entry }) => entry.envelope.body.kind === body.kind && bodyKey(entry.envelope.body) === key);
    if (waiting) {
      if (stableJson(waiting.entry.envelope.body) !== stableJson(body)) throw Object.assign(new Error('This message is already waiting with different content.'), { status: 409 });
      return waiting.entry;
    }
    const seqFile = this.#o.paths.outboxSeq(projectId);
    const seq = Math.max(existsSync(seqFile) ? readDocument(seqFile, OutboxSeqSchema).seq : 0, ...entries.map(({ entry }) => entry.envelope.seq)) + 1;
    writeDocument(seqFile, OutboxSeqSchema, { schema: 'project-outbox-seq-v1', seq });
    // A coordinator handover names the assignment it follows, so an event that comes back here after a later move gets an envelope of its
    // own instead of one the receiver has seen (P8 review RL-1); repeating the same handover repeats its envelope.
    const id = derivedId('env', projectId, this.#o.deviceId, body.kind, key, ...(options.handover === undefined ? [] : ['handover', options.handover]));
    const entry = OutboxEntrySchema.parse({ schema: 'project-outbox-entry-v1', target, envelope: { schema: 'project-envelope-v1', id, projectId,
      sourceDeviceId: this.#o.deviceId, seq, createdAt: new Date(this.#o.timers.now()).toISOString(), body } });
    writeDocument(join(this.#o.paths.outbox(projectId), `${String(seq).padStart(12, '0')}-${id}.json`), OutboxEntrySchema, entry);
    void this.drain();
    return entry;
  }
  /**
   * Puts every waiting entry, project by project in sequence order, now (a scheduled retry is replaced). Calls made while a drain
   * runs share one follow-up drain, so nothing enqueued meanwhile waits for a timer. Never rejects: failures schedule the retry.
   */
  drain(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#queued) return this.#queued;
    const run = this.#queued = this.#running.then(async () => {
      this.#queued = undefined;
      if (this.#closed) return;
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
      this.#active = true;
      try { await this.#drain(); this.#failures = 0; }
      catch {
        this.#failures += 1;
        if (!this.#closed) {
          this.#timer = setTimeout(() => { this.#timer = undefined; void this.drain(); }, outboxRetryDelay(this.#failures, this.#o.timers.outboxRetryMs, this.#o.timers.outboxMaxMs));
          this.#timer.unref();
        }
      } finally { this.#active = false; }
    });
    this.#running = run;
    return run;
  }
  async #drain(): Promise<void> {
    for (const projectId of this.#o.paths.projectIds()) {
      let coordinator: string | undefined;
      for (const { file, entry } of this.#entries(projectId)) {
        if (this.#closed) return;
        let target = entry.target;
        if (target === 'coordinator') {
          // No assignment yet: the event waits in this device's own coordinator queue (D6).
          coordinator ??= (await this.#o.hub.coordinator(projectId))?.document.deviceId ?? this.#o.deviceId;
          target = coordinator;
          // Kept from the first attempt: a retry after a lost reply must repeat the envelope the hub may hold (D261).
          writeDocument(file, OutboxEntrySchema, { ...entry, target });
        }
        const envelope = ProjectEnvelopeSchema.parse({ ...entry.envelope, targetDeviceId: target, revision: 0 });
        let stored = true;
        try { await this.#o.hub.putEnvelope(envelope); }
        catch (error) { if (!permanentRefusal(error)) throw error; stored = false; }
        rmSync(file, { force: true });
        if (stored) this.#o.delivered?.(envelope);
      }
    }
  }
  /** Stops the retry timer and waits for a running drain; entries stay on disk for the next start. */
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}

export type InboxHandlers = {
  coordinatorEvent(envelope: EnvelopeOf<'coordinator-event'>): Promise<void>;
  threadStart(envelope: EnvelopeOf<'thread-start'>): Promise<void>;
  threadCommand(envelope: EnvelopeOf<'thread-command'>): Promise<void>;
};
export type InboxOptions = {
  paths: ProjectPaths; hub: Pick<ProjectHub, 'pendingEnvelopes' | 'ackEnvelope'>; deviceId: string; handlers: InboxHandlers;
  timers: { periodic: boolean; inboxPollMs: number };
  /** An envelope this device could not read was acknowledged and is lost (P8 review S-2): the caller says so where the owner looks. */
  dropped?(envelope: UnreadableEnvelope): void;
};

/**
 * The receiver side of the hub relay (D40). A poll reads this device's pending envelopes in relay order (source, project,
 * sequence), hands each to its handler, records its id in `<home>/projects/inbox-seen.json` (the newest 2,000) and acknowledges
 * it, which deletes it from the hub (D90). A seen id is only acknowledged again, so a re-put after a lost reply runs nothing twice;
 * the handlers are idempotent on their own as well. A handler's permanent refusal drops the envelope (D262); any other failure
 * holds the rest of that source's project sequence until the next poll, while other sequences continue.
 */
export class Inbox {
  readonly #o: InboxOptions;
  #seen: { ids: string[]; set: Set<string> } | undefined;
  #running: Promise<void> = Promise.resolve();
  #queued: Promise<void> | undefined;
  #active = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #closed = false;
  constructor(options: InboxOptions) { this.#o = options; }
  get busy(): boolean { return this.#active || this.#queued !== undefined; }
  /** Polls every `inboxPollMs` from now on when timers are periodic; tests call `poll()` instead. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    if (this.#o.timers.periodic) void this.poll();
  }
  /** An envelope for this device was stored: poll now. */
  kick(): void { void this.poll(); }
  /** One round now; calls made while a poll runs share one follow-up poll. Never rejects: a hub failure waits for the next poll. */
  poll(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#queued) return this.#queued;
    const run = this.#queued = this.#running.then(async () => {
      this.#queued = undefined;
      if (this.#closed) return;
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
      this.#active = true;
      try { await this.#poll(); } catch { /* The next poll retries. */ } finally { this.#active = false; }
      if (this.#started && this.#o.timers.periodic && !this.#closed && !this.#timer && !this.#queued) {
        this.#timer = setTimeout(() => { this.#timer = undefined; void this.poll(); }, this.#o.timers.inboxPollMs); this.#timer.unref();
      }
    });
    this.#running = run;
    return run;
  }
  #seenIds(): { ids: string[]; set: Set<string> } {
    if (this.#seen) return this.#seen;
    const file = this.#o.paths.inboxSeen(); const ids = existsSync(file) ? readDocument(file, InboxSeenSchema).ids : [];
    return this.#seen = { ids, set: new Set(ids) };
  }
  #remember(id: string): void {
    const ids = [...this.#seenIds().ids.filter((seen) => seen !== id), id].slice(-INBOX_SEEN_LIMIT);
    writeDocument(this.#o.paths.inboxSeen(), InboxSeenSchema, { schema: 'project-inbox-seen-v1', ids });
    this.#seen = { ids, set: new Set(ids) };
  }
  #handle(envelope: ProjectEnvelope): Promise<void> {
    const handlers = this.#o.handlers;
    switch (envelope.body.kind) {
      case 'coordinator-event': return handlers.coordinatorEvent(envelope as EnvelopeOf<'coordinator-event'>);
      case 'thread-start': return handlers.threadStart(envelope as EnvelopeOf<'thread-start'>);
      case 'thread-command': return handlers.threadCommand(envelope as EnvelopeOf<'thread-command'>);
    }
  }
  async #poll(): Promise<void> {
    const held = new Set<string>();
    for (;;) {
      const page = await this.#o.hub.pendingEnvelopes(this.#o.deviceId);
      let acknowledged = 0;
      // A record this device cannot read never will be (P8 review S-2): it is acknowledged and reported once, so it holds nothing back.
      // One without a readable id cannot be acknowledged and stays on the hub.
      for (const unreadable of page.unreadable ?? []) {
        if (this.#closed) return;
        if (unreadable.id === null) continue;
        if (!this.#seenIds().set.has(unreadable.id)) { this.#o.dropped?.(unreadable); this.#remember(unreadable.id); }
        await this.#o.hub.ackEnvelope(unreadable.id); acknowledged += 1;
      }
      for (const envelope of [...page.records].sort(compareEnvelopes)) {
        if (this.#closed) return;
        const sequence = `${envelope.sourceDeviceId}\0${envelope.projectId}`;
        if (held.has(sequence) || envelope.targetDeviceId !== this.#o.deviceId) continue;
        if (!this.#seenIds().set.has(envelope.id)) {
          try { await this.#handle(envelope); }
          catch (error) { if (!permanentRefusal(error)) { held.add(sequence); continue; } }
          this.#remember(envelope.id);
        }
        await this.#o.hub.ackEnvelope(envelope.id); acknowledged += 1;
      }
      // Another page only while this one made progress: a page of held sequences waits for the next poll.
      if (!page.more || !acknowledged) return;
    }
  }
  /** Stops polling and waits for a running poll. */
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }
}
