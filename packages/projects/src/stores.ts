import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  CoordinatorLocalSchema, CoordinatorStateSchema, ThreadIndexSchema, ThreadLocalSchema, ThreadSchema, ThreadStartReceiptSchema, readDocument, stableJson,
  writeDocument, type CoordinatorLocal, type CoordinatorState, type ProjectLedgerEvent, type Thread, type ThreadIndex, type ThreadLocal,
} from '@jevellan/core';
import { START_REQUEST_REUSED, THREAD_NOT_FOUND } from './copy.js';
import type { ProjectLedgers } from './ledger.js';
import type { ProjectPaths } from './paths.js';
import type { IndexUpdate, ThreadIndexPublisher } from './index-publisher.js';

export type ThreadLabels = { modelLabel: string; accountLabel: string };
export type ThreadEvent = { type: ProjectLedgerEvent['type']; data: unknown; turn?: number | undefined };
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * The hub copy of a thread (brief 5.6). A pure function of thread.json, its labels and the thread ledger's last event,
 * so one event id always yields the same document (the hub refuses a different index for a published id, D124, D138).
 * Never copies cwd, the native session id or queued messages.
 */
export function threadIndex(thread: Thread, labels: ThreadLabels, updatedAt: string): ThreadIndex {
  return ThreadIndexSchema.parse({
    schema: 'project-thread-index-v1', revision: 0, id: thread.id, projectId: thread.projectId, title: thread.title, state: thread.state,
    ...(thread.stateReason === undefined ? {} : { stateReason: thread.stateReason }), isolation: thread.isolation, ownerDeviceId: thread.ownerDeviceId,
    runtime: thread.placement.runtime, modelLabel: labels.modelLabel, effort: thread.placement.effortEffective, accountLabel: labels.accountLabel,
    ...(thread.branch === undefined ? {} : { branch: thread.branch }), ...(thread.pr ? { pr: thread.pr } : {}),
    ...(thread.lastReport ? { lastSummary: thread.lastReport.summary.slice(0, 400) } : {}), turns: thread.turns,
    createdAt: thread.createdAt, updatedAt, ...(thread.endedAt === undefined ? {} : { endedAt: thread.endedAt }),
  });
}
/** Index fields that differ between two versions of a thread (revision and updatedAt excluded). */
export function changedIndexFields(before: ThreadIndex, after: ThreadIndex): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => key !== 'revision' && key !== 'updatedAt'));
  return [...keys].filter((key) => stableJson(before[key as keyof ThreadIndex]) !== stableJson(after[key as keyof ThreadIndex])).sort();
}

/**
 * thread.json and thread-local.json on the owner device, write-through cached. Every change that the index shows
 * appends a thread ledger event and enqueues the index under that event id (D10). Write order: state file, then
 * ledger; startup reconciliation repairs a missing event.
 */
