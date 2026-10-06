import { ZodError } from 'zod';
import {
  BridgeToolNameSchema, ProjectLedgerEventSchema, SecretRedactor, boundedRedaction, clipRedacted, parseProjectLedgerData, type ProjectLedgerData, type ProjectLedgerEvent,
  type ProjectLedgerEventType,
} from '@jevellan/core';
import { JsonlLedger, type LedgerAppend, type LedgerOptions, type LedgerSpec } from '@jevellan/conversations';
import type { ProjectPaths } from './paths.js';

const projectLedger: LedgerSpec<ProjectLedgerEvent> = { schema: ProjectLedgerEventSchema, literal: 'project-ledger-event-v1', label: 'Project', folders: ['', 'ledger', 'blobs'] };

/** Validates a payload for its event type; coordinator tool lines must name a bridge tool (D99, D100). */
export function projectLedgerData<T extends ProjectLedgerEventType>(type: T, raw: unknown): ProjectLedgerData<T> {
  const data = parseProjectLedgerData(type, raw);
  if (type === 'coordinator-tool') BridgeToolNameSchema.parse((data as ProjectLedgerData<'coordinator-tool'>).tool);
  return data;
}
/**
 * `parse(value)`, and for a value whose only problems are texts longer than their maximum (a record an earlier version stored after its
 * check, when redaction lengthened it, P8 review S-1) the value with those texts cut to their maximum. Anything else fails as before.
 */
export function parseWithin<T>(parse: (value: unknown) => T, value: unknown): T {
  try { return parse(value); }
  catch (error) {
    if (!(error instanceof ZodError) || !error.issues.length || !error.issues.every((issue) => issue.code === 'too_big' && issue.origin === 'string' && issue.path.length)) throw error;
    const copy = structuredClone(value) as unknown;
    for (const issue of error.issues) {
      const path = issue.path; let parent: unknown = copy;
      for (const key of path.slice(0, -1)) parent = parent && typeof parent === 'object' ? (parent as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined;
      const leaf = path.at(-1) as PropertyKey; const holder = parent as Record<PropertyKey, unknown> | undefined;
      const text = holder?.[leaf]; const maximum = Number((issue as { maximum?: number | bigint }).maximum);
      if (typeof text !== 'string' || !Number.isFinite(maximum)) throw error;
      holder![leaf] = clipRedacted(text, maximum);
    }
    return parse(copy);
  }
}
const PRIVATE_KEYS = new Set(['nativeSessionId', 'cwd', 'sessionId']);
/**
 * Browser and agent views of ledger data. Native session identities and working directories stay in the owner-local files
 * (brief 5.3, 5.5); no ledger payload carries them, so this is defense for every frame, view and read (design 2.1.3).
 */
export function publicProjectData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicProjectData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key)).map(([key, child]) => [key, publicProjectData(child)]));
}

/**
 * The coordinator chat (`projects/<pid>`) or one thread's lifecycle (`projects/<pid>/threads/<tid>`), each with
 * `ledger/` and `blobs/` (brief 5.13, D2). Payloads are redacted, then validated, before they are written, so what was checked is what
 * is stored (P8 review S-1): redaction never lengthens a text past its maximum, and the stored texts are left as they are by any later pass.
 */
export class ProjectLedger extends JsonlLedger<ProjectLedgerEvent> {
  readonly #redactor: SecretRedactor;
  constructor(paths: ProjectPaths, readonly projectId: string, readonly threadId?: string, options: LedgerOptions = {}) {
    super(threadId === undefined ? paths.project(projectId) : paths.thread(projectId, threadId), projectLedger, options);
    this.#redactor = options.redactor ?? new SecretRedactor();
  }
  override append(input: LedgerAppend<ProjectLedgerEvent>): ProjectLedgerEvent {
    return super.append({ ...input, data: projectLedgerData(input.type, boundedRedaction(this.#redactor, input.data)) });
  }
  /**
   * A resolved, validated payload (blob pointers read). A text an earlier version stored past its maximum reads cut to it, so one such
   * record never fails a page, a chat history or a coordinator turn (P8 review S-1).
   */
  payload<T extends ProjectLedgerEventType>(event: ProjectLedgerEvent & { type: T }): ProjectLedgerData<T> {
    return parseWithin((value) => parseProjectLedgerData(event.type, value), this.data(event));
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
