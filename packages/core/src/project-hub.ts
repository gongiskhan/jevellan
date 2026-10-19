import type { ProjectDeploy, ProjectDeployBaseline } from './project-deploy-schemas.js';
import type { ProjectSetupProposal, SetupActionRequest } from './project-setup-schemas.js';
import type { MergeDocument } from './merge-schemas.js';
import type { ProjectJob, ProjectDaily, ProjectJobRun, ProjectWindow } from './project-daily-schemas.js';
import type {
  DecisionAnswer, FileReservation, PlacementOverride, ProjectCoordinator, ProjectCoordinatorStatus, ProjectDecision, ProjectEnvelope, ProjectMail, ProjectNotebook, ProjectWorkSettings, ThreadIndex,
} from './project-schemas.js';
import type { HeldCheckout, ProjectWorkSummary, ReservationConflict, ReservationRequest } from './project-hub-schemas.js';
import type { Stored } from './store.js';
import type { ProjectWorkTask, TaskHistoryEvent } from './project-loop-schemas.js';
import type { ProjectSessionCache } from './session-cache-schemas.js';
import type { ProjectNotification } from './notification-schemas.js';
import type { ProjectUsageDay } from './project-usage-schemas.js';

import type { ProjectGoal, ProjectRefillState } from './project-goal-schemas.js';

/**
 * A pending envelope this device could not read (P8 review S-2: another Jevellan version, for example): what its record still names,
 * each field null when even that is unreadable. The inbox acknowledges it when its id is readable and says what was lost.
 */
export type UnreadableEnvelope = { id: string | null; projectId: string | null; sourceDeviceId: string | null; kind: string | null };
/** A reservation is granted, or refused with the overlapping reservations of other threads (brief 7.2); reservations are advisory. */
export type ReserveOutcome = { granted: true; reservation: Stored<FileReservation> } | { granted: false; conflicts: ReservationConflict[] };

/**
 * Project hub state (design 2.1.5). The hub implements it over its database bound to the authenticated device; members
 * use the hub HTTP API. Writes are compare-and-swap on the row revision, and the embedded revision equals it (D3).
 * Phase 6 adds mail, reservations and held checkouts.
 */
