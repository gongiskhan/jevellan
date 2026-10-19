import { ProjectDeploySchema, ProjectDeployBaselineSchema, type ProjectDeploy, type ProjectDeployBaseline } from '@jevellan/core';
import { ProjectSetupProposalSchema, SetupActionRequestSchema, projectSetupPlan, defaultProjectWorkSettings, type ProjectSetupProposal, type SetupActionRequest } from '@jevellan/core';
import { HubState } from './state.js';
import { ProjectNotificationSchema, type ProjectNotification } from '@jevellan/core';
import { MergeDocumentSchema, type MergeDocument } from '@jevellan/core';
import { ProjectSessionCacheSchema, type ProjectSessionCache } from '@jevellan/core';
import { ProjectUsageDaySchema, type ProjectUsageDay } from '@jevellan/core';
import { PlacementOverrideFilterSchema, type PlacementOverrideFilter } from '@jevellan/core';
import { ProjectJobSchema, ProjectDailySchema, ProjectJobRunSchema, ProjectWindowSchema, type ProjectJob, type ProjectDaily, type ProjectJobRun, type ProjectWindow } from '@jevellan/core';
import { ProjectGoalSchema, ProjectRefillStateSchema, type ProjectGoal, type ProjectRefillState } from '@jevellan/core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CheckoutClaimSchema, ConversationIndexSchema, DecisionAnswerSchema, ENVELOPE_PAGE_BYTES, FileReservationSchema, IdSchema, MAIL_PAGE_BYTES, PROJECT_HUB_PAGE, PlacementOverrideSchema, ProjectCoordinatorSchema, ProjectCoordinatorStatusSchema,
  ProjectDecisionSchema, ProjectEnvelopeSchema, ProjectHubRequestSchema, ProjectHubResultSchema, ProjectMailSchema, ProjectNotebookSchema, ProjectSchema, ProjectWorkSettingsSchema, StoredProjectWorkSettingsSchema,
  ProjectWorkSummarySchema, ReservationRequestSchema, ThreadIndexCursorSchema, ThreadIndexSchema, TimestampSchema, checkHubRevision, collectionOf, compareEnvelopes, coordinatorMovable,
  ProjectWorkTaskSchema, TaskHistoryEventSchema, type ProjectWorkTask,
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
  #deployWriter(projectId: string) { this.#project(projectId); if (this.coordinator(projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can advance a deploy.', 403); }
  deploys(projectId: string, after?: string): Page<ProjectDeploy> { return this.#page('project-deploys', ProjectDeploySchema, projectId, after, () => true); }
  deploy(id: string): Stored<ProjectDeploy> | null { return this.#get('project-deploys', id, ProjectDeploySchema); }
  putDeploy(raw: ProjectDeploy, expectedRevision: number): Stored<ProjectDeploy> {
    const document = ProjectDeploySchema.parse(raw); this.#deployWriter(document.projectId);
    const previous = this.deploy(document.id)?.document;
    if (previous && (previous.projectId !== document.projectId || previous.createdAt !== document.createdAt || previous.decisionId !== document.decisionId)) refuse('A deploy cannot change identity.');
    if (previous && previous.commit !== document.commit && (previous.state !== 'open' || document.state !== 'open')) refuse('An approved deploy cannot change its commit.');
    return this.#put('project-deploys', document.id, ProjectDeploySchema, document, expectedRevision);
  }
  deployBaseline(projectId: string): Stored<ProjectDeployBaseline> | null { this.#project(projectId); return this.#get('project-deploy-baselines', projectId, ProjectDeployBaselineSchema); }
  putDeployBaseline(raw: ProjectDeployBaseline, expectedRevision: number): Stored<ProjectDeployBaseline> {
    const document = ProjectDeployBaselineSchema.parse(raw); this.#deployWriter(document.projectId);
    if (document.id !== document.projectId) refuse('A deploy baseline belongs to its project.');
    return this.#put('project-deploy-baselines', document.projectId, ProjectDeployBaselineSchema, document, expectedRevision);
  }
  updateDeployDecision(raw: ProjectDecision, expectedRevision: number): Stored<ProjectDecision> {
    const document = ProjectDecisionSchema.parse(raw); this.#deployWriter(document.projectId);
    const previous = this.decision(document.id)?.document;
    if (!previous?.deploy || !document.deploy || previous.projectId !== document.projectId || previous.createdAt !== document.createdAt) refuse('Only an existing deploy question can be updated.');
    const next = this.deploy(document.deploy.deployId)?.document;
    if (!next || next.projectId !== document.projectId || next.decisionId !== document.id && next.rollbackDecisionId !== document.id && next.failureDecisionId !== document.id) refuse('This question does not belong to the deploy.');
    if (previous.answer && !document.answer && this.deploy(previous.deploy.deployId)?.document.state !== 'rolled-back') refuse('An answered deploy question cannot be reopened before rollback.');
    return this.#put(DECISIONS, document.id, ProjectDecisionSchema, document, expectedRevision);
  }
  setupProposal(id: string): Stored<ProjectSetupProposal> | null { return this.#get('project-setup-proposals', id, ProjectSetupProposalSchema); }
  putSetupProposal(raw: ProjectSetupProposal): Stored<ProjectSetupProposal> {
    const document = ProjectSetupProposalSchema.parse(raw); this.#project(document.projectId);
    if (this.coordinator(document.projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can propose setup.', 403);
    if (document.revision || document.appliedAt || document.applied || document.dismissedAt) refuse('A setup proposal must be new.', 400);
    if (this.hub.redactor.text(JSON.stringify(document)) !== JSON.stringify(document)) refuse('Store credentials in their Settings fields.', 400);
    return this.#put('project-setup-proposals', document.id, ProjectSetupProposalSchema, document, 0);
  }
  setupAction(projectId: string, id: string, raw: SetupActionRequest): Stored<ProjectSetupProposal> {
    const input = SetupActionRequestSchema.parse(raw);
    const schema = z.strictObject({ revision: z.number().int().positive(), document: ProjectSetupProposalSchema });
    return settingsMutation(this.hub, this.deviceId, 'setup-action', { projectId, id, input }, input.clientRequestId, schema, () => {
      const row = this.setupProposal(id); if (!row || row.document.projectId !== projectId) refuse('Setup proposal not found.', 404);
      if (row.revision !== input.expectedRevision || row.document.appliedAt || row.document.dismissedAt) refuse('This setup changed. Reload before applying it.');
      const at = new Date(this.now()).toISOString(), proposal = row.document;
      if (input.action === 'dismiss') return this.#put('project-setup-proposals', id, ProjectSetupProposalSchema, { ...proposal, dismissedAt: at }, row.revision);
      const project = this.hub.get('projects', projectId, ProjectSchema); if (!project) refuse('Project not found.', 404);
      const settings = this.settings(projectId), current = settings?.document ?? defaultProjectWorkSettings(projectId);
      if (project.revision !== input.projectRevision || (settings?.revision ?? 0) !== input.settingsRevision) refuse('These settings changed elsewhere. Reload to see them.');
      const plan = projectSetupPlan(proposal, input.selected, current, project.document, at);
      if (this.hub.redactor.text(JSON.stringify(plan)) !== JSON.stringify(plan)) refuse('Store credentials in their Settings fields.', 400);
      if (plan.projectChanged) new HubState(this.hub, this.deviceId, Object.keys(this.hub.configuration.current()!.configuration['x-jevellan'].runtimes)).projects.put(plan.project, project.revision);
      if (stableJson(plan.settings) !== stableJson(current)) this.putSettings(plan.settings, settings?.revision ?? 0);
      for (const goal of plan.goals) this.putGoal(goal, 0);
      const items = proposal.items.map((item, index) => ({ ...item, value: input.selected.find(row => row.index === index)?.value ?? item.value }));
      return this.#put('project-setup-proposals', id, ProjectSetupProposalSchema, { ...proposal, items, appliedAt: at, applied: input.selected.map(row => row.index) }, row.revision);
    });
  }
  usageDays(projectId: string): ProjectUsageDay[] { return this.#documents('project-usage', ProjectUsageDaySchema, projectId).filter(row => Date.parse(`${row.day}T12:00:00Z`) >= this.now() - 32 * 86400000); }
  usagePage(projectId: string, after?: string): Page<ProjectUsageDay> {
    const records: ProjectUsageDay[] = []; let cursor = after, bytes = 0;
    for (;;) {
      const rows = this.hub.listByField('project-usage', 'projectId', projectId, ProjectUsageDaySchema, { limit: PROJECT_HUB_PAGE, ...(cursor ? { after: cursor } : {}) });
      for (const stored of rows) {
        const document = checkHubRevision(stored).document, id = createHash('sha256').update(document.id).digest('hex');
        if (Date.parse(`${document.day}T12:00:00Z`) < this.now() - 32 * 86400000) { cursor = id; continue; }
        const size = Buffer.byteLength(JSON.stringify(document));
        if (records.length && (bytes + size > ENVELOPE_PAGE_BYTES || records.length === PROJECT_HUB_PAGE)) return { records, next: cursor ?? null };
        records.push(document); bytes += size; cursor = id;
      }
      if (rows.length < PROJECT_HUB_PAGE) return { records, next: null };
    }
  }
  putNotification(raw: ProjectNotification): void {
    const document = ProjectNotificationSchema.parse(raw);
    if (!document.projectId || document.kind === 'test') refuse('Project notifications need a project.', 400);
    this.#project(document.projectId);
    if (document.sentAt || document.dropped) refuse('New notifications cannot already be delivered.', 400);
    if (!this.hub.get('project-notifications', document.id, ProjectNotificationSchema)) this.#put('project-notifications', document.id, ProjectNotificationSchema, document, 0);
  }
  putUsageDay(raw: ProjectUsageDay): void {
    const document = ProjectUsageDaySchema.parse(raw); this.#project(document.projectId);
    if (document.deviceId !== this.deviceId || document.id !== `${document.projectId}:${document.deviceId}:${document.day}`) refuse('Only the usage device can publish its own project day.', 403);
    const id = createHash('sha256').update(document.id).digest('hex');
    const previous = this.#get('project-usage', id, ProjectUsageDaySchema);
    if (previous && (previous.document.lastEventId ?? 0) > (document.lastEventId ?? 0)) return;
    if (previous && stableJson({ ...previous.document, revision: 0 }) === stableJson({ ...document, revision: 0 })) return;
    this.#put('project-usage', id, ProjectUsageDaySchema, document, previous?.revision ?? 0);
  }
  sessionCaches(projectId: string): ProjectSessionCache[] { return this.#documents('project-session-cache', ProjectSessionCacheSchema, projectId); }
  putSessionCache(raw: ProjectSessionCache): void {
    const document = ProjectSessionCacheSchema.parse(raw); this.#project(document.projectId);
    if (document.deviceId !== this.deviceId) refuse('Only the session device can publish its cache counters.', 403);
    const id = createHash('sha256').update(JSON.stringify([document.projectId, document.deviceId])).digest('hex');
    const previous = this.#get('project-session-cache', id, ProjectSessionCacheSchema);
    if (previous && previous.document.lastEventId >= document.lastEventId) return;
    this.#put('project-session-cache', id, ProjectSessionCacheSchema, document, previous?.revision ?? 0);
  }
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

  jobs(projectId: string, after?: string): Page<ProjectJob> { return this.#page('project-jobs', ProjectJobSchema, projectId, after, () => true); }
  job(jobId: string): Stored<ProjectJob> | null { return this.#get('project-jobs', jobId, ProjectJobSchema); }
  putJob(raw: ProjectJob, expectedRevision: number): Stored<ProjectJob> {
    const document = ProjectJobSchema.parse(raw); this.#project(document.projectId);
    const previous = this.job(document.id)?.document;
    if (previous && previous.projectId !== document.projectId) refuse('This document belongs to another project.', 403);
    if (previous && (previous.createdAt !== document.createdAt || previous.requestDigest !== document.requestDigest)) refuse('Document identity cannot change.', 400);
    let parent = document.gate?.jobId; const visited = new Set([document.id]);
    while (parent) {
      if (visited.has(parent)) refuse('Job gates cannot contain a cycle.', 400); visited.add(parent);
      const gate = this.job(parent)?.document; if (!gate || gate.projectId !== document.projectId) refuse('A gate must be a job of this project.', 400); parent = gate.gate?.jobId;
    }
    return this.#put('project-jobs', document.id, ProjectJobSchema, document, expectedRevision);
  }
  dailies(projectId: string, after?: string): Page<ProjectDaily> { return this.#page('project-dailies', ProjectDailySchema, projectId, after, () => true); }
  daily(dailyId: string): Stored<ProjectDaily> | null { return this.#get('project-dailies', dailyId, ProjectDailySchema); }
  putDaily(raw: ProjectDaily, expectedRevision: number): Stored<ProjectDaily> {
    const document = ProjectDailySchema.parse(raw); this.#project(document.projectId);
    const previous = this.daily(document.id)?.document;
    if (document.target.kind === 'review-since-last' && this.#documents('project-dailies', ProjectDailySchema, document.projectId).some(row => row.id !== document.id && row.target.kind === 'review-since-last')) refuse('A project has one Review since last item.', 409);
    if (previous && previous.projectId !== document.projectId) refuse('This document belongs to another project.', 403);
    if (previous && (previous.createdAt !== document.createdAt || previous.requestDigest !== document.requestDigest)) refuse('Document identity cannot change.', 400);
    return this.#put('project-dailies', document.id, ProjectDailySchema, document, expectedRevision);
  }
  jobRuns(projectId: string, after?: string): Page<ProjectJobRun> { return this.#page('project-job-runs', ProjectJobRunSchema, projectId, after, () => true); }
  jobRun(jobRunId: string): Stored<ProjectJobRun> | null { return this.#get('project-job-runs', jobRunId, ProjectJobRunSchema); }
  putJobRun(raw: ProjectJobRun, expectedRevision: number): Stored<ProjectJobRun> {
    const document = ProjectJobRunSchema.parse(raw); this.#project(document.projectId);
    const previous = this.jobRun(document.id)?.document;
    if (previous && previous.projectId !== document.projectId) refuse('This document belongs to another project.', 403);
    const coordinatorId = this.coordinator(document.projectId)?.document.deviceId;
    if (coordinatorId !== this.deviceId && (!previous || previous.deviceId !== this.deviceId)) refuse('Only the coordinator or executing device can write execution receipts.', 403);
    if (document.requestedByDeviceId && (!previous && document.requestedByDeviceId !== this.deviceId || previous && document.requestedByDeviceId !== previous.requestedByDeviceId)) refuse('The requesting device cannot change.', 400);
    if (!document.conclusion && document.phase !== 'waiting') {
      const active = this.hub.list('project-job-runs', ProjectJobRunSchema).map(row => row.document).filter(row => row.id !== document.id && !row.conclusion && row.phase !== 'waiting');
      if (active.some(row => row.projectId === document.projectId || row.deviceId === document.deviceId)) refuse('One job runs per project and per device at a time.');
    }
    if (this.devices?.().find(view => view.device.id === this.deviceId)?.device.workPolicy?.mode === 'apps-only') refuse('This device serves apps only; project work runs on a working device.', 409);
    const task = this.task(document.taskId)?.document;
    if (!task || task.projectId !== document.projectId || task.jobId !== document.jobId) refuse('The job run must belong to its task.', 400);
    if (previous && stableJson(previous.workflowHandoff) !== stableJson(document.workflowHandoff)) refuse('The workflow handoff receipt cannot change.', 409);
    if (previous && (stableJson(previous.workflowScheduler) !== stableJson(document.workflowScheduler) || previous.nightlyWindowId !== document.nightlyWindowId)) refuse('The workflow scheduler receipt cannot change.', 409);
    if (previous?.deploymentCommandStartedAt && previous.deploymentCommandStartedAt !== document.deploymentCommandStartedAt) refuse('The deploy command start receipt cannot change.', 409);
    if (previous && (previous.commit !== document.commit || stableJson(previous.deployment) !== stableJson(document.deployment))) refuse('The pinned job commit cannot change.', 409);
    if (document.deployment && stableJson(task.deployment) !== stableJson(document.deployment)) refuse('The deploy receipt must match its approved task.', 409);
    if (previous && (previous.taskId !== document.taskId || previous.jobId !== document.jobId || previous.projectDay !== document.projectDay || previous.startedAt !== document.startedAt || (previous.phase !== 'waiting' && previous.deviceId !== document.deviceId || previous.phase === 'waiting' && coordinatorId !== this.deviceId && previous.deviceId !== document.deviceId) || previous.setupCommand !== document.setupCommand || stableJson(previous.spec) !== stableJson(document.spec))) refuse('Job run identity cannot change.', 400);
    // Cleanup metadata may be added after completion; execution results remain immutable.
    if (previous?.conclusion && stableJson({ ...previous, revision: 0, dispatchRefDeletedAt: undefined, cleanedAt: undefined }) !== stableJson({ ...document, revision: 0, dispatchRefDeletedAt: undefined, cleanedAt: undefined })) refuse('A finished job receipt cannot change.', 409);
    if (previous?.dispatchRefDeletedAt && previous.dispatchRefDeletedAt !== document.dispatchRefDeletedAt) refuse('The ref cleanup receipt cannot change.', 409);
    if (document.cleanedAt && !document.conclusion || previous?.cleanedAt && previous.cleanedAt !== document.cleanedAt) refuse('The ref cleanup receipt cannot change.', 409);
    return this.#put('project-job-runs', document.id, ProjectJobRunSchema, document, expectedRevision);
  }
  windows(projectId: string, after?: string): Page<ProjectWindow> { return this.#page('project-windows', ProjectWindowSchema, projectId, after, () => true); }
  window(windowId: string): Stored<ProjectWindow> | null { return this.#get('project-windows', windowId, ProjectWindowSchema); }
  putWindow(raw: ProjectWindow, expectedRevision: number): Stored<ProjectWindow> {
    const document = ProjectWindowSchema.parse(raw); this.#project(document.projectId);
    const previous = this.window(document.id)?.document;
    if (previous && previous.projectId !== document.projectId) refuse('This document belongs to another project.', 403);
    if (this.coordinator(document.projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can write execution receipts.', 403);
    if (this.devices?.().find(view => view.device.id === this.deviceId)?.device.workPolicy?.mode === 'apps-only') refuse('This device serves apps only; project work runs on a working device.', 409);
    if (document.mergesHeld !== (document.state === 'open') || new Set(document.taskIds).size !== document.taskIds.length || document.taskIds.length !== document.plans.length || document.plans.some((plan, index) => plan.id !== document.taskIds[index] || plan.projectId !== document.projectId || plan.projectDay !== document.closingProjectDay || plan.source !== 'daily')) refuse('The nightly window plans are invalid.', 400);
    if (previous && (previous.date !== document.date || previous.closingProjectDay !== document.closingProjectDay || previous.openedAt !== document.openedAt || stableJson(previous.plans) !== stableJson(document.plans) || stableJson(previous.taskIds) !== stableJson(document.taskIds))) refuse('Nightly window identity cannot change.', 400);
    if (previous?.state === 'finished' && document.state !== 'finished') refuse('A finished nightly window cannot reopen.', 409);
    if (!previous && this.#documents('project-windows', ProjectWindowSchema, document.projectId).some(row => row.state === 'open')) refuse('This project already has an open nightly window.', 409);
    return this.#put('project-windows', document.id, ProjectWindowSchema, document, expectedRevision);
  }

  goals(projectId: string, after?: string): Page<ProjectGoal> { return this.#page('project-goals', ProjectGoalSchema, projectId, after, () => true); }
  goal(goalId: string): Stored<ProjectGoal> | null { return this.#get('project-goals', goalId, ProjectGoalSchema); }
  putGoal(raw: ProjectGoal, expectedRevision: number): Stored<ProjectGoal> {
    const goal = ProjectGoalSchema.parse(raw); this.#project(goal.projectId);
    const previous = this.goal(goal.id)?.document;
    if (previous && (previous.projectId !== goal.projectId || previous.createdAt !== goal.createdAt || previous.requestDigest !== goal.requestDigest)) refuse('Goal identity cannot change.', 400);
    return this.#put('project-goals', goal.id, ProjectGoalSchema, goal, expectedRevision);
  }
  refill(projectId: string): Stored<ProjectRefillState> | null { return this.#get('project-refill-state', projectId, ProjectRefillStateSchema); }
  putRefill(raw: ProjectRefillState, expectedRevision: number): Stored<ProjectRefillState> {
    const refill = ProjectRefillStateSchema.parse(raw); this.#project(refill.projectId);
    if (this.coordinator(refill.projectId)?.document.deviceId !== this.deviceId) refuse('Only the coordinator device can request a refill.', 403);
    return this.#put('project-refill-state', refill.projectId, ProjectRefillStateSchema, refill, expectedRevision);
  }
  settings(projectId: string): Stored<ProjectWorkSettings> | null { return this.#get(SETTINGS, projectId, StoredProjectWorkSettingsSchema); }
  tasks(projectId: string, after?: string): Page<ProjectWorkTask> { return this.#page('project-work-tasks', ProjectWorkTaskSchema, projectId, after, () => true); }
  task(taskId: string): Stored<ProjectWorkTask> | null { return this.#get('project-work-tasks', taskId, ProjectWorkTaskSchema); }
  taskHistory(taskId: string) { return this.hub.listByField('project-work-task-history', 'taskId', IdSchema.parse(taskId), TaskHistoryEventSchema).map(row => row.document).sort((a, b) => a.sequence - b.sequence); }
  putTask(raw: ProjectWorkTask, expectedRevision: number): Stored<ProjectWorkTask> {
    const task = ProjectWorkTaskSchema.parse(raw);
    return this.hub.transaction(() => {
      this.#project(task.projectId);
      if (this.coordinator(task.projectId)?.document.deviceId !== this.deviceId) refuse('Only the current coordinator device can write the task queue.', 403);
      const current = this.task(task.id);
      if (current && current.document.projectId !== task.projectId) refuse('This task belongs to another project.', 403);
      if (current && stableJson(current.document.workflowHandoff) !== stableJson(task.workflowHandoff)) refuse('The task workflow handoff cannot change.', 409);
      if (task.nightlyReview && (task.source !== 'daily' || task.type !== 'review' || task.kind !== 'session' || task.threadId)) refuse('Nightly reviews are read-only daily sessions.', 400);
      if (task.reviewRun && (!task.nightlyReview || task.reviewRun.report && (task.reviewRun.report.taskId !== task.id || task.reviewRun.report.projectId !== task.projectId || task.reviewRun.report.commit !== task.reviewRun.commit || task.reviewRun.report.fromCommit !== task.reviewRun.fromCommit))) refuse('The review report must match its task and commit range.', 400);
      if (current?.document.reviewRun?.state === 'completed') {
        const { followupChosen: _chosen, fixTaskId: _fix, ...old } = current.document.reviewRun; void _chosen; void _fix;
        const { followupChosen: _nextChosen, fixTaskId: _nextFix, ...next } = task.reviewRun ?? {}; void _nextChosen; void _nextFix;
        if (stableJson(old) !== stableJson(next) || current.document.reviewRun.followupChosen && stableJson(current.document.reviewRun) !== stableJson(task.reviewRun)) refuse('A completed review and chosen follow-up cannot change.', 409);
      }
      if (task.nightlyFixFor) {
        const review = this.task(task.nightlyFixFor)?.document;
        if (review?.projectId !== task.projectId || review.reviewRun?.state !== 'completed' || review.goalId !== task.goalId || task.source !== 'finding' || task.type !== 'finding') refuse('The nightly fix must belong to its completed review and goal.', 400);
        if (this.#documents('project-work-tasks', ProjectWorkTaskSchema, task.projectId).some(row => row.id !== task.id && row.nightlyFixFor === task.nightlyFixFor)) refuse('A review can create at most one combined fix.', 409);
      }
      if (task.after.includes(task.id) || new Set(task.after).size !== task.after.length) refuse('Task dependencies must be distinct and cannot include the task itself.', 400);
      const visit = (id: string, visited = new Set<string>()): void => {
        if (id === task.id) refuse('Task dependencies cannot contain a cycle.', 400);
        if (visited.has(id)) return; visited.add(id);
        const parent = this.task(id)?.document; if (!parent || parent.projectId !== task.projectId) refuse('Every dependency must be a task of this project.', 400);
        for (const dependency of parent.after) visit(dependency, visited);
      };
      for (const id of task.after) visit(id);
      if (task.threadId && this.#documents('project-work-tasks', ProjectWorkTaskSchema, task.projectId).some(other => other.id !== task.id && other.threadId === task.threadId)) refuse('A thread already belongs to another task.');
      if (current && stableJson({ ...current.document, revision: 0 }) === stableJson({ ...task, revision: 0 })) return current;
      if (!current && task.source === 'refill') {
        const refill = this.refill(task.projectId)?.document, goal = task.goalId ? this.goal(task.goalId)?.document : undefined;
        if (!goal || goal.projectId !== task.projectId || goal.state !== 'active' || !task.refillEventId || refill?.eventId !== task.refillEventId || !refill.goals.some(item => item.goalId === goal.id)) refuse('This goal was not requested for refill in the current turn.', 403);
        const others = this.#documents('project-work-tasks', ProjectWorkTaskSchema, task.projectId);
        if (others.some(other => other.goalId === goal.id && other.refillEventId === task.refillEventId)) refuse('Only one task per goal can answer a refill event.', 409);
        if (others.filter(other => other.goalId === goal.id && other.source === 'refill' && other.projectDay === task.projectDay).length >= goal.dailyRefillCap) refuse('The goal reached its daily refill cap.', 409);
      }
      if (task.goalId && this.goal(task.goalId)?.document.projectId !== task.projectId) refuse('The goal must belong to this project.', 400);
      const stored = this.#put('project-work-tasks', task.id, ProjectWorkTaskSchema, task, expectedRevision);
      this.hub.put('project-work-task-history', `${task.id}_${String(stored.revision).padStart(10, '0')}`, TaskHistoryEventSchema,
        { schema: 'task-history-event-v1', taskId: task.id, projectId: task.projectId, sequence: stored.revision, state: task.state, title: task.title, at: task.updatedAt, threadId: task.threadId, ...(task.endNote ? { note: task.endNote } : {}) }, 0);
      return stored;
    });
  }
  /** Compare-and-swap on the row revision; a repeated clientRequestId returns the first result. */
  putSettings(raw: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string): Stored<ProjectWorkSettings> {
    const settings = ProjectWorkSettingsSchema.parse(raw);
    return settingsMutation(this.hub, this.deviceId, 'project-work-settings-put', { settings, expectedRevision }, clientRequestId, StoredSettingsSchema, () => {
      this.#project(settings.projectId); return this.#put(SETTINGS, settings.projectId, StoredProjectWorkSettingsSchema, settings, expectedRevision);
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
    if (this.devices?.().find(view => view.device.id === deviceId)?.device.workPolicy?.mode === 'apps-only') refuse('This device serves apps only; project work runs on a working device.', 409);
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

  mergeDocuments(projectId: string, after?: string, threadId?: string) {
    if (!threadId) return this.#page('project-merge-documents', MergeDocumentSchema, projectId, after, () => true);
    this.#project(projectId); const thread = this.thread(threadId)?.document; if (!thread || thread.projectId !== projectId) refuse('Thread not found.', 404);
    const rows = this.hub.listByField('project-merge-documents', 'threadId', IdSchema.parse(threadId), MergeDocumentSchema, { limit: PROJECT_HUB_PAGE + 1, ...(after ? { after } : {}) }).map(row => checkHubRevision(row).document);
    return { records: rows.slice(0, PROJECT_HUB_PAGE), next: rows.length > PROJECT_HUB_PAGE ? rows[PROJECT_HUB_PAGE - 1]!.id : null };
  }
  mergeDocument(id: string) { return this.#get('project-merge-documents', id, MergeDocumentSchema); }
  putMergeDocument(raw: MergeDocument, expectedRevision: number) {
    const document = MergeDocumentSchema.parse(raw);
    return this.hub.transaction(() => {
      this.#project(document.projectId);
      if (document.deviceId !== this.deviceId) refuse('This merge receipt belongs to another device.', 403);
      const thread = this.thread(document.threadId)?.document;
      if (!thread || thread.projectId !== document.projectId) refuse('Thread not found.', 404);
      if (!['merge-correction-v1', 'landing-correction-v1'].includes(document.schema) && thread.ownerDeviceId !== this.deviceId) refuse('Only the thread owner can advance its merge gate.', 403);
      const old = this.mergeDocument(document.id);
      if (old && (old.document.schema !== document.schema || old.document.projectId !== document.projectId || old.document.threadId !== document.threadId || old.document.commit !== document.commit || old.document.deviceId !== document.deviceId)) refuse('A merge receipt cannot change identity.');
      if (old && (document.schema === 'merge-correction-v1' || document.schema === 'landing-correction-v1')) {
        if (stableJson({ ...old.document, revision: 0, at: '', receivedOrder: 0 }) !== stableJson({ ...document, revision: 0, at: '', receivedOrder: 0 })) refuse('This correction ID already stores a different correction.');
        return old;
      }
      const receivedOrder = (document.schema === 'merge-correction-v1' || document.schema === 'landing-correction-v1') ? this.hub.listByField('project-merge-documents', 'projectId', document.projectId, MergeDocumentSchema)
        .reduce((last, row) => (row.document.schema === 'merge-correction-v1' || row.document.schema === 'landing-correction-v1') ? Math.max(last, row.document.receivedOrder ?? 0) : last, 0) + 1 : undefined;
      return this.#put('project-merge-documents', document.id, MergeDocumentSchema, receivedOrder === undefined ? document : { ...document, receivedOrder }, expectedRevision);
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
  recentOverrides(projectId: string, limit: number, filter?: PlacementOverrideFilter): PlacementOverride[] {
    const count = z.number().int().min(1).max(PROJECT_HUB_PAGE).parse(limit); if (filter) PlacementOverrideFilterSchema.parse(filter);
    return this.hub.listByField(OVERRIDES, 'projectId', IdSchema.parse(projectId), PlacementOverrideSchema, { order: 'insertion-desc' }).map((row) => row.document)
      .filter(row => !filter || ((row.taskType ?? 'feature') === filter.type) === (filter.match === 'same')).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, count);
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
      const drafts = this.#documents('project-work-tasks', ProjectWorkTaskSchema, project.id).filter(task => task.state === 'draft').length;
      const counts = workCounts(threads, decisions); counts.waiting += drafts;
      const assigned = this.coordinator(project.id)?.document.deviceId; const view = assigned === undefined ? undefined : devices.get(assigned);
      const status = assigned === undefined ? undefined : this.coordinatorStatus(project.id)?.document;
      return ProjectWorkSummarySchema.parse({ schema: 'project-work-summary-v1', projectId: project.id, name: project.name, status: this.settings(project.id)?.document.status ?? 'active', ...counts,
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
      case 'deploys-list': result = { ...base, ...this.deploys(request.projectId, request.after) }; break;
      case 'deploy-get': result = { ...base, record: this.deploy(request.id) }; break;
      case 'deploy-put': result = { ...base, record: this.putDeploy(request.document, request.expectedRevision) }; break;
      case 'deploy-baseline-get': result = { ...base, record: this.deployBaseline(request.projectId) }; break;
      case 'deploy-baseline-put': result = { ...base, record: this.putDeployBaseline(request.document, request.expectedRevision) }; break;
      case 'deploy-decision-update': result = { ...base, record: this.updateDeployDecision(request.document, request.expectedRevision) }; break;
      case 'jobs-list': result = { ...base, ...this.jobs(request.projectId, request.after) }; break;
      case 'job-get': result = { ...base, record: this.job(request.jobId) }; break;
      case 'job-put': result = { ...base, record: this.putJob(request.job, request.expectedRevision) }; break;
      case 'dailies-list': result = { ...base, ...this.dailies(request.projectId, request.after) }; break;
      case 'daily-get': result = { ...base, record: this.daily(request.dailyId) }; break;
      case 'daily-put': result = { ...base, record: this.putDaily(request.daily, request.expectedRevision) }; break;
      case 'job-runs-list': result = { ...base, ...this.jobRuns(request.projectId, request.after) }; break;
      case 'job-run-get': result = { ...base, record: this.jobRun(request.jobRunId) }; break;
      case 'job-run-put': result = { ...base, record: this.putJobRun(request.jobRun, request.expectedRevision) }; break;
      case 'windows-list': result = { ...base, ...this.windows(request.projectId, request.after) }; break;
      case 'window-get': result = { ...base, record: this.window(request.windowId) }; break;
      case 'window-put': result = { ...base, record: this.putWindow(request.window, request.expectedRevision) }; break;
      case 'goals-list': result = { ...base, ...this.goals(request.projectId, request.after) }; break;
      case 'goal-get': result = { ...base, record: this.goal(request.goalId) }; break;
      case 'goal-put': result = { ...base, record: this.putGoal(request.goal, request.expectedRevision) }; break;
      case 'refill-get': result = { ...base, record: this.refill(request.projectId) }; break;
      case 'refill-put': result = { ...base, record: this.putRefill(request.refill, request.expectedRevision) }; break;
      case 'tasks-list': result = { ...base, ...this.tasks(request.projectId, request.after) }; break;
      case 'task-get': result = { ...base, record: this.task(request.taskId) }; break;
      case 'task-put': result = { ...base, record: this.putTask(request.task, request.expectedRevision) }; break;
      case 'task-history': result = { ...base, records: this.taskHistory(request.taskId) }; break;
      case 'settings-get': result = { ...base, record: this.settings(request.projectId) }; break;
      case 'settings-put': result = { ...base, record: this.putSettings(request.settings, request.expectedRevision, request.clientRequestId) }; break;
      case 'coordinator-get': result = { ...base, record: this.coordinator(request.projectId) }; break;
      case 'coordinator-assign': result = { ...base, record: this.assignCoordinator(request.projectId, request.deviceId, request.expectedRevision) }; break;
      case 'coordinator-status-get': result = { ...base, record: this.coordinatorStatus(request.projectId) }; break;
      case 'session-caches': result = { ...base, records: this.sessionCaches(request.projectId) }; break;
      case 'setup-get': result = { ...base, record: this.setupProposal(request.id) }; break;
      case 'setup-put': result = { ...base, record: this.putSetupProposal(request.document) }; break;
      case 'setup-action': result = { ...base, record: this.setupAction(request.projectId, request.id, request.input) }; break;
      case 'usage-days': result = { ...base, ...this.usagePage(request.projectId, request.after) }; break;
      case 'notification-put': this.putNotification(request.document); result = { ...base }; break;
      case 'usage-day-put': this.putUsageDay(request.document); result = base; break;
      case 'session-cache-put': this.putSessionCache(request.snapshot); result = base; break;
      case 'coordinator-status-put': result = { ...base, record: this.putCoordinatorStatus(request.status) }; break;
      case 'threads-list': result = { ...base, ...this.threads(request.projectId, request.after) }; break;
      case 'thread-get': result = { ...base, record: this.thread(request.threadId) }; break;
      case 'thread-publish': result = { ...base, threadId: request.index.id, ...this.publishThread(request.index, request.eventId) }; break;
      case 'merge-documents': result = { ...base, ...this.mergeDocuments(request.projectId, request.after, request.threadId) }; break;
      case 'merge-document-get': result = { ...base, record: this.mergeDocument(request.id) }; break;
      case 'merge-document-put': result = { ...base, record: this.putMergeDocument(request.document, request.expectedRevision) }; break;
      case 'decisions-list': result = { ...base, ...this.decisions(request.projectId, request.after) }; break;
      case 'decision-get': result = { ...base, record: this.decision(request.id) }; break;
      case 'decision-create': result = { ...base, record: this.createDecision(request.decision) }; break;
      case 'decision-withdraw': result = { ...base, record: this.withdrawDecision(request.id, request.at) }; break;
      case 'decision-answer': { const answered = this.answerDecision(request.id, request.answer, request.at, request.clientRequestId); result = { ...base, record: answered.decision, repeated: answered.repeated }; break; }
      case 'notebook-get': result = { ...base, record: this.notebook(request.projectId) }; break;
      case 'notebook-put': result = { ...base, record: this.putNotebook(request.notebook, request.expectedRevision) }; break;
      case 'override-add': result = { ...base, override: this.addOverride(request.override) }; break;
      case 'overrides-recent': result = { ...base, records: this.recentOverrides(request.projectId, request.limit, request.filter) }; break;
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
  async setupProposal(id: string) { return this.#store.setupProposal(id); }
  async putSetupProposal(document: ProjectSetupProposal) { return this.#store.putSetupProposal(document); }
  async setupAction(projectId: string, id: string, input: SetupActionRequest) { return this.#store.setupAction(projectId, id, input); }
  async sessionCaches(projectId: string) { return this.#store.sessionCaches(projectId); }
  async usageDays(projectId: string) { return this.#store.usageDays(projectId); }
  async putNotification(document: ProjectNotification) { this.#store.putNotification(document); }
  async putUsageDay(document: ProjectUsageDay) { this.#store.putUsageDay(document); }
  async putSessionCache(snapshot: ProjectSessionCache) { this.#store.putSessionCache(snapshot); }
  async deploys(projectId: string, after?: string) { return this.#store.deploys(projectId, after); }
  async deploy(id: string) { return this.#store.deploy(id); }
  async putDeploy(document: ProjectDeploy, expectedRevision: number) { return this.#store.putDeploy(document, expectedRevision); }
  async deployBaseline(projectId: string) { return this.#store.deployBaseline(projectId); }
  async putDeployBaseline(document: ProjectDeployBaseline, expectedRevision: number) { return this.#store.putDeployBaseline(document, expectedRevision); }
  async updateDeployDecision(document: ProjectDecision, expectedRevision: number) { return this.#store.updateDeployDecision(document, expectedRevision); }
  async jobs(projectId: string, after?: string) { return this.#store.jobs(projectId, after); }
  async job(jobId: string) { return this.#store.job(jobId); }
  async putJob(job: ProjectJob, expectedRevision: number) { return this.#store.putJob(job, expectedRevision); }
  async dailies(projectId: string, after?: string) { return this.#store.dailies(projectId, after); }
  async daily(dailyId: string) { return this.#store.daily(dailyId); }
  async putDaily(daily: ProjectDaily, expectedRevision: number) { return this.#store.putDaily(daily, expectedRevision); }
  async jobRuns(projectId: string, after?: string) { return this.#store.jobRuns(projectId, after); }
  async jobRun(jobRunId: string) { return this.#store.jobRun(jobRunId); }
  async putJobRun(jobRun: ProjectJobRun, expectedRevision: number) { return this.#store.putJobRun(jobRun, expectedRevision); }
  async windows(projectId: string, after?: string) { return this.#store.windows(projectId, after); }
  async window(windowId: string) { return this.#store.window(windowId); }
  async putWindow(window: ProjectWindow, expectedRevision: number) { return this.#store.putWindow(window, expectedRevision); }
  readonly #store: HubProjectStore;
  constructor(hub: HubDatabase, deviceId: string, now?: () => number, devices?: () => readonly DeviceView[]) { this.#store = new HubProjectStore(hub, deviceId, now, devices); }
  async settings(projectId: string) { return this.#store.settings(projectId); }
  async goals(projectId: string, after?: string) { return this.#store.goals(projectId, after); }
  async goal(goalId: string) { return this.#store.goal(goalId); }
  async putGoal(goal: ProjectGoal, expectedRevision: number) { return this.#store.putGoal(goal, expectedRevision); }
  async refill(projectId: string) { return this.#store.refill(projectId); }
  async putRefill(refill: ProjectRefillState, expectedRevision: number) { return this.#store.putRefill(refill, expectedRevision); }
  async tasks(projectId: string, after?: string) { return this.#store.tasks(projectId, after); }
  async task(taskId: string) { return this.#store.task(taskId); }
  async putTask(task: ProjectWorkTask, expectedRevision: number) { return this.#store.putTask(task, expectedRevision); }
  async taskHistory(taskId: string) { return this.#store.taskHistory(taskId); }
  async putSettings(settings: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string) { return this.#store.putSettings(settings, expectedRevision, clientRequestId); }
  async coordinator(projectId: string) { return this.#store.coordinator(projectId); }
  async assignCoordinator(projectId: string, deviceId: string, expectedRevision: number) { return this.#store.assignCoordinator(projectId, deviceId, expectedRevision); }
  async coordinatorStatus(projectId: string) { return this.#store.coordinatorStatus(projectId); }
  async putCoordinatorStatus(status: ProjectCoordinatorStatus) { this.#store.putCoordinatorStatus(status); }
  async threads(projectId: string, after?: string) { return this.#store.threads(projectId, after); }
  async thread(threadId: string) { return this.#store.thread(threadId); }
  async publishThread(index: ThreadIndex, eventId: number) { return this.#store.publishThread(index, eventId); }
  async mergeDocuments(projectId: string, after?: string, threadId?: string) { return this.#store.mergeDocuments(projectId, after, threadId); }
  async mergeDocument(id: string) { return this.#store.mergeDocument(id); }
  async putMergeDocument(document: MergeDocument, expectedRevision: number) { return this.#store.putMergeDocument(document, expectedRevision); }
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
  async recentOverrides(projectId: string, limit: number, filter?: PlacementOverrideFilter) { return this.#store.recentOverrides(projectId, limit, filter); }
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
  async setupProposal(id: string) { const result = await this.#call('setup-get', { id }); return result.record; }
  async putSetupProposal(document: ProjectSetupProposal) { return (await this.#call('setup-put', { document })).record; }
  async setupAction(projectId: string, id: string, input: SetupActionRequest) { return (await this.#call('setup-action', { projectId, id, input })).record; }
  async sessionCaches(projectId: string) { return this.#check((await this.#call('session-caches', { projectId })).records, rows => rows.every(row => row.projectId === projectId)); }
  async usageDays(projectId: string) {
    const records: ProjectUsageDay[] = []; let after: string | undefined;
    for (;;) {
      const page = await this.#call('usage-days', { projectId, ...(after ? { after } : {}) });
      records.push(...this.#check(page.records, rows => rows.every(row => row.projectId === projectId)));
      if (page.next === null) return records; after = page.next;
    }
  }
  async putNotification(document: ProjectNotification) { await this.#call('notification-put', { document }); }
  async putUsageDay(document: ProjectUsageDay) { await this.#call('usage-day-put', { document }); }
  async putSessionCache(snapshot: ProjectSessionCache) { await this.#call('session-cache-put', { snapshot }); }
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
  async deploys(projectId: string, after?: string) { return this.#page(await this.#call('deploys-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async deploy(id: string) { return this.#check((await this.#call('deploy-get', { id })).record, row => !row || row.document.id === id); }
  async putDeploy(document: ProjectDeploy, expectedRevision: number) { return this.#check((await this.#call('deploy-put', { document, expectedRevision })).record, row => row.document.id === document.id && row.document.projectId === document.projectId && row.revision === expectedRevision + 1); }
  async deployBaseline(projectId: string) { return this.#check((await this.#call('deploy-baseline-get', { projectId })).record, row => !row || row.document.projectId === projectId); }
  async putDeployBaseline(document: ProjectDeployBaseline, expectedRevision: number) { return this.#check((await this.#call('deploy-baseline-put', { document, expectedRevision })).record, row => row.document.projectId === document.projectId && row.revision === expectedRevision + 1); }
  async updateDeployDecision(document: ProjectDecision, expectedRevision: number) { return this.#check((await this.#call('deploy-decision-update', { document, expectedRevision })).record, row => row.document.id === document.id && row.revision === expectedRevision + 1); }
  async jobs(projectId: string, after?: string) { return this.#page(await this.#call('jobs-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async job(jobId: string) { return this.#check((await this.#call('job-get', { jobId })).record, row => !row || row.document.id === jobId); }
  async putJob(job: ProjectJob, expectedRevision: number) { return this.#check((await this.#call('job-put', { job, expectedRevision })).record, row => row.document.id === job.id && row.document.projectId === job.projectId); }
  async dailies(projectId: string, after?: string) { return this.#page(await this.#call('dailies-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async daily(dailyId: string) { return this.#check((await this.#call('daily-get', { dailyId })).record, row => !row || row.document.id === dailyId); }
  async putDaily(daily: ProjectDaily, expectedRevision: number) { return this.#check((await this.#call('daily-put', { daily, expectedRevision })).record, row => row.document.id === daily.id && row.document.projectId === daily.projectId); }
  async jobRuns(projectId: string, after?: string) { return this.#page(await this.#call('job-runs-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async jobRun(jobRunId: string) { return this.#check((await this.#call('job-run-get', { jobRunId })).record, row => !row || row.document.id === jobRunId); }
  async putJobRun(jobRun: ProjectJobRun, expectedRevision: number) { return this.#check((await this.#call('job-run-put', { jobRun, expectedRevision })).record, row => row.document.id === jobRun.id && row.document.projectId === jobRun.projectId); }
  async windows(projectId: string, after?: string) { return this.#page(await this.#call('windows-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async window(windowId: string) { return this.#check((await this.#call('window-get', { windowId })).record, row => !row || row.document.id === windowId); }
  async putWindow(window: ProjectWindow, expectedRevision: number) { return this.#check((await this.#call('window-put', { window, expectedRevision })).record, row => row.document.id === window.id && row.document.projectId === window.projectId); }
  async goals(projectId: string, after?: string) { return this.#page(await this.#call('goals-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async goal(goalId: string) { return this.#check((await this.#call('goal-get', { goalId })).record, row => !row || row.document.id === goalId); }
  async putGoal(goal: ProjectGoal, expectedRevision: number) { return this.#check((await this.#call('goal-put', { goal, expectedRevision })).record, row => row.document.id === goal.id && row.document.projectId === goal.projectId); }
  async refill(projectId: string) { return this.#check((await this.#call('refill-get', { projectId })).record, row => !row || row.document.projectId === projectId); }
  async putRefill(refill: ProjectRefillState, expectedRevision: number) { return this.#check((await this.#call('refill-put', { refill, expectedRevision })).record, row => row.document.projectId === refill.projectId); }
  async tasks(projectId: string, after?: string) { return this.#page(await this.#call('tasks-list', { projectId, ...(after ? { after } : {}) }), projectId, after); }
  async task(taskId: string) { return this.#check((await this.#call('task-get', { taskId })).record, row => !row || row.document.id === taskId); }
  async putTask(task: ProjectWorkTask, expectedRevision: number) { return this.#check((await this.#call('task-put', { task, expectedRevision })).record, row => row.document.id === task.id && row.document.projectId === task.projectId); }
  async taskHistory(taskId: string) { return this.#check((await this.#call('task-history', { taskId })).records, rows => rows.every((row, index) => row.taskId === taskId && (index === 0 || row.sequence > rows[index - 1]!.sequence))); }
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
  async mergeDocuments(projectId: string, after?: string, threadId?: string) { const page = this.#page(await this.#call('merge-documents', { projectId, ...(after ? { after } : {}), ...(threadId ? { threadId } : {}) }), projectId, after); if (threadId && page.records.some(row => row.threadId !== threadId)) throw new HubProtocolError(); return page; }
  async mergeDocument(id: string) { return this.#check((await this.#call('merge-document-get', { id })).record, row => !row || row.document.id === id); }
  async putMergeDocument(document: MergeDocument, expectedRevision: number) { return this.#check((await this.#call('merge-document-put', { document, expectedRevision })).record, row => row.document.id === document.id && (row.revision === expectedRevision + 1 || (document.schema === 'merge-correction-v1' || document.schema === 'landing-correction-v1') && stableJson({ ...row.document, revision: 0, at: '', receivedOrder: 0 }) === stableJson({ ...document, revision: 0, at: '', receivedOrder: 0 }))); }
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
  async recentOverrides(projectId: string, limit: number, filter?: PlacementOverrideFilter) {
    return this.#check((await this.#call('overrides-recent', { projectId, limit, ...(filter ? { filter } : {}) })).records, (records) => records.length <= limit
      && records.every((record, index) => record.projectId === projectId && (!filter || ((record.taskType ?? 'feature') === filter.type) === (filter.match === 'same')) && (index === 0 || Date.parse(records[index - 1]!.at) >= Date.parse(record.at))));
  }
  async putEnvelope(envelope: ProjectEnvelope) {
    const result = this.#check(await this.#call('envelope-put', { envelope }), (value) => value.id === envelope.id);
    return { stored: result.stored };
  }
  /** Every record is for the requested target, unique and in relay order; a page announcing more is never empty. */
  async pendingEnvelopes(targetDeviceId: string) {
    // Read record by record (P8 review S-2): an unreadable record is reported, never a reason to drop the whole page.
    const result = this.#check(await this.client.pendingEnvelopes(targetDeviceId), (value) => (!value.more || value.records.length + value.unreadable.length > 0)
      && new Set(value.records.map((record) => record.id)).size === value.records.length
      && value.records.every((record, index) => record.targetDeviceId === targetDeviceId && (index === 0 || compareEnvelopes(value.records[index - 1]!, record) <= 0)));
    return { records: result.records, more: result.more, unreadable: result.unreadable };
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
