import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CheckoutClaimSchema, ConversationIndexSchema, DecisionAnswerSchema, ENVELOPE_PAGE_BYTES, FileReservationSchema, IdSchema, MAIL_PAGE_BYTES, PROJECT_HUB_PAGE, PlacementOverrideSchema, ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema,
  ProjectDecisionSchema, ProjectEnvelopeSchema, ProjectHubRequestSchema, ProjectHubResultSchema, ProjectMailSchema, ProjectNotebookSchema, ProjectSchema, ProjectWorkSettingsSchema,
  ProjectWorkSummarySchema, ReservationRequestSchema, ThreadIndexCursorSchema, ThreadIndexSchema, TimestampSchema, checkHubRevision, collectionOf, compareEnvelopes, coordinatorMovable,
  coordinatorWorking, isTerminal, mailReaches, pathsOverlap, reservationActive, stableJson, withHubRevision, workCounts,
  type DecisionAnswer, type DeviceView, type DocumentSchema, type FileReservation, type HeldCheckout, type PlacementOverride, type ProjectCoordinator, type ProjectCoordinatorStatus, type ProjectDecision,
  type ProjectEnvelope, type ProjectHub, type ProjectHubOperation, type ProjectHubResult, type ProjectHubResultOf, type ProjectMail, type ProjectNotebook, type ProjectWorkSettings,
  type ProjectWorkSummary, type ReservationConflict, type ReservationRequest, type ReserveOutcome, type Stored, type ThreadIndex,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { HubProtocolError, type MemberHubClient } from './client.js';
import { settingsMutation } from './settings-mutation.js';

const SETTINGS = 'project-work-settings'; const COORDINATORS = 'project-coordinators'; const STATUS = 'project-coordinator-status';
const THREADS = 'project-threads'; const CURSORS = 'project-thread-cursors'; const DECISIONS = 'project-decisions'; const NOTEBOOKS = 'project-notebooks';
const OVERRIDES = 'project-placement-overrides'; const ENVELOPES = 'project-envelopes'; const MAIL = 'project-mail'; const RESERVATIONS = 'project-reservations';
/** Answered questions stay in the list for 14 days (D52). */
export const DECISION_LIST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Mail stays at least 14 days, and longer while a recipient that can still read it has not (D90, D286). */
export const MAIL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Reservations released or expired more than a day ago are deleted when the project's next reservation is made (D90). */
export const RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;

