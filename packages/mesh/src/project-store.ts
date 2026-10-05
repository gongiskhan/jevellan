import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DecisionAnswerSchema, ENVELOPE_PAGE_BYTES, IdSchema, PROJECT_HUB_PAGE, PlacementOverrideSchema, ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema, ProjectDecisionSchema, ProjectEnvelopeSchema,
  ProjectHubRequestSchema, ProjectHubResultSchema, ProjectNotebookSchema, ProjectSchema, ProjectWorkSettingsSchema, ProjectWorkSummarySchema, ThreadIndexCursorSchema, ThreadIndexSchema,
  TimestampSchema, checkHubRevision, collectionOf, compareEnvelopes, coordinatorMovable, coordinatorWorking, stableJson, withHubRevision, workCounts,
  type DecisionAnswer, type DeviceView, type DocumentSchema, type PlacementOverride, type ProjectCoordinator, type ProjectCoordinatorStatus, type ProjectDecision, type ProjectEnvelope,
  type ProjectHub, type ProjectHubOperation, type ProjectHubResult, type ProjectHubResultOf, type ProjectNotebook, type ProjectWorkSettings, type ProjectWorkSummary, type Stored,
  type ThreadIndex,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';
import { settingsMutation } from './settings-mutation.js';

const SETTINGS = 'project-work-settings'; const COORDINATORS = 'project-coordinators'; const STATUS = 'project-coordinator-status';
const THREADS = 'project-threads'; const CURSORS = 'project-thread-cursors'; const DECISIONS = 'project-decisions'; const NOTEBOOKS = 'project-notebooks';
const OVERRIDES = 'project-placement-overrides'; const ENVELOPES = 'project-envelopes';
/** Answered questions stay in the list for 14 days (D52). */
export const DECISION_LIST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
/** The hub sets the revision (D3), so an index's identity for retries is its content without it. */
const indexDigest = (index: ThreadIndex) => createHash('sha256').update(stableJson({ ...index, revision: 0 })).digest('hex');
const StoredSettingsSchema = z.strictObject({ revision: z.number().int().positive(), document: ProjectWorkSettingsSchema });
const AnswerReceiptSchema = z.strictObject({ decision: z.strictObject({ revision: z.number().int().positive(), document: ProjectDecisionSchema }), repeated: z.boolean() });
type Page<T> = { records: T[]; next: string | null };

/**
 * Project hub state over the hub database, bound to the authenticated device (design 2.1.5). Stateless and synchronous:
 * build one per request. Reads assert the D3 revision rule; read-then-write operations run in one hub transaction.
 */
