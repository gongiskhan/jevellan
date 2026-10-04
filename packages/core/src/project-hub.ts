import type { DecisionAnswer, ProjectCoordinator, ProjectCoordinatorStatus, ProjectDecision, ProjectNotebook, ProjectWorkSettings, ThreadIndex } from './project-schemas.js';
import type { Stored } from './store.js';

/**
 * Project hub state (design 2.1.5). The hub implements it over its database bound to the authenticated device; members
 * use the hub HTTP API. Writes are compare-and-swap on the row revision, and the embedded revision equals it (D3).
 * Later phases add overrides (4), envelopes (5), mail, reservations and held checkouts (6).
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
}
