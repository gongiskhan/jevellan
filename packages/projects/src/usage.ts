import { HubUnavailable, ProjectUsageDaySchema, ProjectUsageRangeSchema, ProjectUsageViewSchema, ProjectUsagePresentationSchema, ProjectUsageRequestRangeSchema, DEFAULT_PROJECT_USAGE_RANGE, PROJECT_USAGE_REFRESH_MS, type ProjectHub, type ProjectLedgerEvent, type ProjectUsageDay, type ProjectUsageRow, type ProjectUsageView, type ThreadUsageTotal, type UsageSchema } from '@jevellan/core';
import type { z } from 'zod';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import type { ThreadStore } from './stores.js';

export const emptyUsage = (): ThreadUsageTotal => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costUnknownTurns: 0 });
function add(to: ThreadUsageTotal, from: ThreadUsageTotal): void { for (const key of Object.keys(emptyUsage()) as (keyof ThreadUsageTotal)[]) to[key] += from[key]; }
export function usageDay(time: number, timezone: string): string { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time); }
const minusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
export function projectUsageView(projectId: string, range: z.infer<typeof ProjectUsageRangeSchema>, days: ProjectUsageDay[], now: number, timezone: string): ProjectUsageView {
  const today = usageDay(now, timezone), from = minusDays(today, range === 'today' ? 0 : range === '7d' ? 6 : 29);
  const totals = emptyUsage(), groups = { byThread: new Map(), byModel: new Map(), byAccount: new Map(), byKind: new Map() } as Record<'byThread' | 'byModel' | 'byAccount' | 'byKind', Map<string, ProjectUsageView['byThread'][number]>>;
  for (const day of days.filter(day => day.projectId === projectId && day.day >= from && day.day <= today)) for (const row of day.rows) {
    add(totals, row);
    const entries: Array<['byThread' | 'byModel' | 'byAccount' | 'byKind', string, string]> = [
      ['byModel', `${row.runtime}:${row.modelLabel}`, row.modelLabel], ['byAccount', `${row.runtime}:${row.accountLabel}`, row.accountLabel], ['byKind', row.kind, row.kind],
      ...(row.kind === 'thread' ? [['byThread', row.ownerId, row.title] as ['byThread', string, string]] : [])];
    for (const [kind, id, label] of entries) {
      const group = groups[kind].get(id) ?? { ...emptyUsage(), id, label, models: [] };
      add(group, row); if (!group.models.includes(row.modelLabel)) group.models.push(row.modelLabel); groups[kind].set(id, group);
    }
  }
  const view = ProjectUsageViewSchema.parse({ schema: 'project-usage-view-v1', projectId, range, totals,
    ...Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, [...value.values()].sort((a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens || a.label.localeCompare(b.label))])) });
  return { ...view, presentation: usagePresentation(view) };
}
/** Display choices accompany the existing projection; old raw counters retain their meanings. */
function usagePresentation(view: ProjectUsageView) {
  const kindLabels: Record<string, string> = { coordinator: 'Coordinator', thread: 'Threads', verification: 'Verification', review: 'Review', memory: 'Memory' };
  const tables = [['byThread', 'By thread', 'Thread'], ['byModel', 'By model', 'Model'], ['byAccount', 'By account', 'Account'], ['byKind', 'By kind', 'Kind']] as const;
  const totals = [['inputTokens', 'Tokens in'], ['outputTokens', 'Tokens out'], ['cacheReadTokens', 'Cache read'], ['cacheWriteTokens', 'Cache written'], ['costUsd', 'Cost']] as const;
  return ProjectUsagePresentationSchema.parse({ schema: 'project-usage-presentation-v1', defaultRange: DEFAULT_PROJECT_USAGE_RANGE, refreshMs: PROJECT_USAGE_REFRESH_MS,
    ranges: [{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }],
    empty: view.totals.turns === 0, emptyMessage: 'No usage in this range.', unknownCostNotice: view.totals.costUnknownTurns > 0 ? `${view.totals.costUnknownTurns} turns without a reported cost` : null,
    totals: totals.map(([key, label]) => ({ key, label, value: view.totals[key], format: key === 'costUsd' ? 'usd' : 'count' })),
    tables: tables.map(([key, label, first]) => ({ key, label, columns: [{ key: 'label', label: first, format: 'text' }, ...(key === 'byThread' ? [{ key: 'models', label: 'Models', format: 'text' }] : []), { key: 'turns', label: 'Turns', format: 'plain' }, { key: 'tokens', label: 'Tokens', format: 'count' }, { key: 'costUsd', label: 'Cost', format: 'usd' }],
      rows: view[key].map(row => ({ id: row.id, label: key === 'byKind' ? kindLabels[row.id] ?? row.label : row.label, models: row.models.join(', '), turns: row.turns, tokens: row.inputTokens + row.outputTokens, costUsd: row.costUsd })) })),
  });
}
type Identity = Pick<ProjectUsageRow, 'kind' | 'ownerId' | 'title' | 'runtime' | 'modelLabel' | 'accountLabel'>;
type Projection = { loaded: boolean; existingChecked: boolean; timezone: string; dirtyDays: Set<string>; dirtyThreads: Set<string>; seen: Map<string, number>; starts: Map<string, Identity>; days: Map<string, Map<string, ProjectUsageRow>>; threads: Map<string, ThreadUsageTotal>; updatedAt: string };
/** A replayable projection of canonical ledgers; live ends publish only this device's days. */
export class ProjectUsage {
  readonly #projects = new Map<string, Projection>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #dirty = new Set<string>();
  readonly #events = new Map<string, Array<{ ledger: ProjectLedger; event: ProjectLedgerEvent }>>();
  readonly #unsubscribe: () => void;
  constructor(readonly o: { deviceId: string; hub: ProjectHub; ledgers: ProjectLedgers; store: ThreadStore; timezone(projectId: string): Promise<string>; now(): number }) {
    this.#unsubscribe = o.ledgers.subscribe((ledger, event) => {
      if (!['thread-turn-start', 'coordinator-turn-start', 'thread-turn-end', 'coordinator-turn-end', 'project-session-end'].includes(event.type)) return;
      const events = this.#events.get(ledger.projectId) ?? []; events.push({ ledger, event }); this.#events.set(ledger.projectId, events);
      if (event.type.endsWith('-start')) return;
      this.#dirty.add(ledger.projectId); void this.refresh(ledger.projectId).catch(() => undefined);
    });
  }
  busy(): boolean { return this.#pending.size > 0; }
  async rebuild(): Promise<void> {
    for (const id of this.o.ledgers.paths.projectIds()) try { await this.refresh(id); }
    catch (error) { if (!(error instanceof HubUnavailable)) throw error; this.#dirty.add(id); }
  }
  refresh(projectId: string): Promise<void> {
    this.#dirty.add(projectId); const pending = this.#pending.get(projectId); if (pending) return pending;
    const task = (async () => { while (this.#dirty.delete(projectId)) await this.#refresh(projectId); })();
    this.#pending.set(projectId, task);
    void task.finally(() => { if (this.#pending.get(projectId) === task) this.#pending.delete(projectId); }).catch(() => undefined); return task;
  }
  async #refresh(projectId: string): Promise<void> {
    const timezone = await this.o.timezone(projectId), previous = this.#projects.get(projectId);
    const state: Projection = previous?.timezone === timezone ? previous : { loaded: false, existingChecked: false, timezone,
      dirtyDays: new Set(previous?.days.keys()), dirtyThreads: new Set(), seen: new Map(), starts: new Map(),
      days: new Map([...(previous?.days.keys() ?? [])].map(day => [day, new Map<string, ProjectUsageRow>()])), threads: new Map(), updatedAt: new Date(0).toISOString() };
    this.#projects.set(projectId, state);
    if (!state.loaded) {
      const ledgers = [this.o.ledgers.coordinator(projectId), ...this.o.ledgers.paths.threadIds(projectId).map(id => this.o.ledgers.thread(projectId, id))];
      for (const ledger of ledgers) {
        const key = ledger.threadId ?? 'coordinator';
        for (const event of ledger.events(state.seen.get(key) ?? 0)) { this.#consume(state, ledger, event, timezone); state.seen.set(key, event.id); }
      }
      state.loaded = true;
    }
    const pending = this.#events.get(projectId) ?? [];
    while (pending.length) {
      const { ledger, event } = pending[0]!, key = ledger.threadId ?? 'coordinator';
      if (event.id > (state.seen.get(key) ?? 0)) { this.#consume(state, ledger, event, timezone); state.seen.set(key, event.id); }
      pending.shift();
    }
    for (const id of state.dirtyThreads) {
      if (this.o.store.get(id)) this.o.store.setIndexFields(id, { usage: state.threads.get(id)! });
      state.dirtyThreads.delete(id);
    }
    if (!state.existingChecked) {
      for (const day of await this.o.hub.usageDays?.(projectId) ?? []) if (day.deviceId === this.o.deviceId && !state.days.has(day.day)) {
        state.days.set(day.day, new Map()); state.dirtyDays.add(day.day);
      }
      state.existingChecked = true;
    }
    const cutoff = minusDays(usageDay(this.o.now(), timezone), 29);
    for (const day of state.dirtyDays) {
      if (day >= cutoff) await this.o.hub.putUsageDay?.(ProjectUsageDaySchema.parse({ schema: 'project-usage-day-v1', revision: 0,
        id: `${projectId}:${this.o.deviceId}:${day}`, projectId, deviceId: this.o.deviceId, day, lastEventId: [...state.seen.values()].reduce((sum, value) => sum + value, 0), rows: [...state.days.get(day)!.values()], updatedAt: state.updatedAt }));
      state.dirtyDays.delete(day);
    }
  }
  #consume(state: Projection, ledger: ProjectLedger, event: ProjectLedgerEvent, timezone: string): void {
    const key = `${ledger.threadId ?? 'coordinator'}:${event.turn ?? 0}`;
    if (event.type === 'thread-turn-start') {
      const start = ledger.payload(event as ProjectLedgerEvent & { type: 'thread-turn-start' }), thread = ledger.threadId && this.o.store.get(ledger.threadId), labels = thread ? this.o.store.labels(thread.id) : undefined;
      state.starts.set(key, { kind: 'thread', ownerId: ledger.threadId!, title: thread ? thread.title : ledger.threadId!, runtime: start.runtime, modelLabel: start.modelLabel ?? labels?.modelLabel ?? start.model, accountLabel: start.accountLabel ?? start.accountId }); return;
    }
    if (event.type === 'coordinator-turn-start') {
      const start = ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-turn-start' });
      state.starts.set(key, { kind: 'coordinator', ownerId: ledger.projectId, title: 'Coordinator', runtime: start.runtime, modelLabel: start.modelLabel, accountLabel: start.accountLabel }); return;
    }
    let identity: Identity | undefined, usage: z.infer<typeof UsageSchema> | undefined;
    if (event.type === 'thread-turn-end' || event.type === 'coordinator-turn-end') {
      const end = ledger.payload(event as ProjectLedgerEvent & { type: 'thread-turn-end' }); identity = state.starts.get(key); usage = end.usage;
    } else if (event.type === 'project-session-end') {
      const end = ledger.payload(event as ProjectLedgerEvent & { type: 'project-session-end' }); usage = end.usage;
      identity = { kind: end.owner.kind, ownerId: end.owner.id, title: end.owner.kind, runtime: end.runtime, modelLabel: end.modelLabel ?? end.model, accountLabel: end.accountLabel ?? end.accountId ?? 'Unknown account' };
    } else return;
    if (!identity) return;
    const total: ThreadUsageTotal = { turns: 1, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0, costUsd: usage?.costUsd ?? 0, costUnknownTurns: !usage || usage.costSource === 'unknown' ? 1 : 0 };
    const day = usageDay(Date.parse(event.t), timezone), rows = state.days.get(day) ?? new Map<string, ProjectUsageRow>();
    const rowKey = JSON.stringify([identity.kind, identity.ownerId, identity.modelLabel, identity.accountLabel]), row = rows.get(rowKey) ?? { ...identity, ...emptyUsage() };
    add(row, total); rows.set(rowKey, row); state.days.set(day, rows); state.dirtyDays.add(day); if (event.t > state.updatedAt) state.updatedAt = event.t;
    if (identity.kind === 'thread') { const thread = state.threads.get(identity.ownerId) ?? emptyUsage(); add(thread, total); state.threads.set(identity.ownerId, thread); state.dirtyThreads.add(identity.ownerId); }
  }
  async view(projectId: string, rawRange?: unknown) {
    const range = ProjectUsageRequestRangeSchema.parse(rawRange); await this.refresh(projectId);
    return projectUsageView(projectId, range, await this.o.hub.usageDays?.(projectId) ?? [], this.o.now(), this.#projects.get(projectId)!.timezone);
  }
  async close(): Promise<void> { this.#unsubscribe(); await Promise.allSettled(this.#pending.values()); }
}