export interface ProjectHub {
  deploys(projectId: string, after?: string): Promise<{ records: ProjectDeploy[]; next: string | null }>;
  deploy(id: string): Promise<Stored<ProjectDeploy> | null>;
  putDeploy(document: ProjectDeploy, expectedRevision: number): Promise<Stored<ProjectDeploy>>;
  deployBaseline(projectId: string): Promise<Stored<ProjectDeployBaseline> | null>;
  putDeployBaseline(document: ProjectDeployBaseline, expectedRevision: number): Promise<Stored<ProjectDeployBaseline>>;
  updateDeployDecision(document: ProjectDecision, expectedRevision: number): Promise<Stored<ProjectDecision>>;
  setupProposal(id: string): Promise<Stored<ProjectSetupProposal> | null>;
  putSetupProposal(document: ProjectSetupProposal): Promise<Stored<ProjectSetupProposal>>;
  setupAction(projectId: string, id: string, input: SetupActionRequest): Promise<Stored<ProjectSetupProposal>>;
  putNotification?(document: ProjectNotification): Promise<void>;
  usageDays?(projectId: string): Promise<ProjectUsageDay[]>;
  putUsageDay?(document: ProjectUsageDay): Promise<void>;
  sessionCaches?(projectId: string): Promise<ProjectSessionCache[]>;
  putSessionCache?(snapshot: ProjectSessionCache): Promise<void>;
  mergeDocuments(projectId: string, after?: string, threadId?: string): Promise<{ records: MergeDocument[]; next: string | null }>;
  mergeDocument(id: string): Promise<Stored<MergeDocument> | null>;
  putMergeDocument(document: MergeDocument, expectedRevision: number): Promise<Stored<MergeDocument>>;
  jobs(projectId: string, after?: string): Promise<{ records: ProjectJob[]; next: string | null }>;
  job(jobId: string): Promise<Stored<ProjectJob> | null>;
  putJob(job: ProjectJob, expectedRevision: number): Promise<Stored<ProjectJob>>;
  dailies(projectId: string, after?: string): Promise<{ records: ProjectDaily[]; next: string | null }>;
  daily(dailyId: string): Promise<Stored<ProjectDaily> | null>;
  putDaily(daily: ProjectDaily, expectedRevision: number): Promise<Stored<ProjectDaily>>;
  jobRuns(projectId: string, after?: string): Promise<{ records: ProjectJobRun[]; next: string | null }>;
  jobRun(jobRunId: string): Promise<Stored<ProjectJobRun> | null>;
  putJobRun(jobRun: ProjectJobRun, expectedRevision: number): Promise<Stored<ProjectJobRun>>;
  windows(projectId: string, after?: string): Promise<{ records: ProjectWindow[]; next: string | null }>;
  window(windowId: string): Promise<Stored<ProjectWindow> | null>;
  putWindow(window: ProjectWindow, expectedRevision: number): Promise<Stored<ProjectWindow>>;
  goals(projectId: string, after?: string): Promise<{ records: ProjectGoal[]; next: string | null }>;
  goal(goalId: string): Promise<Stored<ProjectGoal> | null>;
  putGoal(goal: ProjectGoal, expectedRevision: number): Promise<Stored<ProjectGoal>>;
  refill(projectId: string): Promise<Stored<ProjectRefillState> | null>;
  putRefill(refill: ProjectRefillState, expectedRevision: number): Promise<Stored<ProjectRefillState>>;
  tasks(projectId: string, after?: string): Promise<{ records: ProjectWorkTask[]; next: string | null }>;
  task(taskId: string): Promise<Stored<ProjectWorkTask> | null>;
  putTask(task: ProjectWorkTask, expectedRevision: number): Promise<Stored<ProjectWorkTask>>;
  taskHistory(taskId: string): Promise<TaskHistoryEvent[]>;
  // settings: any device; idempotent by clientRequestId
  settings(projectId: string): Promise<Stored<ProjectWorkSettings> | null>;
  putSettings(settings: ProjectWorkSettings, expectedRevision: number, clientRequestId?: string): Promise<Stored<ProjectWorkSettings>>;
  // coordinators: assignment is a compare-and-swap (0 creates); status is written only by the assigned device
  coordinator(projectId: string): Promise<Stored<ProjectCoordinator> | null>;
  assignCoordinator(projectId: string, deviceId: string, expectedRevision: number): Promise<Stored<ProjectCoordinator>>;
  coordinatorStatus(projectId: string): Promise<Stored<ProjectCoordinatorStatus> | null>;
  putCoordinatorStatus(status: ProjectCoordinatorStatus): Promise<void>;
  // threads: pages of 100 ordered by id; only the owner device publishes, ordered by its thread ledger event id (D10)
  threads(projectId: string, after?: string): Promise<{ records: ThreadIndex[]; next: string | null }>;
  thread(threadId: string): Promise<Stored<ThreadIndex> | null>;
  publishThread(index: ThreadIndex, eventId: number): Promise<{ eventId: number }>;
  // decisions: open plus answered in the last 14 days, ordered by id
  decisions(projectId: string): Promise<ProjectDecision[]>;
  decision(id: string): Promise<Stored<ProjectDecision> | null>;
  createDecision(decision: ProjectDecision): Promise<Stored<ProjectDecision>>;
  withdrawDecision(id: string, at: string): Promise<Stored<ProjectDecision>>;
  answerDecision(id: string, answer: DecisionAnswer, at: string, clientRequestId: string): Promise<{ decision: Stored<ProjectDecision>; repeated: boolean }>;
  // notebooks
  notebook(projectId: string): Promise<Stored<ProjectNotebook> | null>;
  putNotebook(notebook: ProjectNotebook, expectedRevision: number): Promise<Stored<ProjectNotebook>>;
  // placement overrides (phase 4): append-only, idempotent by id; recorded by the thread's owner device
  addOverride(override: PlacementOverride): Promise<void>;
  /** The newest `limit` overrides of the project, newest first. */
  recentOverrides(projectId: string, limit: number, filter?: PlacementOverrideFilter): Promise<PlacementOverride[]>;
  // relay envelopes (phase 5, D40): only the source device puts, only the target reads and acknowledges
  /** Revision 0 creates; an identical retry answers `stored: false`, the same id with other content is refused (409). */
  putEnvelope(envelope: ProjectEnvelope): Promise<{ stored: boolean }>;
  /**
   * The caller's pending envelopes in relay order (`compareEnvelopes`), at most 100 and about 1 MiB a page (D260); `more` when others wait.
   * A member reads the page record by record: records it cannot read come back as `unreadable` instead of failing the page (P8 review S-2).
   */
  pendingEnvelopes(targetDeviceId: string): Promise<{ records: ProjectEnvelope[]; more: boolean; unreadable?: UnreadableEnvelope[] }>;
  /** Deletes a delivered envelope (D90); an unknown id is already acknowledged. */
  ackEnvelope(id: string): Promise<void>;
  // the Projects list (phase 5, D267): one read for every project, so a member's list costs one hub request per poll
  /** Every project's counts and coordinator, in project id order. */
  workSummaries(): Promise<ProjectWorkSummary[]>;
  // mail and reservations between main threads (phase 6, brief 5.11; D285): the sender's or the thread's owner device writes
  /** Revision 0 creates and the hub stamps the time; an identical retry returns the stored mail, the same id with other content is refused (409). */
  sendMail(mail: ProjectMail): Promise<Stored<ProjectMail>>;
  /** One page of the thread's unread mail, oldest first, at most 100 and about 1 MiB (`more` when other mail waits). Reading marks nothing. */
  inbox(projectId: string, threadId: string): Promise<{ records: ProjectMail[]; more: boolean }>;
  /** Marks the thread's received mail read; mail already read or gone is skipped. Returns how many were marked. */
  markRead(projectId: string, threadId: string, ids: string[]): Promise<number>;
  /** Checks the overlap rule against other threads' active reservations and stores the reservation in one transaction (hub clock). */
  reserve(request: ReservationRequest): Promise<ReserveOutcome>;
  /** Releases one reservation of the thread by id, or every active one without; returns how many were active. */
  release(projectId: string, threadId: string, id?: string): Promise<number>;
  /** The project's active reservations (every page). */
  reservations(projectId: string): Promise<FileReservation[]>;
  // main isolation (phase 6, D288): any device reads it for placement
  /** Per device, the claim or main thread that keeps new main threads off its project checkout, in device id order. */
  heldCheckouts(projectId: string): Promise<HeldCheckout[]>;
}
import type { PlacementOverrideFilter } from './task-types.js';
