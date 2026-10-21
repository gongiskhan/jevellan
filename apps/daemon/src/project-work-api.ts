import { ProjectMergeWhyRequestSchema, ProjectRouteWhyViewSchema } from '@jevellan/core';
import { ProjectCoordinatorEditorPreviewSchema, ProjectCoordinatorEditorSaveSchema, ProjectWorkSettingsViewSchema } from '@jevellan/core';
import { ProjectSettingsChangeViewRequestSchema } from '@jevellan/core';
import { ProjectLandingEditorRequestSchema, ProjectLandingEditorSaveSchema } from '@jevellan/core';
import { ProjectSettingsEditorSchema } from '@jevellan/core';
import { ProjectThreadOverrideEditorSchema, ThreadOverrideEditorPreviewSchema, ThreadOverrideEditorSaveSchema } from '@jevellan/core';
import { ProjectPageRequestSchema, ProjectWaitingRespondRequestSchema } from '@jevellan/core';
import { DailyEnabledRequestSchema, JobPausedRequestSchema } from '@jevellan/core';
import { ProjectJobSchema, ProjectDailySchema, RoutineEditorSaveRequestSchema } from '@jevellan/core';
import { ProjectRoutineSettingsSaveSchema, ProjectRoutineSettingsViewSchema } from '@jevellan/core';
import { goalEditorRequest } from '@jevellan/projects';
import { projectEventNotices } from '@jevellan/projects';
import { CoordinatorActivityProjector } from '@jevellan/projects';
import { DeployBaselineRequestSchema, DeployRollbackRequestSchema, ProjectDeploySchema, ProjectPageQuerySchema } from '@jevellan/core';
import { ProjectHealthRequestSchema } from '@jevellan/core';
import { SetupActionRequestSchema } from '@jevellan/core';
import { parseReply, EkoaCodeSetupRequestSchema, JobCreateRequestSchema, JobUpdateRequestSchema, DailyCreateRequestSchema, DailyUpdateRequestSchema, ProjectRunRequestSchema } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CoordinatorMessageReceiptSchema, CoordinatorMessageRequestSchema, DecisionAnswerRequestSchema, DecisionAnsweredViewSchema, DeviceOriginSchema, EmptySchema, ErrorDocumentSchema, IdSchema,
  MergeResultViewSchema, LandingCorrectionInputSchema, MergeCorrectionInputSchema, NotebookRequestSchema, PeerLoginSessionInputSchema, ProjectEventFrameSchema, ProjectWorkSettingsRequestSchema, ThreadCreateRequestSchema, ThreadCreatedViewSchema,
  ThreadActionRequestSchema, ThreadMessageReceiptSchema, ThreadMessageRequestSchema, ThreadOverrideRequestSchema, ThreadStopRequestSchema, UiSessionTokenSchema, boundedRedaction, type ProjectLedgerEvent,
  GoalCreateRequestSchema, GoalUpdateRequestSchema, GoalViewSchema, TaskCreateRequestSchema, TaskUpdateRequestSchema, TaskActionRequestSchema,
} from '@jevellan/core';
import {
  COORDINATOR_DEVICE_REDIRECT, COORDINATOR_NOT_HERE, EVENT_CURSOR_AHEAD, EVENT_CURSOR_INVALID, PROJECT_OPERATION_NOT_FOUND, THREAD_DEVICE_GONE, THREAD_NOT_FOUND, coordinatorOfflineNotice,
  coordinatorUnreachable, publicProjectData, threadDeviceOffline, threadDeviceUnreachable, THREAD_DEVICE_REDIRECT, type ProjectLedger, type RemoteStart,
} from '@jevellan/projects';
import type { Application } from './application.js';
import { streamLedger, type LedgerStreamFrame } from './conversation-events.js';
import { json, requestBody } from './http.js';
import { OWNER_REQUEST_TIMEOUT_MS, forwardOwner } from './owner-proxy.js';
import { readProjectImage } from '@jevellan/conversations';
import { UiAuth } from '@jevellan/mesh';
import { ThreadOverrideViewSchema, ProjectThreadWhyViewSchema, ProjectThreadActionsViewSchema, ThreadViewSchema } from '@jevellan/core';

export type ProjectWorkRouteName = 'settings-editor' | 'settings-editor-save' | 'landing-editor' | 'landing-editor-save' | 'settings-change-view' | 'coordinator-editor' | 'coordinator-editor-preview' | 'coordinator-editor-save' | 'landing-why' | 'merge-why' | 'landing-why-correction' | 'merge-why-correction' | 'thread-override-editor' | 'thread-override-preview' | 'thread-override-save' | 'thread-why-view' | 'goal-views' | 'goal-editor' | 'goal-editor-save' | 'routine-settings-view' | 'routine-settings-save' | 'deploy-summary' | 'job-editor' | 'job-editor-save' | 'daily-editor' | 'daily-editor-save' | 'jobs-view' | 'daily-enabled' | 'job-paused' | 'waiting-list' | 'waiting-answer' | 'thread-actions-view' | 'sidebar-view' | 'page-view' | 'health-list' | 'health-run' | 'deploy-list' | 'deploy-baseline' | 'deploy-rollback' | 'setup-request' | 'setup-get' | 'setup-action' | 'usage' | 'session-history' | 'ekoa-code-setup' | 'list' | 'view' | 'events' | 'message' | 'stop' | 'handoff' | 'fresh' | 'move' | 'settings' | 'settings-undo' | 'notebook' | 'thread-create' | 'thread' | 'thread-message'
  | 'thread-action' | 'thread-image' | 'thread-events' | 'thread-stop' | 'thread-discard' | 'thread-allow' | 'thread-override' | 'landing-route' | 'landing-correction' | 'pr-merge' | 'pr-refresh' | 'pr-route' | 'pr-correction' | 'answer' | 'goal-list' | 'goal-create' | 'goal-update' | 'job-list' | 'job-create' | 'job-update' | 'job-run' | 'job-runs' | 'daily-list' | 'daily-create' | 'daily-update' | 'daily-run' | 'task-list' | 'task-create' | 'task' | 'task-update' | 'task-action';
/** Where a route runs: this device (`local`), the project's coordinator device, the thread's owner device, or any device. */
export type ProjectWorkRoute = { name: ProjectWorkRouteName; projectId?: string; threadId?: string; decisionId?: string; taskId?: string; goalId?: string; jobId?: string; dailyId?: string; proposalId?: string;
  target: 'local' | 'coordinator' | 'owner' | 'any'; stream?: boolean };