function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
/** The hub sets the revision (D3), so an index's identity for retries is its content without it. */
const indexDigest = (index: ThreadIndex) => createHash('sha256').update(stableJson({ ...index, revision: 0 })).digest('hex');
/** A mail's identity for retries: the hub sets its time, revision and readers (D285). */
const mailIdentity = (mail: ProjectMail) => stableJson({ ...mail, revision: 0, at: '', readBy: [] });
const byTime = (a: { at: string; id: string }, b: { at: string; id: string }) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
  /** A thread's index, when the hub has it (a first publish may still be on its way, like overrides), must be of the project and the caller's. */
  #ownThread(projectId: string, threadId: string, message: string): ThreadIndex | undefined {
    const index = this.thread(threadId)?.document;
    if (index && (index.projectId !== projectId || index.ownerDeviceId !== this.deviceId)) refuse(message, 403);
    return index;
  }
  #documents<T extends { revision: number }>(namespace: string, schema: DocumentSchema<T>, projectId: string): T[] {
    return this.hub.listByField(namespace, 'projectId', projectId, schema).map((row) => checkHubRevision(row).document);
  }
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

  /**
   * Mail between main threads (brief 5.11, 7.2). A thread's owner device sends its mail, the coordinator device the coordinator's; mail
   * to the coordinator travels as a coordinator event, never here. The hub stamps the time with its clock (the retention and the
   * reach of mail to all depend on it), and in the same transaction deletes the project's mail older than 14 days that every recipient
   * read or can no longer read (D90, D286).
   */
  sendMail(raw: ProjectMail): Stored<ProjectMail> {
    const mail = ProjectMailSchema.parse(raw);
    if (mail.readBy.length) refuse('New mail cannot already be read.', 400);
    if (mail.to !== 'all' && (mail.to === 'coordinator' || !IdSchema.safeParse(mail.to).success)) refuse('Mail goes to a thread id or to all; the coordinator receives mail as an event.', 400);
    if (mail.from === 'all' || (mail.from !== 'coordinator' && !IdSchema.safeParse(mail.from).success)) refuse('Mail comes from a thread id or from the coordinator.', 400);
    return this.hub.transaction(() => {
      this.#project(mail.projectId);
      if (mail.from === 'coordinator') { if (this.coordinator(mail.projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can send the coordinator’s mail.', 403); }
      else this.#ownThread(mail.projectId, mail.from, 'Only the thread owner can send its mail.');
      const existing = this.#get(MAIL, mail.id, ProjectMailSchema);
      if (existing) {
        if (mailIdentity(existing.document) !== mailIdentity(mail)) refuse('This mail id was already used for a different message.');
        return existing;
      }
      const now = this.now(); this.#pruneMail(mail.projectId, now);
      return this.#put(MAIL, mail.id, ProjectMailSchema, { ...mail, at: new Date(now).toISOString() }, 0);
    });
  }
  #pruneMail(projectId: string, now: number): void {
    const old = this.#documents(MAIL, ProjectMailSchema, projectId).filter((mail) => now - Date.parse(mail.at) > MAIL_RETENTION_MS);
    if (!old.length) return;
    const threads = this.#documents(THREADS, ThreadIndexSchema, projectId);
    // A recipient that ended (or whose thread is unknown here) will never read it.
    for (const mail of old) {
      if (threads.filter((thread) => mailReaches(mail, thread)).every((thread) => isTerminal(thread.state) || mail.readBy.includes(thread.id))) this.hub.delete(MAIL, mail.id);
    }
  }
  /**
   * The thread's unread mail, oldest first (by the hub's time), cut at 100 or about 1 MiB (always one). Reading marks nothing, so a
   * lost reply repeats mail instead of losing it (D285). A thread whose index the hub does not have yet gets only the mail addressed
   * to it; mail to all reaches it once the hub knows when it was created.
   */
  inbox(projectId: string, threadId: string): { records: ProjectMail[]; more: boolean } {
    IdSchema.parse(projectId); IdSchema.parse(threadId); this.#project(projectId);
    const reader = this.#ownThread(projectId, threadId, 'Only the thread owner can read its mail.');
    const unread = this.#documents(MAIL, ProjectMailSchema, projectId)
      .filter((mail) => !mail.readBy.includes(threadId) && (reader ? mailReaches(mail, reader) : mail.to === threadId && mail.from !== threadId)).sort(byTime);
    const records: ProjectMail[] = []; let bytes = 0;
    for (const mail of unread) {
      const size = Buffer.byteLength(JSON.stringify(mail));
      if (records.length === PROJECT_HUB_PAGE || (records.length && bytes + size > MAIL_PAGE_BYTES)) break;
      records.push(mail); bytes += size;
    }
    return { records, more: records.length < unread.length };
  }
  /** Marks received mail read by the thread; mail already read or deleted is skipped, and mail not addressed to it is refused. */
  markRead(projectId: string, threadId: string, ids: readonly string[]): { read: number } {
    IdSchema.parse(projectId); IdSchema.parse(threadId); for (const id of ids) IdSchema.parse(id);
    return this.hub.transaction(() => {
      this.#project(projectId); this.#ownThread(projectId, threadId, 'Only the thread owner can read its mail.');
      let read = 0;
      for (const id of new Set(ids)) {
        const current = this.#get(MAIL, id, ProjectMailSchema); if (!current || current.document.readBy.includes(threadId)) continue;
        const mail = current.document;
        if (mail.projectId !== projectId || mail.from === threadId || (mail.to !== threadId && mail.to !== 'all')) refuse('This mail is not addressed to that thread.', 403);
        this.#put(MAIL, id, ProjectMailSchema, { ...mail, readBy: [...mail.readBy, threadId] }, current.revision); read += 1;
      }
      return { read };
    });
  }

  /**
   * Advisory path reservations (brief 5.11, 7.2), by the thread's owner device. One transaction deletes the project's reservations
   * released or expired more than a day ago (D90), finds other threads' active reservations with overlapping paths (`pathsOverlap`,
   * no globbing) and stores the new one only when there are none, with the hub clock's times. The same id again returns the stored
   * reservation (a retry after a lost reply), whatever its state since; with other paths it is refused.
   */
  reserve(raw: ReservationRequest): ReserveOutcome {
    const request = ReservationRequestSchema.parse(raw);
    return this.hub.transaction((): ReserveOutcome => {
      this.#project(request.projectId); this.#ownThread(request.projectId, request.threadId, 'Only the thread owner can reserve paths for it.');
      const existing = this.#get(RESERVATIONS, request.id, FileReservationSchema);
      if (existing) {
        const document = existing.document;
        if (document.projectId !== request.projectId || document.threadId !== request.threadId || document.deviceId !== this.deviceId || stableJson(document.paths) !== stableJson(request.paths)
          || document.reason !== request.reason) refuse('This reservation id was already used for other paths.');
        return { granted: true, reservation: existing };
      }
      const now = this.now(); const kept: FileReservation[] = [];
      for (const reservation of this.#documents(RESERVATIONS, FileReservationSchema, request.projectId)) {
        const ended = Math.min(Date.parse(reservation.expiresAt), reservation.releasedAt ? Date.parse(reservation.releasedAt) : Infinity);
        if (now - ended > RESERVATION_RETENTION_MS) this.hub.delete(RESERVATIONS, reservation.id); else kept.push(reservation);
      }
      const conflicts = kept.filter((reservation) => reservation.threadId !== request.threadId && reservationActive(reservation, now))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
        .flatMap((reservation): ReservationConflict[] => {
          const paths = reservation.paths.filter((path) => request.paths.some((wanted) => pathsOverlap(path, wanted)));
          return paths.length ? [{ threadId: reservation.threadId, threadTitle: this.thread(reservation.threadId)?.document.title ?? null, paths, expiresAt: reservation.expiresAt }] : [];
        }).slice(0, PROJECT_HUB_PAGE);
      if (conflicts.length) return { granted: false, conflicts };
      return { granted: true, reservation: this.#put<FileReservation>(RESERVATIONS, request.id, FileReservationSchema, { schema: 'file-reservation-v1', revision: 0, id: request.id,
        projectId: request.projectId, threadId: request.threadId, deviceId: this.deviceId, paths: request.paths, reason: request.reason, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + request.minutes * 60_000).toISOString() }, 0) };
    });
  }
  /**
   * Releases one reservation of the thread by id (another thread's or an unknown id is not found), or all of the thread's active
   * ones; only the device that reserved them releases them. Returns how many were still active (a repeat releases none).
   */
  release(projectId: string, threadId: string, id?: string): { released: number } {
    IdSchema.parse(projectId); IdSchema.parse(threadId);
    return this.hub.transaction(() => {
      this.#project(projectId); this.#ownThread(projectId, threadId, 'Only the thread owner can release its reservations.');
      const now = this.now();
      let targets: FileReservation[];
      if (id === undefined) targets = this.#documents(RESERVATIONS, FileReservationSchema, projectId).filter((reservation) => reservation.threadId === threadId);
      else {
        const reservation = this.#get(RESERVATIONS, IdSchema.parse(id), FileReservationSchema)?.document;
        if (reservation?.projectId !== projectId || reservation.threadId !== threadId) refuse('This reservation was not found.', 404);
        targets = [reservation];
      }
      let released = 0;
      for (const reservation of targets) {
        if (reservation.deviceId !== this.deviceId) refuse('Only the device that reserved these paths can release them.', 403);
        if (!reservationActive(reservation, now)) continue;
        this.#put(RESERVATIONS, reservation.id, FileReservationSchema, { ...reservation, releasedAt: new Date(now).toISOString() }, reservation.revision); released += 1;
      }
      return { released };
    });
  }
  /** The project's active reservations by the hub clock, in pages of 100 by id. */
  reservations(projectId: string, after?: string): Page<FileReservation> {
    const now = this.now(); return this.#page(RESERVATIONS, FileReservationSchema, projectId, after, (reservation) => reservationActive(reservation, now));
  }

  /**
   * Where a new main thread cannot work (brief 10, D65, D288), for any device of the mesh: per device with a path in the project, the
   * held checkout claim of its checkout (the stored path is the claim's, or the claim belongs to a thread or conversation of this project;
   * members' paths are never resolved here), else the project's oldest main thread there that has not ended, whose claim may not exist yet.
   */
  heldCheckouts(projectId: string): HeldCheckout[] {
    const project = this.hub.get('projects', IdSchema.parse(projectId), ProjectSchema)?.document;
    if (!project) refuse('Project not found.', 404);
    const threads = this.#documents(THREADS, ThreadIndexSchema, projectId);
    const ours = (ownerId: string) => threads.some((index) => index.id === ownerId) || this.hub.get('conversations', ownerId, ConversationIndexSchema)?.document.projectId === projectId;
    const held = new Map<string, HeldCheckout>();
    const hold = (deviceId: string, ownerId: string, title: string) => { if (!held.has(deviceId)) held.set(deviceId, { deviceId, ownerId, title: title.slice(0, 200) }); };
    for (const deviceId of Object.keys(project.paths).sort()) {
      for (const { document: claim } of this.hub.listByField('checkout-ownership', 'deviceId', deviceId, CheckoutClaimSchema)) {
        if (claim.held && (project.paths[deviceId] === claim.path || ours(claim.conversationId))) hold(deviceId, claim.conversationId, claim.conversationTitle);
      }
    }
    for (const index of [...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))) {
      if (index.isolation === 'main' && !isTerminal(index.state) && project.paths[index.ownerDeviceId]) hold(index.ownerDeviceId, index.id, index.title);
    }
    return [...held.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0)).slice(0, PROJECT_HUB_PAGE);
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
      case 'mail-send': result = { ...base, record: this.sendMail(request.mail) }; break;
      case 'mail-inbox': result = { ...base, ...this.inbox(request.projectId, request.threadId) }; break;
      case 'mail-read': result = { ...base, ...this.markRead(request.projectId, request.threadId, request.ids) }; break;
      case 'reserve': {
        const outcome = this.reserve(request.reservation);
        result = { ...base, reservation: outcome.granted ? outcome.reservation : null, conflicts: outcome.granted ? [] : outcome.conflicts }; break;
      }
      case 'release': result = { ...base, ...this.release(request.projectId, request.threadId, request.id) }; break;
      case 'reservations-list': result = { ...base, ...this.reservations(request.projectId, request.after) }; break;
      case 'checkouts-held': result = { ...base, records: this.heldCheckouts(request.projectId) }; break;
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
  async sendMail(mail: ProjectMail) { return this.#store.sendMail(mail); }
  async inbox(projectId: string, threadId: string) { return this.#store.inbox(projectId, threadId); }
  async markRead(projectId: string, threadId: string, ids: string[]) { return this.#store.markRead(projectId, threadId, ids).read; }
  async reserve(request: ReservationRequest) { return this.#store.reserve(request); }
  async release(projectId: string, threadId: string, id?: string) { return this.#store.release(projectId, threadId, id).released; }
  async reservations(projectId: string) {
    const records: FileReservation[] = []; let after: string | undefined;
    for (;;) { const page = this.#store.reservations(projectId, after); records.push(...page.records); if (page.next === null) return records; after = page.next; }
  }
  async heldCheckouts(projectId: string) { return this.#store.heldCheckouts(projectId); }
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
  /** The stored mail is the one sent: same id, project, sender, recipient and text (a retry may find it read already). */
  async sendMail(mail: ProjectMail) { return this.#check((await this.#call('mail-send', { mail })).record, (row) => mailIdentity(row.document) === mailIdentity(mail)); }
  /** Every record reaches the thread, unread and unique, oldest first; a page announcing more is never empty. */
  async inbox(projectId: string, threadId: string) {
    const result = this.#check(await this.#call('mail-inbox', { projectId, threadId }), (value) => (!value.more || value.records.length > 0)
      && new Set(value.records.map((mail) => mail.id)).size === value.records.length
      && value.records.every((mail, index) => mail.projectId === projectId && mail.from !== threadId && (mail.to === threadId || mail.to === 'all') && !mail.readBy.includes(threadId)
        && (index === 0 || byTime(value.records[index - 1]!, mail) <= 0)));
    return { records: result.records, more: result.more };
  }
  async markRead(projectId: string, threadId: string, ids: string[]) {
    return this.#check((await this.#call('mail-read', { projectId, threadId, ids })).read, (read) => read <= new Set(ids).size);
  }
  /** A grant is the requested reservation; a refusal names only other threads' paths that overlap the request. */
  async reserve(request: ReservationRequest): Promise<ReserveOutcome> {
    const result = await this.#call('reserve', { reservation: request });
    if (result.reservation) {
      const document = this.#check(result.reservation, (row) => result.conflicts.length === 0 && row.document.id === request.id && row.document.projectId === request.projectId
        && row.document.threadId === request.threadId && stableJson(row.document.paths) === stableJson(request.paths));
      return { granted: true, reservation: document };
    }
    return { granted: false, conflicts: this.#check(result.conflicts, (conflicts) => conflicts.length > 0 && conflicts.every((conflict) => conflict.threadId !== request.threadId
      && conflict.paths.every((path) => request.paths.some((wanted) => pathsOverlap(path, wanted))))) };
  }
  async release(projectId: string, threadId: string, id?: string) { return (await this.#call('release', { projectId, threadId, ...(id === undefined ? {} : { id }) })).released; }
  async reservations(projectId: string) {
    const records: FileReservation[] = []; let after: string | undefined;
    for (;;) {
      const page = this.#page(await this.#call('reservations-list', { projectId, ...(after === undefined ? {} : { after }) }), projectId, after);
      records.push(...page.records); if (page.next === null) return records; after = page.next;
    }
  }
  /** One entry per device, in device id order. */
  async heldCheckouts(projectId: string) {
    return this.#check((await this.#call('checkouts-held', { projectId })).records, (records) => records.every((record, index) => index === 0 || records[index - 1]!.deviceId < record.deviceId));
  }
}