export class HubProjectStore {
  /** `devices`: the roster's device views, for the presence in work summaries (without it every coordinator device reads as unknown). */
  constructor(readonly hub: HubDatabase, readonly deviceId: string, readonly now: () => number = Date.now, readonly devices?: () => readonly DeviceView[]) { IdSchema.parse(deviceId); }
  #get<T extends { revision: number }>(namespace: string, id: string, schema: DocumentSchema<T>): Stored<T> | null {
    const row = this.hub.get(namespace, IdSchema.parse(id), schema); return row ? checkHubRevision(row) : null;
  }
  #put<T extends { revision: number }>(namespace: string, id: string, schema: DocumentSchema<T>, document: T, expectedRevision: number): Stored<T> {
    return checkHubRevision(this.hub.put(namespace, id, schema, withHubRevision(document, expectedRevision), expectedRevision));
  }
  #project(projectId: string): void { if (!this.hub.get('projects', projectId, ProjectSchema)) refuse('Project not found.', 404); }
  /** Per-project pages of 100 in id order, filtered in SQL by project (D89); `next` is the last returned id. */
  #page<T extends { id: string; revision: number }>(namespace: string, schema: DocumentSchema<T>, projectId: string, after: string | undefined, keep: (document: T) => boolean): Page<T> {
    const records: T[] = []; let cursor = after;
    for (;;) {
      const rows = this.hub.listByField(namespace, 'projectId', IdSchema.parse(projectId), schema, { limit: PROJECT_HUB_PAGE + 1, ...(cursor === undefined ? {} : { after: cursor }) });
      for (const row of rows) { const document = checkHubRevision(row).document; if (keep(document)) records.push(document); if (records.length > PROJECT_HUB_PAGE) break; }
      if (records.length > PROJECT_HUB_PAGE || rows.length <= PROJECT_HUB_PAGE) break;
      cursor = rows.at(-1)!.document.id;
    }
    return { records: records.slice(0, PROJECT_HUB_PAGE), next: records.length > PROJECT_HUB_PAGE ? records[PROJECT_HUB_PAGE - 1]!.id : null };
  }

  settings(projectId: string): Stored<ProjectWorkSettings> | null { return this.#get(SETTINGS, projectId, ProjectWorkSettingsSchema); }
  /** Compare-and-swap on the row revision; a repeated clientRequestId returns the first result. */
  putSettings(raw: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string): Stored<ProjectWorkSettings> {
    const settings = ProjectWorkSettingsSchema.parse(raw);
    return settingsMutation(this.hub, this.deviceId, 'project-work-settings-put', { settings, expectedRevision }, clientRequestId, StoredSettingsSchema, () => {
      this.#project(settings.projectId); return this.#put(SETTINGS, settings.projectId, ProjectWorkSettingsSchema, settings, expectedRevision);
    });
  }

  coordinator(projectId: string): Stored<ProjectCoordinator> | null { return this.#get(COORDINATORS, projectId, ProjectCoordinatorSchema); }
  /**
   * A device assigns the coordinator only to itself (first message, first thread, Move here); revision 0 creates. A move is refused
   * while the move rule says the former device works (D269): checked here, in the transaction that records the move, because the
   * former device announces each turn on this hub before it launches it (D283), so a move and a turn start are ordered here and the
   * former device never starts a turn after a move. A move retargets the project's coordinator events still waiting for the former
   * device to the new one in the same transaction (D270), so events relayed to a device that is gone are not stranded; the former
   * device forwards whatever it already took (3.5.4).
   */
  assignCoordinator(projectId: string, deviceId: string, expectedRevision: number): Stored<ProjectCoordinator> {
    IdSchema.parse(projectId); if (IdSchema.parse(deviceId) !== this.deviceId) refuse('A device can only make itself the coordinator.', 403);
    return this.hub.transaction(() => {
      this.#project(projectId);
      const former = this.coordinator(projectId)?.document.deviceId;
      if (former !== undefined && former !== deviceId) {
        const row = this.devices?.().find((view) => view.device.id === former);
        if (!coordinatorMovable(former, row, this.coordinatorStatus(projectId)?.document)) refuse(coordinatorWorking(row?.device.name ?? former), 409);
      }
      const stored = this.#put<ProjectCoordinator>(COORDINATORS, projectId, ProjectCoordinatorSchema, { schema: 'project-coordinator-v1', projectId, revision: 0, deviceId,
        assignedAt: new Date(this.now()).toISOString() }, expectedRevision);
      if (former !== undefined && former !== deviceId) {
        for (const row of this.hub.listByField(ENVELOPES, 'targetDeviceId', former, ProjectEnvelopeSchema)) {
          const { document, revision } = checkHubRevision(row);
          if (document.projectId === projectId && document.body.kind === 'coordinator-event') this.#put(ENVELOPES, document.id, ProjectEnvelopeSchema, { ...document, targetDeviceId: deviceId }, revision);
        }
      }
      return stored;
    });
  }
  coordinatorStatus(projectId: string): Stored<ProjectCoordinatorStatus> | null { return this.#get(STATUS, projectId, ProjectCoordinatorStatusSchema); }
  /** Only the assigned coordinator device publishes its status; it is the single writer, so the write uses the current revision. */
  putCoordinatorStatus(raw: ProjectCoordinatorStatus): Stored<ProjectCoordinatorStatus> {
    const status = ProjectCoordinatorStatusSchema.parse(raw);
    return this.hub.transaction(() => {
      if (status.deviceId !== this.deviceId || this.coordinator(status.projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can publish its status.', 403);
      return this.#put(STATUS, status.projectId, ProjectCoordinatorStatusSchema, status, this.hub.get(STATUS, status.projectId, ProjectCoordinatorStatusSchema)?.revision ?? 0);
    });
  }

  threads(projectId: string, after?: string): Page<ThreadIndex> { return this.#page(THREADS, ThreadIndexSchema, projectId, after, () => true); }
  thread(threadId: string): Stored<ThreadIndex> | null { return this.#get(THREADS, threadId, ThreadIndexSchema); }
  /** Owner-bound and ordered by the thread's ledger event id: older events are ignored, a replayed event must carry the same index. */
  publishThread(raw: ThreadIndex, rawEventId: number): { eventId: number } {
    const index = ThreadIndexSchema.parse(raw); const eventId = z.number().int().positive().parse(rawEventId); const digest = indexDigest(index);
    if (index.ownerDeviceId !== this.deviceId) refuse('Only the thread owner can publish its index.', 403);
    return this.hub.transaction(() => {
      const previous = this.thread(index.id);
      if (previous && (previous.document.ownerDeviceId !== this.deviceId || previous.document.projectId !== index.projectId)) refuse('This thread belongs to another owner or project.', 403);
      const cursor = this.hub.get(CURSORS, index.id, ThreadIndexCursorSchema);
      if (cursor && cursor.document.deviceId !== this.deviceId) refuse('This thread index belongs to another owner.', 403);
      if (cursor && eventId <= cursor.document.eventId) {
        if (eventId === cursor.document.eventId && digest !== cursor.document.digest) refuse('This thread event already published a different index.');
        return { eventId: cursor.document.eventId };
      }
      if (!previous || indexDigest(previous.document) !== digest) this.#put(THREADS, index.id, ThreadIndexSchema, index, previous?.revision ?? 0);
      this.hub.put(CURSORS, index.id, ThreadIndexCursorSchema, { schema: 'project-thread-cursor-v1', threadId: index.id, deviceId: this.deviceId, eventId, digest }, cursor?.revision ?? 0);
      return { eventId };
    });
  }

  /** Open questions plus those answered in the last 14 days by the hub clock; withdrawn ones leave the list. */
  decisions(projectId: string, after?: string): Page<ProjectDecision> {
    const since = this.now() - DECISION_LIST_WINDOW_MS;
    return this.#page(DECISIONS, ProjectDecisionSchema, projectId, after, (decision) => decision.answeredAt ? Date.parse(decision.answeredAt) >= since : !decision.withdrawnAt);
  }
  decision(id: string): Stored<ProjectDecision> | null { return this.#get(DECISIONS, id, ProjectDecisionSchema); }
  /** Revision 0 creates; an identical retry returns the stored question. Answers and withdrawals have their own operations. */
  createDecision(raw: ProjectDecision): Stored<ProjectDecision> {
    const decision = ProjectDecisionSchema.parse(raw);
    if (decision.answer || decision.answeredAt || decision.withdrawnAt) refuse('A new question cannot already be answered or withdrawn.', 400);
    return this.hub.transaction(() => {
      this.#project(decision.projectId);
      const existing = this.decision(decision.id);
      if (existing && stableJson({ ...existing.document, revision: 0 }) === stableJson({ ...decision, revision: 0 })) return existing;
      return this.#put(DECISIONS, decision.id, ProjectDecisionSchema, decision, 0);
    });
  }
  /** No change once the question is answered or already withdrawn. */
  withdrawDecision(id: string, at: string): Stored<ProjectDecision> {
    TimestampSchema.parse(at);
    return this.hub.transaction(() => {
      const current = this.decision(id) ?? refuse('This question was not found.', 404);
      if (current.document.answeredAt || current.document.withdrawnAt) return current;
      return this.#put(DECISIONS, id, ProjectDecisionSchema, { ...current.document, withdrawnAt: at }, current.revision);
    });
  }
  /** The first answer wins. The same answer again, or a repeated clientRequestId, reports `repeated`; another answer is refused. */
  answerDecision(id: string, raw: DecisionAnswer, at: string, clientRequestId: string): { decision: Stored<ProjectDecision>; repeated: boolean } {
    const answer = DecisionAnswerSchema.parse(raw); IdSchema.parse(id); TimestampSchema.parse(at); let applied = false;
    const result = settingsMutation(this.hub, this.deviceId, 'decision-answer', { id, answer }, IdSchema.parse(clientRequestId), AnswerReceiptSchema, () => {
      applied = true;
      const current = this.decision(id) ?? refuse('This question was not found.', 404);
      if (current.document.withdrawnAt) refuse('This question was withdrawn.');
      if (current.document.answer) {
        if (stableJson(current.document.answer) !== stableJson(answer)) refuse('This question was already answered.');
        return { decision: current, repeated: true };
      }
      return { decision: this.#put(DECISIONS, id, ProjectDecisionSchema, { ...current.document, answer, answeredAt: at }, current.revision), repeated: false };
    });
    return applied ? result : { decision: this.decision(id) ?? result.decision, repeated: true };
  }

  notebook(projectId: string): Stored<ProjectNotebook> | null { return this.#get(NOTEBOOKS, projectId, ProjectNotebookSchema); }
  putNotebook(raw: ProjectNotebook, expectedRevision: number): Stored<ProjectNotebook> {
    const notebook = ProjectNotebookSchema.parse(raw);
    return this.hub.transaction(() => { this.#project(notebook.projectId); return this.#put(NOTEBOOKS, notebook.projectId, ProjectNotebookSchema, notebook, expectedRevision); });
  }

  /**
   * Placement overrides (brief 5.12) are append-only and carry no revision. The thread's owner records them; an id seen before
   * answers with the stored record when it describes the same change (a retry, whatever its time), else 409 (D252).
   */
  addOverride(raw: PlacementOverride): PlacementOverride {
    const override = PlacementOverrideSchema.parse(raw);
    return this.hub.transaction(() => {
      this.#project(override.projectId);
      const index = this.thread(override.threadId)?.document;
      if (index && (index.projectId !== override.projectId || index.ownerDeviceId !== this.deviceId)) refuse('Only the thread owner can record its placement overrides.', 403);
      const existing = this.hub.get(OVERRIDES, override.id, PlacementOverrideSchema)?.document;
      if (existing) {
        if (stableJson({ ...existing, at: '' }) !== stableJson({ ...override, at: '' })) refuse('This override id was already used for a different change.');
        return existing;
      }
      return this.hub.put(OVERRIDES, override.id, PlacementOverrideSchema, override, 0).document;
    });
  }
  /** The project's newest overrides by time, newest first; the collection is small (D90 leaves it unpruned). */
  recentOverrides(projectId: string, limit: number): PlacementOverride[] {
    const count = z.number().int().min(1).max(PROJECT_HUB_PAGE).parse(limit);
    return this.hub.listByField(OVERRIDES, 'projectId', IdSchema.parse(projectId), PlacementOverrideSchema).map((row) => row.document)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id)).slice(0, count);
  }

  /**
   * Relay envelopes (D40). The source device puts each envelope once (revision 0); a retry of the same envelope after a lost
   * reply answers `stored: false`, and the same id with other content is refused, so a sender can never rewrite a message.
   */
  putEnvelope(raw: ProjectEnvelope): { stored: boolean } {
    const envelope = ProjectEnvelopeSchema.parse(raw);
    if (envelope.sourceDeviceId !== this.deviceId) refuse('Only the source device can send its envelopes.', 403);
    if (envelope.deliveredAt) refuse('A new envelope cannot already be delivered.', 400);
    return this.hub.transaction(() => {
      this.#project(envelope.projectId);
      const existing = this.#get(ENVELOPES, envelope.id, ProjectEnvelopeSchema);
      if (existing) {
        if (stableJson({ ...existing.document, revision: 0 }) !== stableJson({ ...envelope, revision: 0 })) refuse('This envelope id was already used for a different message.');
        return { stored: false };
      }
      this.#put(ENVELOPES, envelope.id, ProjectEnvelopeSchema, envelope, 0);
      return { stored: true };
    });
  }
  /**
   * The caller's pending envelopes, filtered in SQL by target (D89) without a limit (acknowledged rows are deleted, D90), sorted
   * by source, project and sequence, then cut at 100 or about 1 MiB (always one), so no page splits a source's order (D260).
   */
  pendingEnvelopes(targetDeviceId: string): { records: ProjectEnvelope[]; more: boolean } {
    if (IdSchema.parse(targetDeviceId) !== this.deviceId) refuse('Only the target device can read its envelopes.', 403);
    const pending = this.hub.listByField(ENVELOPES, 'targetDeviceId', targetDeviceId, ProjectEnvelopeSchema).map((row) => checkHubRevision(row).document).sort(compareEnvelopes);
    const records: ProjectEnvelope[] = []; let bytes = 0;
    for (const envelope of pending) {
      const size = Buffer.byteLength(JSON.stringify(envelope));
      if (records.length === PROJECT_HUB_PAGE || (records.length && bytes + size > ENVELOPE_PAGE_BYTES)) break;
      records.push(envelope); bytes += size;
    }
    return { records, more: records.length < pending.length };
  }
  /** Only the target acknowledges; the delivered envelope is deleted in the same transaction (D90). An unknown id was already acknowledged. */
  ackEnvelope(id: string): { deleted: boolean } {
    IdSchema.parse(id);
    return this.hub.transaction(() => {
      const existing = this.#get(ENVELOPES, id, ProjectEnvelopeSchema); if (!existing) return { deleted: false };
      if (existing.document.targetDeviceId !== this.deviceId) refuse('Only the target device can acknowledge an envelope.', 403);
      return { deleted: this.hub.delete(ENVELOPES, id) };
    });
  }

  /**
   * The Projects list in one request (D267): per project, in id order after `after`, the sidebar counts over every thread index
   * and open question, and the assigned coordinator with its device's presence and the state it published (a status published by
   * a former coordinator device is not shown).
   */
  workSummaries(after?: string): Page<ProjectWorkSummary> {
    const cursor = after === undefined ? undefined : IdSchema.parse(after);
    const projects = this.hub.list('projects', ProjectSchema).map((row) => row.document).filter((project) => cursor === undefined || project.id > cursor);
    const page = projects.slice(0, PROJECT_HUB_PAGE); const devices = new Map((this.devices?.() ?? []).map((view) => [view.device.id, view]));
    const records = page.map((project): ProjectWorkSummary => {
      const threads = this.hub.listByField(THREADS, 'projectId', project.id, ThreadIndexSchema).map((row) => checkHubRevision(row).document);
      const decisions = this.hub.listByField(DECISIONS, 'projectId', project.id, ProjectDecisionSchema).map((row) => checkHubRevision(row).document);
      const assigned = this.coordinator(project.id)?.document.deviceId; const view = assigned === undefined ? undefined : devices.get(assigned);
      const status = assigned === undefined ? undefined : this.coordinatorStatus(project.id)?.document;
      return ProjectWorkSummarySchema.parse({ schema: 'project-work-summary-v1', projectId: project.id, name: project.name, ...workCounts(threads, decisions),
        coordinator: assigned === undefined ? null : { deviceId: assigned, device: view ? { name: view.device.name, status: view.status, revoked: view.revoked } : null,
          state: status && status.deviceId === assigned ? status.state : null } });
    });
    return { records, next: projects.length > PROJECT_HUB_PAGE ? page.at(-1)!.id : null };
  }

  /** `/hub/mesh/projects/<collection>`: the route has already matched the collection to the operation. */
  request(raw: unknown): ProjectHubResult {
    const request = ProjectHubRequestSchema.parse(raw); const base = { schema: 'project-hub-result-v1', operation: request.operation };
    let result: unknown;
    switch (request.operation) {
      case 'settings-get': result = { ...base, record: this.settings(request.projectId) }; break;
      case 'settings-put': result = { ...base, record: this.putSettings(request.settings, request.expectedRevision, request.clientRequestId) }; break;
      case 'coordinator-get': result = { ...base, record: this.coordinator(request.projectId) }; break;
      case 'coordinator-assign': result = { ...base, record: this.assignCoordinator(request.projectId, request.deviceId, request.expectedRevision) }; break;
      case 'coordinator-status-get': result = { ...base, record: this.coordinatorStatus(request.projectId) }; break;
      case 'coordinator-status-put': result = { ...base, record: this.putCoordinatorStatus(request.status) }; break;
      case 'threads-list': result = { ...base, ...this.threads(request.projectId, request.after) }; break;
      case 'thread-get': result = { ...base, record: this.thread(request.threadId) }; break;
      case 'thread-publish': result = { ...base, threadId: request.index.id, ...this.publishThread(request.index, request.eventId) }; break;
      case 'decisions-list': result = { ...base, ...this.decisions(request.projectId, request.after) }; break;
      case 'decision-get': result = { ...base, record: this.decision(request.id) }; break;
      case 'decision-create': result = { ...base, record: this.createDecision(request.decision) }; break;
      case 'decision-withdraw': result = { ...base, record: this.withdrawDecision(request.id, request.at) }; break;
      case 'decision-answer': { const answered = this.answerDecision(request.id, request.answer, request.at, request.clientRequestId); result = { ...base, record: answered.decision, repeated: answered.repeated }; break; }
      case 'notebook-get': result = { ...base, record: this.notebook(request.projectId) }; break;
      case 'notebook-put': result = { ...base, record: this.putNotebook(request.notebook, request.expectedRevision) }; break;
      case 'override-add': result = { ...base, override: this.addOverride(request.override) }; break;
      case 'overrides-recent': result = { ...base, records: this.recentOverrides(request.projectId, request.limit) }; break;
      case 'envelope-put': result = { ...base, id: request.envelope.id, ...this.putEnvelope(request.envelope) }; break;
      case 'envelopes-pending': result = { ...base, ...this.pendingEnvelopes(request.targetDeviceId) }; break;
      case 'envelope-ack': result = { ...base, id: request.id, ...this.ackEnvelope(request.id) }; break;
      case 'work-summaries': result = { ...base, ...this.workSummaries(request.after) }; break;
    }
    return ProjectHubResultSchema.parse(result);
  }
}

/** The hub's own `ProjectHub`: the same store and authority rules, bound to the hub device. */
export class HubProjectAccess implements ProjectHub {
  readonly #store: HubProjectStore;
  constructor(hub: HubDatabase, deviceId: string, now?: () => number, devices?: () => readonly DeviceView[]) { this.#store = new HubProjectStore(hub, deviceId, now, devices); }
  async settings(projectId: string) { return this.#store.settings(projectId); }
  async putSettings(settings: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string) { return this.#store.putSettings(settings, expectedRevision, clientRequestId); }
  async coordinator(projectId: string) { return this.#store.coordinator(projectId); }
  async assignCoordinator(projectId: string, deviceId: string, expectedRevision: number) { return this.#store.assignCoordinator(projectId, deviceId, expectedRevision); }
  async coordinatorStatus(projectId: string) { return this.#store.coordinatorStatus(projectId); }
  async putCoordinatorStatus(status: ProjectCoordinatorStatus) { this.#store.putCoordinatorStatus(status); }
  async threads(projectId: string, after?: string) { return this.#store.threads(projectId, after); }
  async thread(threadId: string) { return this.#store.thread(threadId); }
  async publishThread(index: ThreadIndex, eventId: number) { return this.#store.publishThread(index, eventId); }
  async decisions(projectId: string) {
    const records: ProjectDecision[] = []; let after: string | undefined;
    for (;;) { const page = this.#store.decisions(projectId, after); records.push(...page.records); if (page.next === null) return records; after = page.next; }
  }
  async decision(id: string) { return this.#store.decision(id); }
  async createDecision(decision: ProjectDecision) { return this.#store.createDecision(decision); }
  async withdrawDecision(id: string, at: string) { return this.#store.withdrawDecision(id, at); }
  async answerDecision(id: string, answer: DecisionAnswer, at: string, clientRequestId: string) { return this.#store.answerDecision(id, answer, at, clientRequestId); }
  async notebook(projectId: string) { return this.#store.notebook(projectId); }
  async putNotebook(notebook: ProjectNotebook, expectedRevision: number) { return this.#store.putNotebook(notebook, expectedRevision); }
  async addOverride(override: PlacementOverride) { this.#store.addOverride(override); }
  async recentOverrides(projectId: string, limit: number) { return this.#store.recentOverrides(projectId, limit); }
  async putEnvelope(envelope: ProjectEnvelope) { return this.#store.putEnvelope(envelope); }
  async pendingEnvelopes(targetDeviceId: string) { return this.#store.pendingEnvelopes(targetDeviceId); }
  async ackEnvelope(id: string) { this.#store.ackEnvelope(id); }
  async workSummaries() {
    const records: ProjectWorkSummary[] = []; let after: string | undefined;
    for (;;) { const page = this.#store.workSummaries(after); records.push(...page.records); if (page.next === null) return records; after = page.next; }
  }
}

/** A member's `ProjectHub` over the device-token HTTP API; every reply must match the requested identity and revision. */
export class MemberProjectStore implements ProjectHub {
  constructor(readonly client: MemberHubClient) {}
  async #call<O extends ProjectHubOperation>(operation: O, fields: object): Promise<ProjectHubResultOf<O>> {
    const result = await this.client.projects(collectionOf(operation), { schema: 'project-hub-request-v1', operation, ...fields });
    if (result.operation !== operation) throw new HubProtocolError();
    return result as ProjectHubResultOf<O>;
  }
  /** Ids ascend past the cursor, every record belongs to the project, and `next` is the last returned id. */
  #page<T extends { id: string; projectId: string }>(page: Page<T>, projectId: string, after: string | undefined): Page<T> {
    let previous = after;
    for (const record of page.records) { if (record.projectId !== projectId || previous !== undefined && record.id <= previous) throw new HubProtocolError(); previous = record.id; }
    if (page.next !== null && (!page.records.length || page.next !== previous)) throw new HubProtocolError();
    return { records: page.records, next: page.next };
  }
  #check<T>(record: T, valid: (value: T) => boolean): T { if (!valid(record)) throw new HubProtocolError(); return record; }

  async settings(projectId: string) { return this.#check((await this.#call('settings-get', { projectId })).record, (row) => !row || row.document.projectId === projectId); }
  async putSettings(settings: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string) {
    const result = await this.#call('settings-put', { settings, expectedRevision, ...(clientRequestId === undefined ? {} : { clientRequestId }) });
    return this.#check(result.record, (row) => row.document.projectId === settings.projectId && row.revision === expectedRevision + 1);
  }
  async coordinator(projectId: string) { return this.#check((await this.#call('coordinator-get', { projectId })).record, (row) => !row || row.document.projectId === projectId); }
  async assignCoordinator(projectId: string, deviceId: string, expectedRevision: number) {
    const result = await this.#call('coordinator-assign', { projectId, deviceId, expectedRevision });
    return this.#check(result.record, (row) => row.document.projectId === projectId && row.document.deviceId === deviceId && row.revision === expectedRevision + 1);
  }
  async coordinatorStatus(projectId: string) { return this.#check((await this.#call('coordinator-status-get', { projectId })).record, (row) => !row || row.document.projectId === projectId); }
  async putCoordinatorStatus(status: ProjectCoordinatorStatus) {
    this.#check((await this.#call('coordinator-status-put', { status })).record, (row) => row.document.projectId === status.projectId && row.document.deviceId === status.deviceId);
  }
  async threads(projectId: string, after?: string) { return this.#page((await this.#call('threads-list', { projectId, ...(after === undefined ? {} : { after }) })), projectId, after); }
  async thread(threadId: string) { return this.#check((await this.#call('thread-get', { threadId })).record, (row) => !row || row.document.id === threadId); }
  async publishThread(index: ThreadIndex, eventId: number) {
    const result = this.#check(await this.#call('thread-publish', { index, eventId }), (value) => value.threadId === index.id && value.eventId >= eventId);
    return { eventId: result.eventId };
  }
  async decisions(projectId: string) {
    const records: ProjectDecision[] = []; let after: string | undefined;
    for (;;) {
      const page = this.#page(await this.#call('decisions-list', { projectId, ...(after === undefined ? {} : { after }) }), projectId, after);
      records.push(...page.records); if (page.next === null) return records; after = page.next;
    }
  }
  async decision(id: string) { return this.#check((await this.#call('decision-get', { id })).record, (row) => !row || row.document.id === id); }
  async createDecision(decision: ProjectDecision) { return this.#check((await this.#call('decision-create', { decision })).record, (row) => row.document.id === decision.id && row.document.projectId === decision.projectId); }
  async withdrawDecision(id: string, at: string) { return this.#check((await this.#call('decision-withdraw', { id, at })).record, (row) => row.document.id === id); }
  async answerDecision(id: string, answer: DecisionAnswer, at: string, clientRequestId: string) {
    const result = this.#check(await this.#call('decision-answer', { id, answer, at, clientRequestId }), (value) => value.record.document.id === id && value.record.document.answer !== undefined);
    return { decision: result.record, repeated: result.repeated };
  }
  async notebook(projectId: string) { return this.#check((await this.#call('notebook-get', { projectId })).record, (row) => !row || row.document.projectId === projectId); }
  async putNotebook(notebook: ProjectNotebook, expectedRevision: number) {
    return this.#check((await this.#call('notebook-put', { notebook, expectedRevision })).record, (row) => row.document.projectId === notebook.projectId && row.revision === expectedRevision + 1);
  }
  async addOverride(override: PlacementOverride) {
    this.#check((await this.#call('override-add', { override })).override, (stored) => stored.id === override.id && stored.projectId === override.projectId && stored.threadId === override.threadId);
  }
  /** Every record belongs to the project, at most `limit`, newest first. */
  async recentOverrides(projectId: string, limit: number) {
    return this.#check((await this.#call('overrides-recent', { projectId, limit })).records, (records) => records.length <= limit
      && records.every((record, index) => record.projectId === projectId && (index === 0 || Date.parse(records[index - 1]!.at) >= Date.parse(record.at))));
  }
  async putEnvelope(envelope: ProjectEnvelope) {
    const result = this.#check(await this.#call('envelope-put', { envelope }), (value) => value.id === envelope.id);
    return { stored: result.stored };
  }
  /** Every record is for the requested target, unique and in relay order; a page announcing more is never empty. */
  async pendingEnvelopes(targetDeviceId: string) {
    const result = this.#check(await this.#call('envelopes-pending', { targetDeviceId }), (value) => (!value.more || value.records.length > 0)
      && new Set(value.records.map((record) => record.id)).size === value.records.length
      && value.records.every((record, index) => record.targetDeviceId === targetDeviceId && (index === 0 || compareEnvelopes(value.records[index - 1]!, record) <= 0)));
    return { records: result.records, more: result.more };
  }
  async ackEnvelope(id: string) { this.#check(await this.#call('envelope-ack', { id }), (value) => value.id === id); }
  /** Project ids ascend across pages, past the cursor, and `next` is the last returned id. */
  async workSummaries() {
    const records: ProjectWorkSummary[] = []; let after: string | undefined;
    for (;;) {
      const page = await this.#call('work-summaries', after === undefined ? {} : { after });
      let previous = after;
      for (const record of page.records) { if (previous !== undefined && record.projectId <= previous) throw new HubProtocolError(); previous = record.projectId; }
      if (page.next !== null && (!page.records.length || page.next !== previous)) throw new HubProtocolError();
      records.push(...page.records); if (page.next === null) return records; after = page.next;
    }
  }
}
