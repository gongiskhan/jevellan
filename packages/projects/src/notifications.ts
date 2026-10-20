import { createHash } from 'node:crypto';
import { ProjectNotificationSchema, clipRedacted, type ProjectHub, type ProjectLedgerEvent, type ProjectNotification, type SharedProjects, type SecretRedactor } from '@jevellan/core';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import type { ThreadStore } from './stores.js';
import { notificationCoordinatorStopped, notificationFailedBody, notificationThreadTitle } from './copy.js';
const week = 7 * 86400000;
function plain(value: string): string {
  const code: string[] = [];
  const keep = (text: string) => `\uE000${code.push(text) - 1}\uE001`;
  return value.replace(/^```[^\n]*\n([\s\S]*?)^```/gmu, (_all, text: string) => keep(text)).replace(/`+([^`]+)`+/gu, (_all, text: string) => keep(text))
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, '$2').replace(/(^|[\s(])([*_])(\S(?:[^\n]*?\S)?)\2(?=$|[\s.,!?:;)])/gu, '$1$3')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\uE000(\d+)\uE001/gu, (_all, index: string) => code[Number(index)] ?? '').replace(/\s+/gu, ' ').trim();
}
type Pending = { id: string; projectId: string; threadId?: string; kind: ProjectNotification['kind']; body: string; at: string };
/** Canonical ledger events are the retry source across a crash or an offline hub. */
export class ProjectNotifications {
  readonly #pending = new Map<string, Pending>();
  readonly #text = new Map<string, string>();
  readonly #failures = new Map<string, number>();
  readonly #seen = new Map<string, number>();
  readonly #unsubscribe: () => void;
  #flushing: Promise<void> | undefined;
  constructor(readonly o: { deviceId: string; ledgers: ProjectLedgers; store: ThreadStore; hub: ProjectHub; projects: SharedProjects; redactor: SecretRedactor; now(): number }) {
    this.#unsubscribe = o.ledgers.subscribe((ledger, event) => { this.#consume(ledger, event); void this.flush().catch(() => undefined); });
  }
  busy() { return Boolean(this.#flushing); }
  async rebuild(): Promise<void> {
    for (const id of this.o.ledgers.paths.projectIds()) for (const ledger of [this.o.ledgers.coordinator(id), ...this.o.ledgers.paths.threadIds(id).map(tid => this.o.ledgers.thread(id, tid))])
      for (const event of ledger.events()) this.#consume(ledger, event);
    await this.flush().catch(() => undefined);
  }
  #consume(ledger: ProjectLedger, event: ProjectLedgerEvent): void {
    if (!['coordinator-text', 'coordinator-turn-end', 'coordinator-event', 'thread-state', 'thread-report'].includes(event.type) || Date.parse(event.t) < this.o.now() - week) return;
    const source = `${ledger.projectId}:${ledger.threadId ?? 'coordinator'}`;
    if (event.id <= (this.#seen.get(source) ?? 0)) return;
    this.#seen.set(source, event.id);
    // An owner message is the owner's retry of a stopped coordinator: the failures after it are a new episode with its own notification.
    if (event.type === 'coordinator-event') { if (ledger.payload(event as typeof event & { type: 'coordinator-event' }).kind === 'user-message') this.#failures.delete(source); return; }
    const key = `${source}:${event.turn ?? 0}`;
    if (event.type === 'coordinator-text') { this.#text.set(key, ((this.#text.get(key) ?? '') + ledger.payload(event as typeof event & { type: 'coordinator-text' }).text).slice(0, 8000)); return; }
    const enqueue = (kind: Pending['kind'], body: string) => {
      if (!body.trim() || Date.parse(event.t) < this.o.now() - week) return;
      const id = `pnotify_${createHash('sha256').update(`${this.o.deviceId}:${source}:${event.id}:${kind}`).digest('hex')}`;
      this.#pending.set(id, { id, projectId: ledger.projectId, ...(ledger.threadId ? { threadId: ledger.threadId } : {}), kind, body, at: event.t });
    };
    if (event.type === 'coordinator-turn-end') {
      const end = ledger.payload(event as typeof event & { type: 'coordinator-turn-end' });
      enqueue('coordinator-reply', plain(this.#text.get(key) ?? '')); this.#text.delete(key);
      const failures = end.retrying || !['completed', 'failed', 'timed-out'].includes(end.status) ? this.#failures.get(source) ?? 0 : end.status === 'completed' ? 0 : (this.#failures.get(source) ?? 0) + 1;
      this.#failures.set(source, failures); if (failures === 2 && !end.retrying && ['failed', 'timed-out'].includes(end.status)) enqueue('coordinator-unavailable', notificationCoordinatorStopped(end.error ?? end.status));
    } else if (event.type === 'thread-state') {
      const state = ledger.payload(event as typeof event & { type: 'thread-state' }); if (state.to === 'failed') enqueue('thread-failed', notificationFailedBody(state.reason ?? 'Unknown reason.'));
    } else if (event.type === 'thread-report') enqueue('thread-finished', ledger.payload(event as typeof event & { type: 'thread-report' }).summary.split('\n')[0]!);
  }
  async flush(): Promise<void> {
    // Ledger acknowledgements precede their queued subscribers. Fence that delivery before draining.
    await Promise.resolve();
    if (this.#flushing) { await this.#flushing; if (this.#pending.size) return this.flush(); return; }
    if (!this.#pending.size) return Promise.resolve();
    const work = (async () => {
      for (const [id, pending] of this.#pending) {
        const project = (await this.o.projects.get(pending.projectId))?.project; if (!project) { this.#pending.delete(id); continue; }
        const thread = pending.threadId ? this.o.store.get(pending.threadId) : undefined;
        const title = thread ? notificationThreadTitle(project.name, thread.title) : project.name;
        await this.o.hub.putNotification?.(ProjectNotificationSchema.parse({ schema: 'project-notification-v1', revision: 0, id, projectId: project.id, kind: pending.kind,
          title: clipRedacted(this.o.redactor.text(title), 80), body: clipRedacted(this.o.redactor.text(pending.body), 180),
          url: `/projects/${project.id}${thread ? `/threads/${thread.id}` : ''}`, tag: `${project.id}:${thread ? `thread:${thread.id}` : 'coordinator'}`, createdAt: pending.at }));
        this.#pending.delete(id);
      }
    })();
    this.#flushing = work; void work.finally(() => { if (this.#flushing === work) this.#flushing = undefined; }).catch(() => undefined); return work;
  }
  async close(): Promise<void> { this.#unsubscribe(); await this.flush().catch(() => undefined); }
}
