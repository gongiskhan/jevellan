import type { DecisionAnswer, PlacementOverride, ProjectCoordinator, ProjectCoordinatorStatus, ProjectDecision, ProjectEnvelope, ProjectNotebook, ProjectWorkSettings, ThreadIndex } from './project-schemas.js';
import type { ProjectWorkSummary } from './project-hub-schemas.js';
import type { Stored } from './store.js';

/**
 * Project hub state (design 2.1.5). The hub implements it over its database bound to the authenticated device; members
 * use the hub HTTP API. Writes are compare-and-swap on the row revision, and the embedded revision equals it (D3).
 * Phase 6 adds mail, reservations and held checkouts.
 */
export interface ProjectHub {
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
  recentOverrides(projectId: string, limit: number): Promise<PlacementOverride[]>;
  // relay envelopes (phase 5, D40): only the source device puts, only the target reads and acknowledges
  /** Revision 0 creates; an identical retry answers `stored: false`, the same id with other content is refused (409). */
  putEnvelope(envelope: ProjectEnvelope): Promise<{ stored: boolean }>;
  /** The caller's pending envelopes in relay order (`compareEnvelopes`), at most 100 and about 1 MiB a page (D260); `more` when others wait. */
  pendingEnvelopes(targetDeviceId: string): Promise<{ records: ProjectEnvelope[]; more: boolean }>;
  /** Deletes a delivered envelope (D90); an unknown id is already acknowledged. */
  ackEnvelope(id: string): Promise<void>;
  // the Projects list (phase 5, D267): one read for every project, so a member's list costs one hub request per poll
  /** Every project's counts and coordinator, in project id order. */
  workSummaries(): Promise<ProjectWorkSummary[]>;
}