type IdName = 'proposalId' | 'projectId' | 'threadId' | 'decisionId' | 'taskId' | 'goalId' | 'jobId' | 'dailyId';
/** `ids` names the captured ids in order (default project then thread); `stream` marks the event stream. */
type Row = { name: ProjectWorkRouteName; pattern: RegExp; methods: readonly ('GET' | 'POST' | 'PUT')[]; target: ProjectWorkRoute['target']; ids?: readonly IdName[]; stream?: true };

// The closed route table (brief 11, design 2.10). Paths are matched whole; ids are validated after a match.
const rows: readonly Row[] = [
  { name: 'landing-why', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/landing\/why-view$/, methods: ['GET'], target: 'owner' },
  { name: 'merge-why', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/why-view$/, methods: ['POST'], target: 'owner' },
  { name: 'landing-why-correction', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/landing\/why-correction$/, methods: ['POST'], target: 'owner' },
  { name: 'merge-why-correction', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/why-correction$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-override-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/override-editor$/, methods: ['GET'], target: 'owner' },
  { name: 'coordinator-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/editor$/, methods: ['GET'], target: 'any' },
  { name: 'coordinator-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/editor$/, methods: ['POST'], target: 'coordinator' },
  { name: 'coordinator-editor-preview', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/editor\/preview$/, methods: ['POST'], target: 'any' },
  { name: 'thread-override-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/override-editor$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-override-preview', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/override-editor\/preview$/, methods: ['POST'], target: 'owner' },
  { name: 'goal-views', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goal-views$/, methods: ['GET'], target: 'any' },
  { name: 'goal-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/editor$/, methods: ['GET'], target: 'any' },
  { name: 'goal-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/editor$/, methods: ['POST'], target: 'coordinator' },
  { name: 'goal-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/([A-Za-z0-9_-]+)\/editor$/, methods: ['GET'], target: 'any', ids: ['projectId', 'goalId'] },
  { name: 'goal-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/([A-Za-z0-9_-]+)\/editor$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'goalId'] },
  { name: 'job-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/editor$/, methods: ['GET'], target: 'any' },
  { name: 'job-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/editor$/, methods: ['POST'], target: 'coordinator' },
  { name: 'job-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/editor$/, methods: ['GET'], target: 'any', ids: ['projectId', 'jobId'] },
  { name: 'job-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/editor$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'jobId'] },
  { name: 'daily-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/editor$/, methods: ['GET'], target: 'any' },
  { name: 'daily-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/editor$/, methods: ['POST'], target: 'coordinator' },
  { name: 'daily-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/editor$/, methods: ['GET'], target: 'any', ids: ['projectId', 'dailyId'] },
  { name: 'daily-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/editor$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'dailyId'] },
  { name: 'jobs-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs-view$/, methods: ['GET'], target: 'any' },
  { name: 'daily-enabled', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/enabled$/, methods: ['POST'], target: 'any', ids: ['projectId', 'dailyId'] },
  { name: 'job-paused', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/paused$/, methods: ['POST'], target: 'any', ids: ['projectId', 'jobId'] },
  { name: 'waiting-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/waiting-items$/, methods: ['GET'], target: 'any' },
  { name: 'waiting-answer', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/waiting-items\/([A-Za-z0-9_-]+)\/respond$/, methods: ['POST'], target: 'any', ids: ['projectId', 'decisionId'] },
  { name: 'thread-why-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/why-view$/, methods: ['GET'], target: 'owner' },
  { name: 'thread-actions-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/actions-view$/, methods: ['GET'], target: 'owner' },
  { name: 'sidebar-view', pattern: /^\/api\/project-work\/sidebar$/, methods: ['GET'], target: 'any' },
  { name: 'page-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/status-view$/, methods: ['GET', 'POST'], target: 'any' },
  { name: 'setup-request', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/setup-request$/, methods: ['POST'], target: 'coordinator' },
  { name: 'setup-get', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/setup-proposals\/([A-Za-z0-9_-]+)$/, methods: ['GET'], target: 'any', ids: ['projectId', 'proposalId'] },
  { name: 'setup-action', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/setup-proposals\/([A-Za-z0-9_-]+)\/actions$/, methods: ['POST'], target: 'any', ids: ['projectId', 'proposalId'] },
  { name: 'usage', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/usage$/, methods: ['GET'], target: 'any' },
  { name: 'settings-undo', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work-settings\/undo$/, methods: ['POST'], target: 'any' },
  { name: 'settings-change-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/config\/change-view$/, methods: ['POST'], target: 'any' },
  { name: 'landing-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/config\/landing-editor$/, methods: ['POST'], target: 'any' },
  { name: 'landing-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/config\/landing-save$/, methods: ['POST'], target: 'any' },
  { name: 'settings-editor', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/config\/editor$/, methods: ['GET'], target: 'any' },
  { name: 'settings-editor-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/config\/editor$/, methods: ['POST'], target: 'any' },
  { name: 'session-history', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/session-transcript$/, methods: ['GET'], target: 'coordinator' },
  { name: 'ekoa-code-setup', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/ekoa-code-setup$/, methods: ['POST'], target: 'coordinator' },
  { name: 'job-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs$/, methods: ['GET'], target: 'any' },
  { name: 'job-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs$/, methods: ['POST'], target: 'coordinator' },
  { name: 'job-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'any', ids: ['projectId', 'jobId'] },
  { name: 'job-run', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/run$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'jobId'] },
  { name: 'deploy-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/deploys$/, methods: ['GET'], target: 'any' },
  { name: 'deploy-summary', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/deploy-summary$/, methods: ['GET'], target: 'any' },
  { name: 'routine-settings-view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/routine-settings$/, methods: ['GET'], target: 'any' },
  { name: 'routine-settings-save', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/routine-settings$/, methods: ['POST'], target: 'any' },
  { name: 'deploy-baseline', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/deploys\/baseline$/, methods: ['PUT'], target: 'coordinator' },
  { name: 'deploy-rollback', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/deploys\/([A-Za-z0-9_-]+)\/rollback$/, methods: ['POST'], target: 'coordinator' },
  { name: 'health-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/health$/, methods: ['GET'], target: 'any' },
  { name: 'health-run', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/health\/run$/, methods: ['POST'], target: 'any' },
  { name: 'daily-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies$/, methods: ['GET'], target: 'any' },
  { name: 'daily-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies$/, methods: ['POST'], target: 'coordinator' },
  { name: 'daily-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'any', ids: ['projectId', 'dailyId'] },
  { name: 'daily-run', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/run$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'dailyId'] },
  { name: 'job-runs', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/job-runs$/, methods: ['GET'], target: 'any' },
  { name: 'goal-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals$/, methods: ['GET'], target: 'any' },
  { name: 'goal-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals$/, methods: ['POST'], target: 'coordinator' },
  { name: 'goal-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'goalId'] },
  { name: 'task-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks$/, methods: ['GET'], target: 'any' },
  { name: 'task-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks$/, methods: ['POST'], target: 'coordinator' },
  { name: 'task', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/, methods: ['GET'], target: 'any', ids: ['projectId', 'taskId'] },
  { name: 'task-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'taskId'] },
  { name: 'task-action', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)\/action$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'taskId'] },
  { name: 'list', pattern: /^\/api\/project-work$/, methods: ['GET'], target: 'any' },
  { name: 'view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work$/, methods: ['GET'], target: 'any' },
  { name: 'events', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/events$/, methods: ['GET'], target: 'coordinator', stream: true },
  { name: 'message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/messages$/, methods: ['POST'], target: 'coordinator' },
  { name: 'stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/stop$/, methods: ['POST'], target: 'coordinator' },
  { name: 'handoff', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/handoff$/, methods: ['POST'], target: 'coordinator' },
  { name: 'fresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/fresh$/, methods: ['POST'], target: 'coordinator' },
  // Move coordinator here runs on the device the owner uses, never proxied (3.5.3).
  { name: 'move', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/move$/, methods: ['POST'], target: 'local' },
  { name: 'settings', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/(?:work-settings|config)$/, methods: ['GET', 'PUT'], target: 'any' },
  { name: 'notebook', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/notebook$/, methods: ['GET', 'PUT'], target: 'any' },
  { name: 'thread-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads$/, methods: ['POST'], target: 'coordinator' },
  { name: 'thread', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)$/, methods: ['GET'], target: 'owner' },
  { name: 'thread-image', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/image$/, methods: ['GET'], target: 'owner' },
  { name: 'thread-events', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/events$/, methods: ['GET'], target: 'owner', stream: true },
  { name: 'thread-action', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/actions$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/messages$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/stop$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-discard', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/discard$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-allow', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/allow-turns$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-override', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/override$/, methods: ['POST'], target: 'owner' },
  { name: 'pr-merge', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/merge$/, methods: ['POST'], target: 'owner' },
  { name: 'landing-route', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/landing\/route$/, methods: ['GET'], target: 'any' },
  { name: 'landing-correction', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/landing\/correction$/, methods: ['POST'], target: 'any' },
  { name: 'pr-route', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/route$/, methods: ['GET'], target: 'any' },
  { name: 'pr-correction', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/correction$/, methods: ['POST'], target: 'any' },
  { name: 'pr-refresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/refresh$/, methods: ['POST'], target: 'owner' },
  { name: 'answer', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/decisions\/([A-Za-z0-9_-]+)\/answer$/, methods: ['POST'], target: 'any', ids: ['projectId', 'decisionId'] },
];
/**
 * Requests carrying a client id repeat safely, so a hub outage during them is reported as retryable (settings only when the body has
 * one); so does Move coordinator here, whose repeat completes the first one (D269).
 */
const withClientId = new Set<ProjectWorkRouteName>(['settings-editor-save', 'setup-request', 'setup-action', 'thread-action', 'message', 'move', 'thread-create', 'thread-message', 'thread-override', 'answer', 'landing-correction', 'pr-correction', 'task-create', 'goal-create', 'job-create', 'daily-create', 'job-run', 'daily-run']);
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const API_PREFIX = '/api/projects/';
/** UI-proxied requests from another device (phase 5, D41, D266): the owner and coordinator routes of the table. */
const PEER_PREFIX = '/api/mesh/projects/';
/** Who asks: a browser here, or another device forwarding a signed-in owner's request (its session token and device). */
type Caller = { token: string; sourceDeviceId: string; peer: boolean; authenticated(): Promise<boolean> };

/**
 * The Projects route for a path: null for any path this table does not own (other `/api/projects/:id/...` routes such as
 * visibility, context and memory stay with `api.ts`), 405 for a known path with another method.
 */
export function projectWorkRoute(path: string, method: string): ProjectWorkRoute | null {
  for (const row of rows) {
    const match = path.match(row.pattern); if (!match) continue;
    if (!(row.methods as readonly string[]).includes(method)) { if (rows.some(other => other.pattern.source === row.pattern.source && (other.methods as readonly string[]).includes(method))) continue; throw failure('This operation does not support that method.', 405); }
    const ids = (row.ids ?? ['projectId', 'threadId']).flatMap((name, index) => match[index + 1] === undefined ? [] : [[name, IdSchema.parse(match[index + 1])] as const]);
    return { name: row.name, target: row.target, ...(row.stream ? { stream: true } : {}), ...Object.fromEntries(ids) };
  }
  return null;
}

/** The coordinator chat frame (brief 5.13, 11): `event: project`, blob payloads resolved, redacted again, native identities left out. */
function projectFrame(ledger: ProjectLedger, coordinator = false): LedgerStreamFrame<ProjectLedgerEvent> {
  const activity = coordinator ? new CoordinatorActivityProjector(ledger.events(), event => ledger.data(event)) : undefined;
  return { name: 'project', invalidCursor: EVENT_CURSOR_INVALID, aheadCursor: EVENT_CURSOR_AHEAD,
    payload: (event) => ProjectEventFrameSchema.parse(ledger.redact({ schema: 'project-event-v1', event: { ...event, data: publicProjectData(ledger.data(event)) }, ...(activity ? { coordinatorActivity: activity.observe(event), notices: projectEventNotices({ ...event, data: publicProjectData(ledger.data(event)) }) } : {}) })) };
}

/**
 * The peer path of a local route. Thread creation travels as `coordinator/threads` (it runs placement on the coordinator device),
 * so the brief's `POST /api/mesh/projects/:id/threads`, a background start, stays absent (D40, D266).
 */
function peerPath(route: ProjectWorkRoute, path: string): string {
  return route.name === 'thread-create' ? `${PEER_PREFIX}${route.projectId!}/coordinator/threads` : `${PEER_PREFIX}${path.slice(API_PREFIX.length)}`;
}
/** The local path of a peer path; null for the brief's absent background start. */
function localPath(path: string): string | null {
  const suffix = path.slice(PEER_PREFIX.length);
  const create = suffix.match(/^([A-Za-z0-9_-]+)\/coordinator\/threads$/); if (create) return `${API_PREFIX}${create[1]!}/threads`;
  return /^[A-Za-z0-9_-]+\/threads$/.test(suffix) ? null : `${API_PREFIX}${suffix}`;
}
/** The roster row of a device a request goes to; a thread's owner or coordinator that left the mesh or is offline is refused here (D9a, D266). */
async function target(app: Application, deviceId: string, purpose: 'thread' | 'coordinator') {
  const row = (await app.roster()).devices.find((view) => view.device.id === deviceId);
  if (purpose === 'coordinator' && (!row || row.revoked || row.status === 'offline')) throw failure(coordinatorOfflineNotice(row?.device.name ?? deviceId), 409);
  if (!row || row.revoked) throw failure(THREAD_DEVICE_GONE, 409);
  if (row.status === 'offline') throw failure(threadDeviceOffline(row.device.name), 409);
  return row;
}

/** Authenticated owner tools reuse the browser's typed owner routes; work never moves to the state point. */
export async function ownerThreadOperation(app: Application, projectId: string, threadId: string,
  operation: 'landing-why' | 'merge-why' | 'landing-why-correction' | 'merge-why-correction' | 'override-editor' | 'override-preview' | 'override-save' | 'why' | 'actions' | 'act' | 'merge', input?: unknown) {
  const work = app.projectWork, read = ['landing-why', 'merge-why', 'override-editor', 'override-preview', 'why', 'actions'].includes(operation);
  const owner = await (read ? work.threadReadOwner(projectId, threadId) : work.threadOwner(projectId, threadId));
  if (owner === null) throw failure(THREAD_NOT_FOUND, 404);
  if (owner === app.device.deviceId) {
    switch (operation) {
      case 'landing-why': return work.landingWhy(projectId, threadId);
      case 'merge-why': return work.mergeWhy(projectId, threadId, ProjectMergeWhyRequestSchema.parse(input));
      case 'landing-why-correction': return work.landingWhyCorrection(projectId, threadId, LandingCorrectionInputSchema.parse(input));
      case 'merge-why-correction': return work.mergeWhyCorrection(projectId, threadId, MergeCorrectionInputSchema.parse(input));
      case 'override-editor': return work.views.overrideEditor(projectId, threadId);
      case 'override-preview': return work.views.overrideEditor(projectId, threadId, ThreadOverrideEditorPreviewSchema.parse(input));
      case 'override-save': {
        const request = await work.views.overrideEditorInput(projectId, threadId, ThreadOverrideEditorSaveSchema.parse(input));
        const auth = app.auth; if (!(auth instanceof UiAuth)) throw failure('Owner tools must run on the state point.', 409);
        const token = auth.issue(app.device.deviceId);
        try { return await work.overrideThread(projectId, threadId, request, remoteStart(app, { token, sourceDeviceId: app.device.deviceId, peer: false, authenticated: async () => auth.verify(token) !== null })); }
        finally { auth.logout(token); }
      }
      case 'why': return work.views.why(projectId, threadId);
      case 'actions': return work.views.actions(projectId, threadId);
      case 'act': return work.threadAction(projectId, threadId, ThreadActionRequestSchema.parse(input));
      case 'merge': return work.mergePullRequest(projectId, threadId);
    }
  }
  let suffix: string, method: 'GET' | 'POST' = 'POST', body: unknown;
  switch (operation) {
    case 'landing-why': suffix = 'landing/why-view'; method = 'GET'; break;
    case 'merge-why': suffix = 'pr/why-view'; body = ProjectMergeWhyRequestSchema.parse(input); break;
    case 'landing-why-correction': suffix = 'landing/why-correction'; body = LandingCorrectionInputSchema.parse(input); break;
    case 'merge-why-correction': suffix = 'pr/why-correction'; body = MergeCorrectionInputSchema.parse(input); break;
    case 'override-editor': suffix = 'override-editor'; method = 'GET'; break;
    case 'override-preview': suffix = 'override-editor/preview'; body = ThreadOverrideEditorPreviewSchema.parse(input); break;
    case 'override-save': suffix = 'override-editor'; body = ThreadOverrideEditorSaveSchema.parse(input); break;
    case 'why': suffix = 'why-view'; method = 'GET'; break;
    case 'actions': suffix = 'actions-view'; method = 'GET'; break;
    case 'act': suffix = 'actions'; body = ThreadActionRequestSchema.parse(input); break;
    case 'merge': suffix = 'pr/merge'; body = EmptySchema.parse({ schema: 'empty-request-v1' }); break;
  }
  const value = await ownerProjectJson(app, owner, 'thread', `${API_PREFIX}${projectId}/threads/${threadId}/${suffix}`, method, body);
  if (['landing-why', 'merge-why', 'landing-why-correction', 'merge-why-correction'].includes(operation)) {
    const view = parseReply(ProjectRouteWhyViewSchema, value), kind = operation.startsWith('landing-') ? 'landing' : 'merge';
    if (view.projectId !== projectId || view.threadId !== threadId || view.kind !== kind) throw failure('The returned explanation does not match the thread.', 502);
    const commit = operation === 'merge-why' ? ProjectMergeWhyRequestSchema.parse(input).commit : operation === 'merge-why-correction' ? MergeCorrectionInputSchema.parse(input).commit : undefined;
    if (commit && view.commit !== commit) throw failure('The returned explanation does not match the commit.', 502);
    return view;
  }
  if (operation === 'override-editor' || operation === 'override-preview') {
    const view = parseReply(ProjectThreadOverrideEditorSchema, value);
    if (view.projectId !== projectId || view.threadId !== threadId) throw failure('The returned editor does not match the thread.', 502); return view;
  }
  if (operation === 'override-save') return parseReply(ThreadOverrideViewSchema, value);
  if (operation === 'why') { const view = parseReply(ProjectThreadWhyViewSchema, value); if (view.projectId !== projectId || view.threadId !== threadId) throw failure('The returned explanation does not match the thread.', 502); return view; }
  if (operation === 'actions') return parseReply(ProjectThreadActionsViewSchema, value);
  if (operation === 'act') return parseReply(ThreadViewSchema, value);
  return parseReply(MergeResultViewSchema, value);
}
/** Only a registered resource-owner route can receive the in-memory authority of an authenticated owner call. */
async function ownerProjectJson(app: Application, owner: string, purpose: 'thread' | 'coordinator', path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const route = projectWorkRoute(path, method);
  if (!route || route.target !== (purpose === 'thread' ? 'owner' : 'coordinator')) throw failure(PROJECT_OPERATION_NOT_FOUND, 404);
  const row = await target(app, owner, purpose), auth = app.auth;
  if (!(auth instanceof UiAuth)) throw failure('Owner tools must run on the state point.', 409);
  const upstream = new URL(DeviceOriginSchema.parse(row.device.url));
  upstream.pathname = peerPath(route, path);
  // This authenticated owner call holds the same authority as the UI. The peer session stays in memory,
  // is never returned, and is revoked afterward; the receiver retains its owner/lifecycle/guard checks.
  const token = auth.issue(); app.redactor.add(token);
  try {
    let answer: Response;
    try {
      answer = await fetch(upstream, { method, redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw failure(purpose === 'thread' ? threadDeviceUnreachable(row.device.name) : coordinatorUnreachable(row.device.name), 502); }
    if (answer.status >= 300 && answer.status < 400) { await answer.body?.cancel(); throw failure(purpose === 'thread' ? THREAD_DEVICE_REDIRECT : COORDINATOR_DEVICE_REDIRECT, 502); }
    const value: unknown = await answer.json().catch(() => null);
    if (!answer.ok) {
      const refusal = ErrorDocumentSchema.safeParse(value);
      throw refusal.success ? failure(refusal.data.message, answer.status) : failure(purpose === 'thread' ? threadDeviceUnreachable(row.device.name) : coordinatorUnreachable(row.device.name), 502);
    }
    return value;
  } finally { auth.logout(token); }
}
export async function ownerRoutineSave(app: Application, projectId: string, itemId: string | undefined, raw: unknown) {
  const input = RoutineEditorSaveRequestSchema.parse(raw), work = app.projectWork;
  const kind = input.schema === 'job-editor-create-request-v1' || input.schema === 'job-editor-update-request-v1' ? 'job' : 'daily';
  const owner = await work.coordinatorDevice(projectId);
  if (owner === null || owner === app.device.deviceId) return work.saveRoutineEditor(projectId, itemId, input, kind);
  const collection = kind === 'job' ? 'jobs' : 'dailies';
  const value = await ownerProjectJson(app, owner, 'coordinator', `${API_PREFIX}${projectId}/${collection}/${itemId ? `${itemId}/` : ''}editor`, 'POST', input);
  const result = kind === 'job' ? parseReply(ProjectJobSchema, value) : parseReply(ProjectDailySchema, value);
  if (result.projectId !== projectId || itemId && result.id !== itemId) throw failure('The returned definition does not match the request.', 502);
  return result;
}
export async function ownerCoordinatorEditorSave(app: Application, projectId: string, raw: unknown) {
  const input = ProjectCoordinatorEditorSaveSchema.parse(raw);
  if (input.projectId !== projectId) throw failure('The coordinator choices belong to another project.', 400);
  const owner = await app.projectWork.coordinatorDevice(projectId);
  if (owner === null || owner === app.device.deviceId) return app.projectWork.saveCoordinatorEditor(projectId, input);
  const result = parseReply(ProjectWorkSettingsViewSchema, await ownerProjectJson(app, owner, 'coordinator', `${API_PREFIX}${projectId}/coordinator/editor`, 'POST', input));
  if (result.settings.projectId !== projectId) throw failure('The returned settings do not match the request.', 502);
  return result;
}
export async function ownerDeployRollback(app: Application, projectId: string, deployId: string, raw: unknown) {
  const input = DeployRollbackRequestSchema.parse(raw), owner = await app.projectWork.coordinatorDevice(projectId);
  if (owner === null || owner === app.device.deviceId) return app.projectWork.deploys.rollback(projectId, deployId, input.expectedRevision);
  const result = parseReply(ProjectDeploySchema, await ownerProjectJson(app, owner, 'coordinator', `${API_PREFIX}${projectId}/deploys/${deployId}/rollback`, 'POST', input));
  if (result.projectId !== projectId || result.id !== deployId) throw failure('The returned deploy does not match the request.', 502);
  return result;
}
export async function ownerGoalEditorSave(app: Application, projectId: string, goalId: string | undefined, raw: unknown) {
  return ownerGoalSave(app, projectId, goalId, goalEditorRequest(raw, goalId));
}
export async function ownerGoalSave(app: Application, projectId: string, goalId: string | undefined, raw: unknown) {
  const input = goalId ? GoalUpdateRequestSchema.parse(raw) : GoalCreateRequestSchema.parse(raw), owner = await app.projectWork.coordinatorDevice(projectId);
  if (owner === null || owner === app.device.deviceId) return goalId ? app.projectWork.updateGoal(projectId, goalId, input) : app.projectWork.createGoal(projectId, input);
  const path = `${API_PREFIX}${projectId}/goals${goalId ? `/${goalId}/edit` : ''}`;
  const result = parseReply(GoalViewSchema, await ownerProjectJson(app, owner, 'coordinator', path, 'POST', input));
  if (result.goal.projectId !== projectId || goalId && result.goal.id !== goalId) throw failure('The returned goal does not match the request.', 502);
  return result;
}
async function ownerRoutineSettings(app: Application, projectId: string, raw?: unknown) {
  const input = raw === undefined ? undefined : ProjectRoutineSettingsSaveSchema.parse(raw);
  const request = { schema: 'owner-tool-request-v1' as const, caller: 'ui', action: input ? 'routines_save' : 'routines', args: { project: projectId, ...(input ? { request: input } : {}) } };
  const result = app.member ? await app.member.ownerTool({ schema: 'owner-tool-forward-v1', name: 'config', request }) : await app.ownerTools.call('config', request);
  if (!result.ok) {
    const status = ({ settings_changed: 409, project_unknown: 404, invalid_arguments: 400, invalid_value: 400, hub_unavailable: 503 } as Record<string, number>)[result.error.code] ?? 500;
    throw failure(result.error.text, status);
  }
  return parseReply(ProjectRoutineSettingsViewSchema, result.data);
}
async function ownerSettingsEditor(app: Application, projectId: string) {
  const request = { schema: 'owner-tool-request-v1' as const, caller: 'ui', action: 'settings_editor', args: { project: projectId } };
  const result = app.member ? await app.member.ownerTool({ schema: 'owner-tool-forward-v1', name: 'config', request }) : await app.ownerTools.call('config', request);
  if (!result.ok) {
    const status = ({ project_unknown: 404, invalid_arguments: 400, hub_unavailable: 503 } as Record<string, number>)[result.error.code] ?? 500;
    throw failure(result.error.text, status);
  }
  return parseReply(ProjectSettingsEditorSchema, result.data);
}
/** Sends the request to the device that runs it (2.10): the thread's owner or the coordinator device, with the owner's session. */
async function proxy(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ProjectWorkRoute, deviceId: string, caller: Caller): Promise<void> {
  const purpose = route.target === 'owner' ? 'thread' : 'coordinator'; const row = await target(app, deviceId, purpose);
  const upstream = new URL(DeviceOriginSchema.parse(row.device.url)); upstream.pathname = peerPath(route, url.pathname); upstream.search = url.search;
  const body = request.method === 'POST' ? JSON.stringify(await requestBody(request)) : undefined;
  await forwardOwner(request, response, { url: upstream, ownerName: row.device.name, sourceDeviceId: caller.sourceDeviceId, token: caller.token, stream: route.stream === true, purpose,
    ...(body === undefined ? {} : { body }) });
}
/**
 * A restart's new thread on the coordinator device when that is another device (D266): the same proxied creation as New thread,
 * made by the thread's device with the owner's session and the device that session belongs to.
 */
function remoteStart(app: Application, caller: Caller): RemoteStart {
  return async (projectId, deviceId, input) => {
    const row = await target(app, deviceId, 'coordinator');
    const upstream = new URL(DeviceOriginSchema.parse(row.device.url)); upstream.pathname = `${PEER_PREFIX}${projectId}/coordinator/threads`;
    let answer: Response;
    try {
      answer = await fetch(upstream, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), body: JSON.stringify(ThreadCreateRequestSchema.parse(input)),
        headers: { Authorization: `Bearer ${UiSessionTokenSchema.parse(caller.token)}`, 'X-Jevellan-Source-Device': caller.sourceDeviceId, Accept: 'application/json', 'Content-Type': 'application/json' } });
    } catch { throw failure(coordinatorUnreachable(row.device.name), 502); }
    if (answer.status >= 300 && answer.status < 400) { await answer.body?.cancel(); throw failure(COORDINATOR_DEVICE_REDIRECT, 502); }
    const value: unknown = await answer.json().catch(() => null);
    if (answer.ok) return parseReply(ThreadCreatedViewSchema, value);
    const refused = ErrorDocumentSchema.safeParse(value);
    throw refused.success ? failure(refused.data.message, answer.status) : failure(coordinatorUnreachable(row.device.name), 502);
  };
}

/**
 * Projects routes, called after browser authentication and origin checks (brief 11). Thread routes run on the thread's
 * owner device and coordinator routes on the coordinator device: another device's are proxied there with the browser session
 * (phase 5, design 2.10, D266). Thread actions answer 202 with the thread view after the action, coordinator Stop and Fresh
 * with the project view (D207), an override 200 with `thread-override-view-v1` (design 2.10). `token` is the browser
 * session, checked again on every flush of the chat stream.
 */
export async function handleProjectWorkApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string, retryable: () => void): Promise<boolean> {
  const route = projectWorkRoute(url.pathname, request.method ?? 'GET'); if (!route) return false;
  return run(app, request, response, url, route, { token, sourceDeviceId: app.device.deviceId, peer: false, authenticated: () => app.streamAuthenticated(token) }, retryable);
}

/**
 * The peer receiver (phase 5, design 2.10, D41): another device forwards a signed-in owner's request for a thread this device
 * owns or a coordinator it runs. Browsers are refused, the session is checked with the generic peer check, the path must be one
 * of the owner/coordinator routes or a decision answer forwarded to its thread owner (background start/event routes stay absent, D40), and the
 * resource must be here; then the same handler runs, never proxying again.
 */
export async function handleProjectWorkPeer(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, retryable: () => void): Promise<boolean> {
  if (!url.pathname.startsWith(PEER_PREFIX)) return false;
  if (request.headers.origin || request.headers['sec-fetch-site']) throw failure('Use the device connection for this request.', 403);
  const local = localPath(url.pathname); let route: ProjectWorkRoute | null = null;
  // A method the local route does not take is as absent here as an unknown path.
  if (local !== null) { try { route = projectWorkRoute(local, request.method ?? 'GET'); } catch { route = null; } }
  if (!route || (route.target !== 'owner' && route.target !== 'coordinator' && route.name !== 'answer')) throw failure(PROJECT_OPERATION_NOT_FOUND, 404);
  const authorization = request.headers.authorization;
  const input = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'],
    token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
  if (!input.success || !await app.peerLoginAuthenticated(input.data)) throw failure('Sign in to Jevellan.', 401);
  app.redactor.add(input.data.token);
  const here = new URL(url); here.pathname = local!;
  return run(app, request, response, here, route, { token: input.data.token, sourceDeviceId: input.data.sourceDeviceId, peer: true,
    authenticated: () => app.peerLoginAuthenticated(input.data, true) }, retryable);
}

async function run(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ProjectWorkRoute, caller: Caller, retryable: () => void): Promise<boolean> {
  // Redaction never lengthens a text past the maximum its schema checked, so proxies and devices read every view (P8 review S-1).
  const send = (value: unknown, status = 200) => json(response, boundedRedaction(app.redactor, value), status);
  const work = app.projectWork; await work.ready;
  const projectId = route.projectId ?? ''; const threadId = route.threadId ?? ''; const decisionId = route.decisionId ?? '';
  const write = request.method !== 'GET';
  if (withClientId.has(route.name) || route.name === 'waiting-answer' || route.name === 'page-view') retryable();
  if (route.name === 'answer' || route.name === 'waiting-answer') {
    const owner = await work.decisionOwner(projectId, decisionId);
    if (owner && owner !== app.device.deviceId) {
      if (caller.peer) throw failure(THREAD_NOT_FOUND, 404);
      await proxy(app, request, response, url, { ...route, target: 'owner' }, owner, caller); return true;
    }
  }
  if (route.target === 'owner') {
    const owner = await (route.name === 'thread-events' ? work.threadStreamOwner(projectId, threadId)
      : route.name === 'thread' || route.name === 'thread-actions-view' || route.name === 'thread-why-view' || route.name === 'thread-override-editor' || route.name === 'thread-override-preview' || route.name === 'landing-why' || route.name === 'merge-why' ? work.threadReadOwner(projectId, threadId) : work.threadOwner(projectId, threadId));
    if (owner === null) throw failure(THREAD_NOT_FOUND, 404);
    if (owner !== app.device.deviceId) {
      if (caller.peer) throw failure(THREAD_NOT_FOUND, 404);
      await proxy(app, request, response, url, route, owner, caller); return true;
    }
  }
  if (route.target === 'coordinator') {
    // Before any assignment the request runs here (messages and new threads assign this device, D6); a peer needs the coordinator here.
    const coordinator = await work.coordinatorDevice(projectId);
    if (caller.peer && coordinator !== app.device.deviceId) throw failure(COORDINATOR_NOT_HERE, 404);
    if (coordinator !== null && coordinator !== app.device.deviceId) { await proxy(app, request, response, url, route, coordinator, caller); return true; }
  }
  if (route.target === 'coordinator' && /^(job|daily)-(create|run)$/u.test(route.name)) await work.prepareDailyWork(projectId);
  switch (route.name) {
    case 'setup-request': send(await work.requestSetup(projectId, await requestBody(request)), 202); return true;
    case 'setup-get': send(await work.setupView(projectId, route.proposalId!)); return true;
    case 'setup-action': send(await work.setupAction(projectId, route.proposalId!, SetupActionRequestSchema.parse(await requestBody(request)))); return true;
    case 'usage': send(await work.usage.view(projectId, url.searchParams.get('range') ?? 'today')); return true;
    case 'session-history': send(await work.sessionTranscript(projectId, url.searchParams.get('session') ?? '')); return true;
    case 'ekoa-code-setup': send(await work.setupEkoaCode(projectId, EkoaCodeSetupRequestSchema.parse(await requestBody(request)))); return true;
    case 'deploy-list': send(await work.deploys.view(projectId)); return true;
    case 'deploy-summary': send(await work.deploys.summary(projectId)); return true;
    case 'routine-settings-view': send(await ownerRoutineSettings(app, projectId)); return true;
    case 'routine-settings-save': send(await ownerRoutineSettings(app, projectId, await requestBody(request))); return true;
    case 'deploy-baseline': { const { expectedRevision, schema: _schema, ...input } = DeployBaselineRequestSchema.parse(await requestBody(request)); void _schema; send(await work.deploys.baseline(projectId, input, expectedRevision)); return true; }
    case 'deploy-rollback': { const input = DeployRollbackRequestSchema.parse(await requestBody(request)); send(await work.deploys.rollback(projectId, threadId, input.expectedRevision), 202); return true; }
    case 'health-list': send(await app.projectHealthRequest({ schema: 'project-health-request-v1', project: projectId, operation: 'list' })); return true;
    case 'health-run': { const input = ProjectHealthRequestSchema.parse(await requestBody(request)); send(await app.projectHealthRequest({ ...input, project: projectId, operation: 'run' })); return true; }
    case 'job-editor': send(await work.routineEditor(projectId, 'job', route.jobId)); return true;
    case 'daily-editor': send(await work.routineEditor(projectId, 'daily', route.dailyId)); return true;
    case 'job-editor-save': {
      const input = RoutineEditorSaveRequestSchema.parse(await requestBody(request));
      send(await work.saveRoutineEditor(projectId, route.jobId, input, 'job'), input.schema === 'job-editor-create-request-v1' ? 201 : 200); return true;
    }
    case 'daily-editor-save': {
      const input = RoutineEditorSaveRequestSchema.parse(await requestBody(request));
      send(await work.saveRoutineEditor(projectId, route.dailyId, input, 'daily'), input.schema === 'daily-editor-create-request-v1' ? 201 : 200); return true;
    }
    case 'jobs-view': send(await work.jobsView(projectId)); return true;
    case 'daily-enabled': send(await work.daily.setEnabled(projectId, route.dailyId!, DailyEnabledRequestSchema.parse(await requestBody(request)))); return true;
    case 'job-paused': send(await work.daily.setPaused(projectId, route.jobId!, JobPausedRequestSchema.parse(await requestBody(request)))); return true;
    case 'job-list': send({ schema: 'project-job-list-view-v1', projectId, jobs: await work.daily.jobs(projectId) }); return true;
    case 'job-create': send(await work.daily.createJob(projectId, JobCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'job-update': send(await work.daily.updateJob(projectId, route.jobId!, JobUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'job-run': send(await work.daily.runJob(projectId, route.jobId!, ProjectRunRequestSchema.parse(await requestBody(request))), 202); return true;
    case 'job-runs': send({ schema: 'project-job-run-list-view-v1', projectId, runs: await work.jobs.runs(projectId) }); return true;
    case 'daily-list': send(await work.daily.view(projectId)); return true;
    case 'daily-create': send(await work.daily.createDaily(projectId, DailyCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'daily-update': send(await work.daily.updateDaily(projectId, route.dailyId!, DailyUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'daily-run': send(await work.daily.runDaily(projectId, route.dailyId!, ProjectRunRequestSchema.parse(await requestBody(request))), 202); return true;

    case 'goal-views': send(await work.goalViews(projectId)); return true;
    case 'settings-editor': send(await ownerSettingsEditor(app, projectId)); return true;
    case 'settings-editor-save': send(await work.saveSettingsEditor(projectId, await requestBody(request))); return true;
    case 'landing-editor': send(await work.landingEditor(projectId, ProjectLandingEditorRequestSchema.parse(await requestBody(request)))); return true;
    case 'landing-editor-save': send(await work.saveLandingEditor(projectId, ProjectLandingEditorSaveSchema.parse(await requestBody(request)))); return true;
    case 'settings-change-view': send(await work.settingsChangeView(projectId, ProjectSettingsChangeViewRequestSchema.parse(await requestBody(request)))); return true;
    case 'coordinator-editor': send(await work.coordinatorEditor(projectId)); return true;
    case 'coordinator-editor-preview': send(await work.coordinatorEditor(projectId, ProjectCoordinatorEditorPreviewSchema.parse(await requestBody(request)))); return true;
    case 'coordinator-editor-save': send(await work.saveCoordinatorEditor(projectId, ProjectCoordinatorEditorSaveSchema.parse(await requestBody(request)))); return true;
    case 'goal-editor': send(await work.goalEditor(projectId, route.goalId)); return true;
    case 'goal-editor-save': send(await work.saveGoalEditor(projectId, route.goalId, await requestBody(request)), route.goalId ? 200 : 201); return true;
    case 'goal-list': send(await work.goalList(projectId)); return true;
    case 'goal-create': send(await work.createGoal(projectId, GoalCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'goal-update': send(await work.updateGoal(projectId, route.goalId!, GoalUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'task-list': send(await work.taskList(projectId)); return true;
    case 'task-create': send(await work.createTask(projectId, TaskCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'task': send(await work.taskView(projectId, route.taskId!)); return true;
    case 'task-update': send(await work.updateTask(projectId, route.taskId!, TaskUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'task-action': send(await work.taskAction(projectId, route.taskId!, TaskActionRequestSchema.parse(await requestBody(request)))); return true;
    case 'list': send(await work.list()); return true;
    case 'sidebar-view': send(await work.views.sidebar()); return true;
    case 'view': send(await work.view(projectId)); return true;
    case 'page-view': {
      const input = request.method === 'GET' ? ProjectPageQuerySchema.parse(Object.fromEntries(url.searchParams)) : ProjectPageRequestSchema.parse(await requestBody(request));
      const { resolvedDays, ...viewer } = input; send(await work.pageView(projectId, resolvedDays, viewer)); return true;
    }
    case 'waiting-list': send(await work.waitingView(projectId)); return true;
    case 'waiting-answer': send(await work.respondWaiting(projectId, decisionId, ProjectWaitingRespondRequestSchema.parse(await requestBody(request)))); return true;
    case 'events': {
      const ledger = await work.coordinatorEvents(projectId);
      streamLedger(ledger, request, response, url, caller.authenticated, projectFrame(ledger, true)); return true;
    }
    case 'landing-why': send(await work.landingWhy(projectId, threadId)); return true;
    case 'merge-why': send(await work.mergeWhy(projectId, threadId, ProjectMergeWhyRequestSchema.parse(await requestBody(request)))); return true;
    case 'landing-why-correction': send(await work.landingWhyCorrection(projectId, threadId, LandingCorrectionInputSchema.parse(await requestBody(request)))); return true;
    case 'merge-why-correction': send(await work.mergeWhyCorrection(projectId, threadId, MergeCorrectionInputSchema.parse(await requestBody(request)))); return true;
    case 'thread-override-editor': send(await work.views.overrideEditor(projectId, threadId)); return true;
    case 'thread-override-preview': send(await work.views.overrideEditor(projectId, threadId, ThreadOverrideEditorPreviewSchema.parse(await requestBody(request)))); return true;
    case 'thread-override-save': send(await work.overrideThread(projectId, threadId, await work.views.overrideEditorInput(projectId, threadId, ThreadOverrideEditorSaveSchema.parse(await requestBody(request))), remoteStart(app, caller))); return true;
    case 'thread-why-view': send(await work.views.why(projectId, threadId)); return true;
    case 'thread-actions-view': send(await work.views.actions(projectId, threadId)); return true;
    case 'thread-events': {
      // Owner routing already validates the project and hub index. The index can precede
      // the member's local thread file; subscribe now so its first events are not missed.
      const ledger = work.ledgers.thread(projectId, threadId);
      streamLedger(ledger, request, response, url, caller.authenticated, projectFrame(ledger)); return true;
    }
    case 'message': {
      const { repeated } = await work.postMessage(projectId, CoordinatorMessageRequestSchema.parse(await requestBody(request)));
      send(CoordinatorMessageReceiptSchema.parse({ schema: 'coordinator-message-receipt-v1', repeated }), 202); return true;
    }
    case 'stop': EmptySchema.parse(await requestBody(request)); await work.stopCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'handoff': EmptySchema.parse(await requestBody(request)); await work.requestCoordinatorHandoff(projectId); send(await work.view(projectId), 202); return true;
    case 'fresh': EmptySchema.parse(await requestBody(request)); await work.freshCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'move': EmptySchema.parse(await requestBody(request)); await work.moveCoordinatorHere(projectId); send(await work.view(projectId)); return true;
    case 'settings': {
      if (!write) { send(await work.settingsView(projectId)); return true; }
      // The body is parsed before the revision is compared on the hub.
      const input = ProjectWorkSettingsRequestSchema.parse(await requestBody(request));
      if (input.clientRequestId !== undefined) retryable();
      send(await work.putSettings(projectId, input)); return true;
    }
    case 'settings-undo': send(await work.undoSetting(projectId, await requestBody(request))); return true;
    case 'notebook':
      send(write ? await work.putNotebook(projectId, NotebookRequestSchema.parse(await requestBody(request))) : await work.notebookView(projectId)); return true;
    case 'answer': {
      const { repeated, closed } = await work.answerDecision(projectId, decisionId, DecisionAnswerRequestSchema.parse(await requestBody(request)));
      send(DecisionAnsweredViewSchema.parse({ schema: 'decision-answered-view-v1', repeated, ...(closed === undefined ? {} : { closed }) }), 202); return true;
    }
    case 'thread-create': send(await work.createThread(projectId, ThreadCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'thread': send(url.searchParams.has('session') ? await work.sessionTranscript(projectId, url.searchParams.get('session')!, threadId) : await work.threadView(projectId, threadId)); return true;
    case 'thread-image': {
      const thread = work.store.get(threadId);
      if (!thread || thread.projectId !== projectId) throw failure(THREAD_NOT_FOUND, 404);
      if (!thread.cwd) throw failure('This thread has no worktree yet.', 409);
      const ref = url.searchParams.get('ref');
      if (!ref || ref.length > 4096) throw failure('Choose an image from this thread.', 400);
      send(await readProjectImage(thread.cwd, ref)); return true;
    }
    case 'thread-action': send(await work.threadAction(projectId, threadId, ThreadActionRequestSchema.parse(await requestBody(request)))); return true;
    case 'thread-message': {
      const { repeated } = await work.threadMessage(projectId, threadId, ThreadMessageRequestSchema.parse(await requestBody(request)));
      send(ThreadMessageReceiptSchema.parse({ schema: 'thread-message-receipt-v1', repeated }), 202); return true;
    }
    case 'pr-merge': EmptySchema.parse(await requestBody(request)); send(MergeResultViewSchema.parse(await work.mergePullRequest(projectId, threadId))); return true;
    case 'landing-route': send(await work.landingRoute(projectId, threadId)); return true;
    case 'landing-correction': send(await work.landingCorrection(projectId, threadId, LandingCorrectionInputSchema.parse(await requestBody(request)))); return true;
    case 'pr-route': send(await work.mergeRoute(projectId, threadId)); return true;
    case 'pr-correction': send(await work.mergeCorrection(projectId, threadId, MergeCorrectionInputSchema.parse(await requestBody(request)))); return true;
    // A restart answers with the new thread's id, which the page opens.
    case 'thread-override': send(await work.overrideThread(projectId, threadId, ThreadOverrideRequestSchema.parse(await requestBody(request)), remoteStart(app, caller))); return true;
    case 'thread-stop': await work.stopThread(projectId, threadId, ThreadStopRequestSchema.parse(await requestBody(request))); break;
    case 'thread-discard': EmptySchema.parse(await requestBody(request)); await work.discardThread(projectId, threadId); break;
    case 'thread-allow': EmptySchema.parse(await requestBody(request)); await work.allowTurns(projectId, threadId); break;
    case 'pr-refresh': EmptySchema.parse(await requestBody(request)); await work.refreshPullRequest(projectId, threadId); break;
  }
  send(await work.threadView(projectId, threadId), 202); return true;
}