export class ThreadStore {
  #threads: Map<string, Thread> | undefined;
  readonly #locals = new Map<string, ThreadLocal>();
  constructor(readonly paths: ProjectPaths, readonly ledgers: ProjectLedgers, readonly publisher: ThreadIndexPublisher) {
    publisher.onConflict((threadId) => this.#republish(threadId));
  }
  #all(): Map<string, Thread> {
    if (this.#threads) return this.#threads;
    const threads = new Map<string, Thread>();
    for (const projectId of this.paths.projectIds()) {
      for (const threadId of this.paths.threadIds(projectId)) {
        const path = this.paths.threadFile(projectId, threadId); if (!existsSync(path)) continue;
        const thread = readDocument(path, ThreadSchema);
        if (thread.id !== threadId || thread.projectId !== projectId) throw new Error('A thread file does not match its folder.');
        threads.set(threadId, thread);
      }
    }
    return this.#threads = threads;
  }
  /** Every thread on this device, oldest first. */
  all(): Thread[] { return [...this.#all().values()].sort((a, b) => a.id.localeCompare(b.id)).map((thread) => structuredClone(thread)); }
  list(projectId: string): Thread[] { return this.all().filter((thread) => thread.projectId === projectId); }
  get(threadId: string): Thread | undefined { const thread = this.#all().get(threadId); return thread && structuredClone(thread); }
  #require(threadId: string): Thread {
    const thread = this.#all().get(threadId); if (!thread) throw refuse(THREAD_NOT_FOUND, 404);
    return thread;
  }
  /** Creates thread.json, records `thread-placement` and the first `thread-state`, and publishes the index. An existing thread is returned unchanged. */
  create(raw: Thread, labels: ThreadLabels): Thread {
    const existing = this.get(raw.id); if (existing) return existing;
    const thread = writeDocument(this.paths.threadFile(raw.projectId, raw.id), ThreadSchema, raw);
    this.#all().set(thread.id, thread);
    this.updateLocal(thread.id, (local) => ({ ...local, labels }));
    const ledger = this.ledgers.thread(thread.projectId, thread.id);
    ledger.append({ type: 'thread-placement', data: thread.placement });
    const event = ledger.append({ type: 'thread-state', data: { schema: 'thread-state-v1', from: null, to: thread.state, ...(thread.stateReason === undefined ? {} : { reason: thread.stateReason }), changed: [] } });
    this.publisher.enqueue(threadIndex(thread, labels, event.t), event.id);
    return structuredClone(thread);
  }
  /**
   * Writes thread.json, then appends `event` when given and a `thread-state` when the state or its reason changed (both
   * when both apply, D139), or a `thread-state` naming the changed fields when only other index fields changed. The
   * index is published under the last appended event id.
   */
  update(threadId: string, mutate: (thread: Thread) => Thread, event?: ThreadEvent): Thread {
    const before = this.#require(threadId);
    const thread = ThreadSchema.parse(mutate(structuredClone(before)));
    if (thread.id !== before.id || thread.projectId !== before.projectId) throw new Error('A thread update cannot change its identity.');
    const labels = this.labels(threadId);
    const changed = changedIndexFields(threadIndex(before, labels, before.createdAt), threadIndex(thread, labels, before.createdAt));
    if (stableJson(thread) !== stableJson(before)) writeDocument(this.paths.threadFile(thread.projectId, thread.id), ThreadSchema, thread);
    this.#all().set(threadId, thread);
    const ledger = this.ledgers.thread(thread.projectId, thread.id); let last: ProjectLedgerEvent | undefined;
    if (event) last = ledger.append({ type: event.type, data: event.data, ...(event.turn === undefined ? {} : { turn: event.turn }) });
    const stateChanged = thread.state !== before.state || thread.stateReason !== before.stateReason;
    if (stateChanged || (!event && changed.length)) last = ledger.append({ type: 'thread-state', data: this.#stateChange(before.state, thread, changed) });
    if (last) this.publisher.enqueue(threadIndex(thread, labels, last.t), last.id);
    return structuredClone(thread);
  }
  #stateChange(from: Thread['state'] | null, thread: Thread, changed: string[]) {
    return { schema: 'thread-state-v1', from, to: thread.state, ...(thread.stateReason === undefined ? {} : { reason: thread.stateReason }), changed };
  }
  local(threadId: string): ThreadLocal {
    const cached = this.#locals.get(threadId); if (cached) return structuredClone(cached);
    const thread = this.#require(threadId); const path = this.paths.threadLocal(thread.projectId, threadId);
    const local = existsSync(path) ? readDocument(path, ThreadLocalSchema) : ThreadLocalSchema.parse({ schema: 'thread-local-v1' });
    this.#locals.set(threadId, local);
    return structuredClone(local);
  }
  updateLocal(threadId: string, mutate: (local: ThreadLocal) => ThreadLocal): ThreadLocal {
    const thread = this.#require(threadId);
    const local = writeDocument(this.paths.threadLocal(thread.projectId, threadId), ThreadLocalSchema, mutate(this.local(threadId)));
    this.#locals.set(threadId, local);
    return structuredClone(local);
  }
  /** The labels the index shows: the placement-time menu label and the latest turn's account label (D138). */
  labels(threadId: string): ThreadLabels {
    const thread = this.#require(threadId);
    return this.local(threadId).labels ?? { modelLabel: thread.placement.modelId, accountLabel: thread.placement.accountId };
  }
  setLabels(threadId: string, labels: Partial<ThreadLabels>): Thread {
    const current = this.labels(threadId); const next = { ...current, ...labels };
    if (stableJson(next) === stableJson(current)) return structuredClone(this.#require(threadId));
    this.updateLocal(threadId, (local) => ({ ...local, labels: next }));
    const thread = this.#require(threadId); const ledger = this.ledgers.thread(thread.projectId, threadId);
    const changed = changedIndexFields(threadIndex(thread, current, thread.createdAt), threadIndex(thread, next, thread.createdAt));
    const event = ledger.append({ type: 'thread-state', data: this.#stateChange(thread.state, thread, changed) });
    this.publisher.enqueue(threadIndex(thread, next, event.t), event.id);
    return structuredClone(thread);
  }
  /** The index under the ledger's last event, for the startup rebuild (2.6.13 step 7). */
  current(threadId: string): IndexUpdate | undefined {
    const thread = this.#require(threadId); const last = this.ledgers.thread(thread.projectId, threadId).events().at(-1);
    return last && { index: threadIndex(thread, this.labels(threadId), last.t), eventId: last.id };
  }
  /**
   * Startup reconciliation (2.6.13 step 6): when the ledger's last `thread-state` does not end in thread.json's state
   * (a crash between the two writes), appends the corrective event and publishes it. Returns whether it appended.
   */
  reconcile(threadId: string): boolean {
    const thread = this.#require(threadId); const ledger = this.ledgers.thread(thread.projectId, threadId); const events = ledger.events();
    const last = events.filter((event) => event.type === 'thread-state').at(-1);
    const recorded = last && ledger.payload(last as ProjectLedgerEvent & { type: 'thread-state' });
    if (recorded && recorded.to === thread.state && recorded.reason === thread.stateReason) return false;
    if (!events.some((event) => event.type === 'thread-placement')) ledger.append({ type: 'thread-placement', data: thread.placement });
    const event = ledger.append({ type: 'thread-state', data: this.#stateChange(recorded?.to ?? null, thread, []) });
    this.publisher.enqueue(threadIndex(thread, this.labels(threadId), event.t), event.id);
    return true;
  }
  /** Re-enqueues every local thread's index. */
  publishAll(): void {
    for (const thread of this.all()) { const update = this.current(thread.id); if (update) this.publisher.enqueue(update.index, update.eventId); }
  }
  #republish(threadId: string): IndexUpdate | undefined {
    const thread = this.#all().get(threadId); if (!thread) return undefined;
    const event = this.ledgers.thread(thread.projectId, threadId).append({ type: 'thread-state', data: this.#stateChange(thread.state, thread, []) });
    return { index: threadIndex(thread, this.labels(threadId), event.t), eventId: event.id };
  }
}

const defaultCoordinator = (projectId: string): CoordinatorState => CoordinatorStateSchema.parse({ schema: 'coordinator-state-v1', projectId, state: 'idle', session: null, queue: [], failedTurnsInARow: 0 });

/** coordinator.json (brief 5.3, queue flushed before acknowledgement) and coordinator-local.json (D4), write-through cached. */
export class CoordinatorStore {
  readonly #states = new Map<string, CoordinatorState>();
  readonly #locals = new Map<string, CoordinatorLocal>();
  constructor(readonly paths: ProjectPaths) {}
  get(projectId: string): CoordinatorState {
    let state = this.#states.get(projectId);
    if (!state) {
      const path = this.paths.coordinator(projectId);
      state = existsSync(path) ? readDocument(path, CoordinatorStateSchema) : defaultCoordinator(projectId);
      if (state.projectId !== projectId) throw new Error('A coordinator file does not match its folder.');
      this.#states.set(projectId, state);
    }
    return structuredClone(state);
  }
  update(projectId: string, mutate: (state: CoordinatorState) => CoordinatorState): CoordinatorState {
    const state = CoordinatorStateSchema.parse(mutate(this.get(projectId)));
    if (state.projectId !== projectId) throw new Error('A coordinator update cannot change its project.');
    writeDocument(this.paths.coordinator(projectId), CoordinatorStateSchema, state);
    this.#states.set(projectId, state);
    return structuredClone(state);
  }
  local(projectId: string): CoordinatorLocal {
    let local = this.#locals.get(projectId);
    if (!local) {
      const path = this.paths.coordinatorLocal(projectId);
      local = existsSync(path) ? readDocument(path, CoordinatorLocalSchema) : CoordinatorLocalSchema.parse({ schema: 'coordinator-local-v1' });
      this.#locals.set(projectId, local);
    }
    return structuredClone(local);
  }
  updateLocal(projectId: string, mutate: (local: CoordinatorLocal) => CoordinatorLocal): CoordinatorLocal {
    const local = writeDocument(this.paths.coordinatorLocal(projectId), CoordinatorLocalSchema, mutate(this.local(projectId)));
    this.#locals.set(projectId, local);
    return structuredClone(local);
  }
}

/** Owner-created starts are idempotent by clientRequestId (D78), like ProjectSaves: the digest of the normalized request. */
export class StartReceipts {
  constructor(readonly paths: ProjectPaths, private readonly now: () => number = Date.now) {}
  #digest(request: unknown): string { return createHash('sha256').update(stableJson(request)).digest('hex'); }
  get(projectId: string, clientRequestId: string, request: unknown): { threadId: string } | null {
    const path = this.paths.request(projectId, clientRequestId); if (!existsSync(path)) return null;
    const receipt = readDocument(path, ThreadStartReceiptSchema);
    if (receipt.clientRequestId !== clientRequestId || receipt.digest !== this.#digest(request)) throw refuse(START_REQUEST_REUSED, 409);
    return { threadId: receipt.threadId };
  }
  put(projectId: string, clientRequestId: string, request: unknown, threadId: string): void {
    if (this.get(projectId, clientRequestId, request)) return;
    writeDocument(this.paths.request(projectId, clientRequestId), ThreadStartReceiptSchema,
      { schema: 'thread-start-receipt-v1', clientRequestId, digest: this.#digest(request), threadId, at: new Date(this.now()).toISOString() });
  }
}
