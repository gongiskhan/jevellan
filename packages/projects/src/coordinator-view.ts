import { ProjectCoordinatorActivitySchema, ProjectHeaderSchema, ProjectLedgerDataSchemas,
  type CoordinatorView, type ProjectCoordinatorActivity, type ProjectHeader, type ProjectLedgerEvent, type ProjectWorkView } from '@jevellan/core';
import { coordinatorOfflineNotice, coordinatorUnavailableNotice } from './copy.js';

export function coordinatorLabel(state: CoordinatorView['state']): string {
  return state === 'running' ? 'Working…' : state === 'unavailable' ? 'Unavailable' : state === 'offline' ? 'Offline' : 'Idle';
}

/** A replayed event never overrides the view's newer durable head, or an unavailable/offline state. */
export function working(events: readonly ProjectLedgerEvent[], view: Pick<ProjectWorkView, 'coordinator'> & Partial<Pick<ProjectWorkView, 'lastEventId'>>): boolean {
  if (view.coordinator.state === 'running') return true;
  if (view.coordinator.state === 'unavailable' || view.coordinator.state === 'offline') return false;
  let open: number | undefined;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (event.id <= (view.lastEventId ?? 0)) continue;
    if (event.type === 'coordinator-turn-start') { const value = ProjectLedgerDataSchemas['coordinator-turn-start'].safeParse(event.data); if (value.success) open = value.data.turn; }
    if (event.type === 'coordinator-turn-end') { const value = ProjectLedgerDataSchemas['coordinator-turn-end'].safeParse(event.data); if (value.success && value.data.turn === open) open = undefined; }
  }
  return open !== undefined;
}

function chip(coordinator: CoordinatorView, busy: boolean, runtime: (id: string) => string): ProjectHeader['current']['chip'] {
  const shown = coordinator.session ?? coordinator.planned;
  return { label: busy ? 'Working…' : coordinatorLabel(coordinator.state),
    tone: busy ? 'running' : coordinator.state === 'unavailable' || coordinator.state === 'offline' ? coordinator.state : 'idle',
    session: shown ? `${runtime(shown.runtime)} ${shown.modelLabel} · ${shown.effort}` : null };
}
export function coordinatorChip(view: Pick<ProjectWorkView, 'coordinator'> & Partial<Pick<ProjectWorkView, 'lastEventId'>>, events: readonly ProjectLedgerEvent[], runtime: (id: string) => string) {
  return chip(view.coordinator, working(events, view), runtime);
}

export type CoordinatorPresentationOptions = { now?: number; timeZone?: string | undefined; locale?: string | undefined; runtimeName?(id: string): string };
export function coordinatorPresentation(view: ProjectWorkView, options: CoordinatorPresentationOptions = {}): ProjectHeader {
  const coordinator = view.coordinator, offline = coordinator.state === 'offline', context = coordinator.session?.context;
  const timeZone = options.timeZone ?? view.settings.nightlyWindow.timezone, now = new Date(options.now ?? Date.now());
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = new Intl.DateTimeFormat(options.locale, { timeZone, hour: '2-digit', minute: '2-digit' });
  const contextLine = context ? `${context.tokens !== null && context.contextWindow ? `Context ${Math.round(context.tokens / context.contextWindow * 100)}%` : 'Context unavailable'} · Compacted ${context.compactions.filter(at => day.format(new Date(at)) === day.format(now)).length} times today${context.lastCompactionAt ? ` · Last compaction ${time.format(new Date(context.lastCompactionAt))}` : ''}` : null;
  const make = (busy: boolean): ProjectHeader['current'] => ({ working: busy, offline, chip: chip(coordinator, busy, options.runtimeName ?? (id => id)),
    contextLine, contextNotice: context?.notice ?? null,
    unavailableNotice: coordinator.state === 'unavailable' && coordinator.unavailableReason ? coordinatorUnavailableNotice(coordinator.unavailableReason) : null,
    offlineNotice: offline ? coordinatorOfflineNotice(coordinator.deviceName ?? coordinator.deviceId ?? '') : null,
    controls: { canFresh: !offline, canSuggestSetup: !busy && !offline, canMove: coordinator.canMoveHere,
      moveEnabled: coordinator.canMoveHere && !coordinator.moveRefusal, moveRefusal: coordinator.moveRefusal ?? null } });
  const { schema: _schema, projectId: _projectId, revision, ...settings } = view.settings; void _schema; void _projectId;
  const archived = settings.status === 'archived';
  return ProjectHeaderSchema.parse({ atEventId: view.lastEventId, current: make(coordinator.state === 'running'),
    live: coordinator.state === 'idle' || coordinator.state === 'none' ? { working: make(true), idle: make(false) } : null,
    banner: settings.status === 'active' ? null : { text: archived ? 'This project is archived. Nothing runs and it is hidden from the sidebar.' : 'This project is paused. Nothing new starts until you resume it.',
      actionLabel: archived ? 'Unarchive' : 'Resume', request: { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, status: archived ? 'paused' : 'active' } } } });
}

/** One linear replay on connection; frames use indexed state changes without rescanning history. */
export class CoordinatorActivityProjector {
  #seq = 0;
  #turn: number | undefined;
  readonly #changes: Array<{ seq: number; state: ProjectCoordinatorActivity['state'] }> = [{ seq: 0, state: 'idle' }];
  constructor(events: readonly ProjectLedgerEvent[] = [], private readonly resolve: (event: ProjectLedgerEvent) => unknown = event => event.data) {
    for (const event of events) this.observe(event);
  }
  observe(event: ProjectLedgerEvent): ProjectCoordinatorActivity {
    if (event.id > this.#seq) {
      this.#seq = event.id;
      if (event.type === 'coordinator-turn-start') { const value = ProjectLedgerDataSchemas['coordinator-turn-start'].safeParse(this.resolve(event)); if (value.success) this.#turn = value.data.turn; }
      if (event.type === 'coordinator-turn-end') { const value = ProjectLedgerDataSchemas['coordinator-turn-end'].safeParse(this.resolve(event)); if (value.success && value.data.turn === this.#turn) this.#turn = undefined; }
      const state = this.#turn === undefined ? 'idle' : 'working';
      if (this.#changes.at(-1)!.state !== state) this.#changes.push({ seq: event.id, state });
    }
    // A replayed frame must match the original live frame, including its activity projection.
    let low = 0, high = this.#changes.length;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (this.#changes[middle]!.seq <= event.id) low = middle; else high = middle; }
    return ProjectCoordinatorActivitySchema.parse({ schema: 'project-coordinator-activity-v1', seq: event.id, state: this.#changes[low]!.state });
  }
}
