import { BridgeToolNameSchema, ProjectLedgerEventSchema, parseProjectLedgerData, type ProjectLedgerData, type ProjectLedgerEvent, type ProjectLedgerEventType } from '@jevellan/core';
import { JsonlLedger, type LedgerAppend, type LedgerOptions, type LedgerSpec } from '@jevellan/conversations';
import type { ProjectPaths } from './paths.js';

const projectLedger: LedgerSpec<ProjectLedgerEvent> = { schema: ProjectLedgerEventSchema, literal: 'project-ledger-event-v1', label: 'Project', folders: ['', 'ledger', 'blobs'] };

/** Validates a payload for its event type; coordinator tool lines must name a bridge tool (D99, D100). */
export function projectLedgerData<T extends ProjectLedgerEventType>(type: T, raw: unknown): ProjectLedgerData<T> {
  const data = parseProjectLedgerData(type, raw);
  if (type === 'coordinator-tool') BridgeToolNameSchema.parse((data as ProjectLedgerData<'coordinator-tool'>).tool);
  return data;
}
/** Browser and agent views of ledger data. Native session identities stay in the owner-local files (brief 5.3, 5.5). */
export function publicProjectData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicProjectData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'nativeSessionId').map(([key, child]) => [key, publicProjectData(child)]));
}

/**
 * The coordinator chat (`projects/<pid>`) or one thread's lifecycle (`projects/<pid>/threads/<tid>`), each with
 * `ledger/` and `blobs/` (brief 5.13, D2). Payloads are validated before they are written.
 */
export class ProjectLedger extends JsonlLedger<ProjectLedgerEvent> {
  constructor(paths: ProjectPaths, readonly projectId: string, readonly threadId?: string, options: LedgerOptions = {}) {
    super(threadId === undefined ? paths.project(projectId) : paths.thread(projectId, threadId), projectLedger, options);
  }
  override append(input: LedgerAppend<ProjectLedgerEvent>): ProjectLedgerEvent {
    return super.append({ ...input, data: projectLedgerData(input.type, input.data) });
  }
  /** A resolved, validated payload (blob pointers read). */
  payload<T extends ProjectLedgerEventType>(event: ProjectLedgerEvent & { type: T }): ProjectLedgerData<T> {
    return parseProjectLedgerData(event.type, this.data(event));
  }
}

/** One ledger object per directory: subscribers live on the instance, so the SSE stream and every writer must share it. */
export class ProjectLedgers {
  readonly #ledgers = new Map<string, ProjectLedger>();
  constructor(readonly paths: ProjectPaths, private readonly options: LedgerOptions = {}) {}
  coordinator(projectId: string): ProjectLedger { return this.#get(projectId); }
  thread(projectId: string, threadId: string): ProjectLedger { return this.#get(projectId, threadId); }
  #get(projectId: string, threadId?: string): ProjectLedger {
    const key = threadId === undefined ? projectId : `${projectId}/${threadId}`;
    let ledger = this.#ledgers.get(key);
    if (!ledger) { ledger = new ProjectLedger(this.paths, projectId, threadId, this.options); this.#ledgers.set(key, ledger); }
    return ledger;
  }
  /** Startup only (brief 8.6): clears locks of a crashed writer on every coordinator and thread ledger. */
  recoverAll(): void {
    for (const projectId of this.paths.projectIds()) {
      this.coordinator(projectId).recoverAbandonedWrite();
      for (const threadId of this.paths.threadIds(projectId)) this.thread(projectId, threadId).recoverAbandonedWrite();
    }
  }
}
