import { ConversationControlEditorRequestSchema, ConversationControlDraftRequestSchema, ConversationControlCommandSchema } from './conversation-control-editor.js';
import { ConversationMessageDraftRequestSchema, ConversationMessageCommandSchema } from './conversation-message-draft.js';
import { ConversationStartRequestSchema } from './conversation-start.js';
import { ProjectSetupWaitRequestSchema } from './project-setup-view.js';
import { ConversationCreationIntentSchema } from './conversation-creation-draft.js';
import { ConversationNewRequestSchema } from './conversation-new-view.js';
import { ConversationSidebarDropRequestSchema, ConversationSidebarRenameRequestSchema } from './conversation-sidebar-actions.js';
import { ConversationSidebarRequestSchema } from './conversation-sidebar-view.js';
import { OwnerCommandSchema } from './owner-command-schemas.js';
import { ProjectPageRequestSchema } from './project-page-schemas.js';
import { ConversationTranscriptRequestSchema } from './conversation-transcript-view-schemas.js';
import { SessionListUpdateSchema } from './session-list-schemas.js';
import { ConversationEvidenceRequestSchema } from './conversation-evidence-view.js';
import { PlanApprovalSchema } from './conversation-schemas.js';
import { ConversationPlanChangesRequestSchema } from './conversation-plans-view.js';
import { ConversationPlanReadRequestSchema } from './plan-content-view.js';
import { ProjectTaskEditorPreviewSchema, ProjectTaskEditorSaveSchema } from './project-task-editor-schemas.js';
import { EkoaEditorPreviewSchema, EkoaEditorSaveSchema } from './ekoa-editor-schemas.js';
import { CleanupSettingsSaveSchema } from './cleanup-editor-schemas.js';
import { GlobalThreadLimitSaveSchema, ProjectDefinitionPreviewSchema, ProjectDefinitionSaveSchema } from './project-definition-schemas.js';
import { AccountEditorPreviewSchema, AccountEditorSaveSchema } from './account-editor-schemas.js';
import { RuntimeSettingsSaveSchema } from './runtime-settings-schemas.js';
import { ProjectEnvironmentEditorPreviewSchema, ProjectEnvironmentEditorSaveSchema } from './project-environment-editor-schemas.js';
import { ProjectPlacementEditorPreviewSchema, ProjectPlacementEditorSaveSchema } from './project-placement-editor-schemas.js';
import { StepCorrectionPreviewSchema } from './conversation-decision-view-schemas.js';
import { DecisionsSettingsPreviewSchema, DecisionsSettingsSaveSchema } from './decisions-settings-schemas.js';
import { CorrectStepSchema } from './conversation-schemas.js';
import { ComposerChoiceSchema, ComposerInitialSchema } from './composer-schemas.js';
import { ProjectRouteCorrectionRequestSchema } from './project-route-why-schemas.js';
import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ThreadMutationActionSchema } from './project-card-schemas.js';
import { ThreadOverrideEditorPreviewSchema, ThreadOverrideEditorSaveSchema } from './project-override-editor-schemas.js';
import { GoalEditorSaveRequestSchema } from './project-goal-view-schemas.js';
import { RoutineEditorSaveRequestSchema } from './project-routine-editor-schemas.js';
import { ProjectRoutineSettingsSaveSchema } from './project-routine-settings-schemas.js';
import { ProjectCoordinatorEditorPreviewSchema, ProjectCoordinatorEditorSaveSchema } from './project-coordinator-editor-schemas.js';
import { ProjectSettingsChangeViewRequestSchema } from './project-settings-change-view-schemas.js';
import { ProjectSettingsUndoRequestSchema } from './project-parity-schemas.js';
import { ProjectLandingEditorRequestSchema, ProjectLandingEditorSaveSchema } from './project-landing-editor-schemas.js';
import { ProjectSettingsEditorSaveRequestSchema } from './project-settings-editor-schemas.js';
import { ProjectEnvNameSchema } from './project-parity-schemas.js';
import { NotificationBrowserFactsSchema } from './notification-editor-schemas.js';
import { ProjectUsageRangeSchema } from './project-usage-schemas.js';
import { ConfigurationApplyRequestSchema } from './configuration-editor-schemas.js';
import { ImportSchema } from './client-schemas.js';
import type { OwnerToolName, OwnerToolResult } from './owner-tool-schemas.js';

/**
 * The twelve owner tools (bridge specification, "The twelve tools"): exact model-facing descriptions, the actions each takes and
 * whether each action reads or writes. The forwarder lists them as they are here; the state point validates every call against them.
 */
const project = z.string().min(1).max(200).optional().describe('Project name or id. Defaults to the session\'s project.');
const detail = z.boolean().optional().describe('Longer output (up to 12,000 characters).');
const id = (what: string) => z.string().min(1).max(128).describe(what);
const text = (max = 20000) => z.string().min(1).max(max);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

export type OwnerToolAction = { name: string; access: 'read' | 'write'; input: z.ZodObject; structuredResult?: true };
export type OwnerToolDefinition = { name: OwnerToolName; description: string; actions: readonly OwnerToolAction[]; single?: true };
const read = (name: string, shape: z.ZodRawShape = {}, structuredResult = false): OwnerToolAction => ({ name, access: 'read', input: z.strictObject({ project, ...shape }), ...(structuredResult ? { structuredResult: true as const } : {}) });
const write = (name: string, shape: z.ZodRawShape = {}, structuredResult = false): OwnerToolAction => ({ name, access: 'write', input: z.strictObject({ project, ...shape }), ...(structuredResult ? { structuredResult: true as const } : {}) });

export const OWNER_TOOLS: readonly OwnerToolDefinition[] = [
  { name: 'status', single: true, description: "What is happening in a Jevellan project right now: what waits on the owner, what runs, lands, is queued or finished recently, plus goals, budgets, deploy, health checks and the night at a glance. Use it for any 'what's going on' question.",
    actions: [read('status', { goal: z.string().min(1).max(200).optional().describe('Goal id (G2) or title.'), section: z.enum(['waiting', 'running', 'queued', 'landed', 'finished']).optional(), detail }, true)] },
  { name: 'activity', single: true, description: 'What happened: a digest for a period (for example overnight), recent events of the coordinator, a thread or a job run, or decisions with their reasons.',
    actions: [read('activity', { target: z.string().min(1).max(40).optional().describe('C, a T id, a J id, or all (default all).'), kind: z.enum(['digest', 'events', 'decisions']).optional(),
      since: z.string().min(1).max(60).optional().describe('ISO time, HH:MM, "N minutes", "N hours", "today" or "last night".'), limit: z.number().int().min(1).max(200).optional(), detail })] },
  { name: 'ask_coordinator', single: true, description: "Ask the project's coordinator a question (mode ask), give it an instruction (mode tell), or restart it after it stopped on failed turns (mode restart; fresh: true also gives it a new session). Every 'why' question (why this model, this thread, this landing) and every 'what next' question goes here. Never guess what the coordinator would answer.",
    actions: [{ name: 'ask', access: 'read', input: z.strictObject({ project, mode: z.literal('ask'), text: text(8000), wait_seconds: z.number().int().min(0).max(600).optional() }) },
      { name: 'tell', access: 'write', input: z.strictObject({ project, mode: z.literal('tell'), text: text(20000), wait_seconds: z.number().int().min(0).max(600).optional() }) },
      { name: 'restart', access: 'write', input: z.strictObject({ project, mode: z.literal('restart'), fresh: z.boolean().optional().describe('Start the coordinator with a new session instead of resuming its current one.') }) }] },
  { name: 'work', description: 'The task queue: list it, add a task (optionally continuing an existing branch), move a task, cancel one, or inspect one in detail.',
    actions: [read('list', { goal: z.string().min(1).max(200).optional() }),
      write('add', { title: text(120), description: text(20000).optional(), goal: z.string().min(1).max(200).optional(), priority: z.enum(['urgent', 'normal']).optional(),
        position: z.string().regex(/^(?:next|last|[1-9][0-9]{0,3})$/u).optional().describe('next, last or a position number.'), fromBranch: z.string().min(1).max(200).optional() }),
      write('reorder', { task: id('Task id (T36).'), position: z.string().regex(/^(?:next|last|[1-9][0-9]{0,3})$/u) }),
      write('cancel', { task: id('Task id (T36).'), reason: text(400).optional() }),
      read('inspect', { task: id('Task id (T31).') }), read('editor', {}, true), read('preview', { request: ProjectTaskEditorPreviewSchema }, true), write('save', { request: ProjectTaskEditorSaveSchema }, true)] },
  { name: 'goals', description: "Project goals: list them, see one in detail (its tasks by state, what is due, the coordinator's recent decisions), create, edit, pause, resume or mark one done. Act on a goal's tasks with work, thread and override.",
    actions: [read('editor', { id: IdSchema.optional() }, true), write('save', { id: IdSchema.optional(), request: GoalEditorSaveRequestSchema }, true), read('list', {}, true), read('show', { goal: id('Goal id (G1) or title.') }),
      write('create', { title: text(80), motivation: text(4000), health: z.string().max(1000).optional() }),
      write('edit', { goal: id('Goal id (G1) or title.'), title: text(80).optional(), motivation: text(4000).optional(), health: z.string().max(1000).optional() }),
      write('pause', { goal: id('Goal id (G1) or title.') }), write('resume', { goal: id('Goal id (G1) or title.') }), write('done', { goal: id('Goal id (G1) or title.') })] },
  { name: 'jobs', description: 'Everything that used to run on GitHub: the night window and its ordered items, command jobs on any device, the deploy message and the last deploy, health checks, rollback, and the intake of external pull requests. See what is scheduled, running, done, failed or missed; run something now, pause, resume, change when it runs, or roll back the last deploy.',
    actions: [read('list', {}, true), read('editor', { kind: z.enum(['job', 'daily']), id: IdSchema.optional().describe('Definition id from jobs list data; omit for a new definition.') }, true),
      write('save', { id: IdSchema.optional().describe('Definition id for editing; omit for creation.'), request: RoutineEditorSaveRequestSchema }, true),
      read('show', { job: id('Job or night item name, slug or id.') }), read('history', { job: id('Job or night item name, slug or id.'), limit: z.number().int().min(1).max(50).optional() }),
      read('night', {}, true), read('deploy', {}, true), read('health'),
      write('run', { job: id('Job or night item name, slug or id.') }), write('pause', { job: id('Job or night item name, slug or id.') }), write('resume', { job: id('Job or night item name, slug or id.') }),
      write('schedule', { job: id('Job, night item or "night".'), windowStart: clock.optional(), days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1).max(7).optional(),
        order: z.array(z.string().min(1).max(120)).min(1).max(30).optional(), everyMinutes: z.number().int().min(5).max(1440).optional(), between: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/u).optional(),
        text: text(400).describe("The owner's words.") }),
      write('health_run', { check: z.string().min(1).max(120).optional() }), write('rollback', { confirm: z.boolean().optional() })] },
  { name: 'thread', description: "Steer a thread, inspect its current actions, publish or fix its work, resolve/reopen it, or merge its pull request. Read actions first for eligibility and confirmation text. Reuse clientRequestId when retrying act. A consequential resolve and every merge require confirm. Open takes over in the Claude app or a terminal; return hands it back. The coordinator can't be taken over.",
    actions: [write('say', { thread: id('Thread id (T31).'), text: text(20000), now: z.boolean().optional() }), write('open', { thread: id('Thread id (T31).') }),
      write('return', { thread: id('Thread id (T31).'), as: z.enum(['resume', 'done', 'stop']).optional(), note: text(4000).optional() }), write('stop', { thread: id('Thread id (T31).'), reason: text(400).optional() }),
      read('actions', { thread: id('Thread id (T31).') }, true),
      write('act', { thread: id('Thread id (T31).'), operation: ThreadMutationActionSchema, clientRequestId: IdSchema, confirm: z.boolean().optional() }),
      write('merge', { thread: id('Thread id (T31).'), confirm: z.boolean().optional() }), read('view', { thread: id('Thread id (T31).') }, true)] },
  { name: 'respond', single: true, description: 'Answer something waiting on the owner: a question, a decision, a deploy message, a failed deploy, a rollback question, an external pull request, a login. Use one of the options the item lists; questions take free text.',
    actions: [write('respond', { item: id('Waiting item id (W12).'), answer: text(20000), note: text(4000).optional() })] },
  { name: 'override', single: true, description: "Override a decision made by Jev, the coordinator or Jevellan. override_undo undoes what followed the decision and redoes it the owner's way; override_only keeps what happened and records the lesson for next time. A reason is required: it becomes the lesson.",
    actions: [write('override', { decision: id('Decision id (D201).'), choice: text(200), mode: z.enum(['override_undo', 'override_only']), reason: text(1000) })] },
  { name: 'jev', description: 'Control Jev, which decides runtime, account, model, effort and how a finished thread lands: its connection, model menu, guidance and guards, its rules, prompts and question sets, and lessons learned from overrides. Prompt changes are proposed, replayed against recent decisions, then applied, with versions to roll back to.',
    actions: [read('improver', {}, true), read('improver_revision', { id: IdSchema }, true), read('settings_editor', {}, true), read('settings_preview', { request: DecisionsSettingsPreviewSchema }, true), write('settings_save', { request: DecisionsSettingsSaveSchema }, true), read('connection', {}, true), read('connection_check', {}, true), read('conversation_why', { conversation: id('Conversation id.'), decision: id('Recorded decision id.') }, true), read('correction_editor', { conversation: id('Conversation id.'), stretch: z.number().int().positive() }, true), read('correction_preview', { conversation: id('Conversation id.'), request: StepCorrectionPreviewSchema }, true), write('correction_save', { conversation: id('Conversation id.'), request: CorrectStepSchema }, true), write('plan_approve', { conversation: id('Conversation id.'), request: PlanApprovalSchema }, true), write('plan_changes', { conversation: id('Conversation id.'), request: ConversationPlanChangesRequestSchema }, true), read('session_list', {}, true), write('session_list_save', { request: SessionListUpdateSchema }, true), read('conversation_list', {}, true), read('conversation_new', { request: ConversationNewRequestSchema.optional() }, true), read('conversation_create_draft', { request: ConversationCreationIntentSchema }, true), write('conversation_start', { request: ConversationStartRequestSchema }, true), read('project_setup', { request: ProjectSetupWaitRequestSchema.optional() }, true), read('conversation_sidebar', { request: ConversationSidebarRequestSchema.optional() }, true), write('conversation_sidebar_drop', { request: ConversationSidebarDropRequestSchema }, true), write('conversation_sidebar_rename', { request: ConversationSidebarRenameRequestSchema }, true), read('project_page', { request: ProjectPageRequestSchema.optional() }, true), read('owner_command_view', { command: OwnerCommandSchema, thread: IdSchema.optional(), decision: IdSchema.optional(), device: IdSchema.optional() }, true), read('conversation_transcript', { conversation: id('Conversation id.'), request: ConversationTranscriptRequestSchema }, true), read('conversation_view', { conversation: id('Conversation id.') }, true), read('conversation_control_editor', { conversation: id('Conversation id.'), request: ConversationControlEditorRequestSchema }, true), read('conversation_control_draft', { conversation: id('Conversation id.'), request: ConversationControlDraftRequestSchema }, true), write('conversation_control', { conversation: id('Conversation id.'), request: ConversationControlCommandSchema }, true), read('conversation_message_draft', { conversation: id('Conversation id.'), request: ConversationMessageDraftRequestSchema }, true), write('conversation_message', { conversation: id('Conversation id.'), request: ConversationMessageCommandSchema }, true), read('conversation_changes', { conversation: id('Conversation id.'), stretch: z.number().int().positive() }, true), read('evidence_read', { conversation: id('Conversation id.'), request: ConversationEvidenceRequestSchema }, true), read('plan_read', { conversation: id('Conversation id.'), request: ConversationPlanReadRequestSchema }, true), read('composer_editor', { conversation: id('Conversation id.').optional(), initial: ComposerInitialSchema.optional() }, true), read('composer_preview', { initial: ComposerInitialSchema, request: ComposerChoiceSchema }, true), write('composer_save', { conversation: id('Conversation id.'), request: ComposerChoiceSchema }, true), read('override_editor', { thread: id('Thread id (T31).') }, true), read('override_preview', { thread: id('Thread id (T31).'), request: ThreadOverrideEditorPreviewSchema }, true), write('override_save', { thread: id('Thread id (T31).'), request: ThreadOverrideEditorSaveSchema }, true), read('why', { thread: id('Thread id (T31).'), kind: z.enum(['placement', 'landing', 'merge']).optional(), commit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional() }, true), write('route_correct', { thread: id('Thread id (T31).'), request: ProjectRouteCorrectionRequestSchema }, true), read('rules'), read('prompts'), read('prompt_show', { name: id('Prompt or question set name (l-v1).'), version: z.number().int().positive().optional() }), read('prompt_history', { name: id('Prompt or question set name (l-v1).') }), read('lessons'),
      write('rule_set', { rule: z.string().regex(/^[Rr][1-9][0-9]*$/u).optional(), scope: z.enum(['global', 'project']).optional(),
        when: z.strictObject({ taskType: z.string().max(40).optional(), goal: z.string().max(200).optional(), label: z.string().max(200).optional(), keywords: z.array(z.string().min(1).max(60)).max(20).optional() }).optional(),
        set: z.strictObject({ minModel: z.string().max(120).optional(), minEffort: z.string().max(20).optional(), maxEffort: z.string().max(20).optional(), account: z.string().max(120).optional(), runtime: z.string().max(40).optional(), landingRoute: z.string().max(40).optional() }).optional(),
        note: text(400).optional(), enabled: z.boolean().optional() }),
      write('rule_remove', { rule: z.string().regex(/^[Rr][1-9][0-9]*$/u) }),
      write('prompt_propose', { name: id('Prompt or question set name (l-v1).'), text: text(60000).optional(), edits: z.array(z.strictObject({ find: text(20000), replace: z.string().max(20000) })).min(1).max(30).optional(), summary: text(400) }),
      write('prompt_apply', { proposal: z.string().regex(/^[Pp][1-9][0-9]*$/u) }), write('prompt_rollback', { name: id('Prompt or question set name (l-v1).'), version: z.number().int().positive() }),
      write('lesson_edit', { lesson: z.string().regex(/^[Ll][1-9][0-9]*$/u), text: text(1000).optional(), enabled: z.boolean().optional() }), write('lesson_remove', { lesson: z.string().regex(/^[Ll][1-9][0-9]*$/u) }),
      write('replay', { proposal: z.string().regex(/^[Pp][1-9][0-9]*$/u).optional(), lesson: z.string().regex(/^[Ll][1-9][0-9]*$/u).optional(), n: z.number().int().min(1).max(50).optional() })] },
  { name: 'config', description: 'Jevellan settings for a project and the installation: accounts and budgets, limits, the deploy switch, landing, health checks, the coordinator, notifications and quiet hours, cleanup, environment and secrets, remote access and the heartbeat.',
    actions: [read('get', { section: z.string().min(1).max(40).optional() }, true), read('settings_editor', {}, true), write('settings_save', { request: ProjectSettingsEditorSaveRequestSchema }, true), write('remove_secret', { name: ProjectEnvNameSchema }), read('environment_editor', {}, true), read('environment_preview', { request: ProjectEnvironmentEditorPreviewSchema }, true), write('environment_save', { request: ProjectEnvironmentEditorSaveSchema }, true), read('placement_editor', {}, true), read('placement_preview', { request: ProjectPlacementEditorPreviewSchema }, true), write('placement_save', { request: ProjectPlacementEditorSaveSchema }, true), read('landing_editor', {}, true), read('landing_preview', { request: ProjectLandingEditorRequestSchema }, true), write('landing_save', { request: ProjectLandingEditorSaveSchema }, true), read('settings_change', { request: ProjectSettingsChangeViewRequestSchema }, true), write('settings_undo', { request: ProjectSettingsUndoRequestSchema }, true), read('coordinator_editor', {}, true), read('coordinator_preview', { request: ProjectCoordinatorEditorPreviewSchema }, true), write('coordinator_save', { request: ProjectCoordinatorEditorSaveSchema }, true), read('secrets'), read('routines', {}, true), write('routines_save', { request: ProjectRoutineSettingsSaveSchema }, true),
      read('setup_view', { proposal: IdSchema }, true),
      read('mirror_editor', {}, true), read('mirror_preview', { request: EkoaEditorPreviewSchema }, true), write('mirror_save', { request: EkoaEditorSaveSchema }, true),
      read('navigation', {}, true), read('cleanup_editor', {}, true), write('cleanup_save', { request: CleanupSettingsSaveSchema }, true),
      read('limits_editor', {}, true), write('limits_save', { request: GlobalThreadLimitSaveSchema }, true), read('projects_view', {}, true), read('project_editor', { projectId: IdSchema.optional() }, true), read('project_preview', { request: ProjectDefinitionPreviewSchema }, true), write('project_save', { request: ProjectDefinitionSaveSchema }, true),
      read('account_editor', { runtime: IdSchema, accountId: IdSchema.optional(), mode: z.enum(['edit', 'replace-key']).optional() }, true), read('account_preview', { request: AccountEditorPreviewSchema }, true), write('account_save', { request: AccountEditorSaveSchema }, true), read('runtimes_editor', {}, true), write('runtimes_save', { request: RuntimeSettingsSaveSchema }, true), read('accounts_view', {}, true), read('configuration_editor', {}, true), read('configuration_yaml', {}, true), read('configuration_preview', { yaml: ImportSchema.shape.yaml }, true), write('configuration_apply', { request: ConfigurationApplyRequestSchema }, true),
      read('about', {}, true), read('usage', { range: ProjectUsageRangeSchema.optional() }, true), read('notification_editor', { browser: NotificationBrowserFactsSchema.nullable().optional() }, true), write('notification_remove', { id: IdSchema }, true), write('notification_test', {}, true),
      write('set', { section: z.string().min(1).max(40), key: z.string().min(1).max(120), value: z.union([z.string().max(4000), z.number(), z.boolean()]) }),
      write('add_health_check', { check: z.record(z.string(), z.unknown()) }), write('edit_health_check', { check: z.record(z.string(), z.unknown()) }),
      write('add_account', { label: z.string().min(1).max(80), runtime: z.enum(['claude', 'codex']), budgetPercent: z.number().int().min(1).max(100).optional() }), write('remove_account', { label: z.string().min(1).max(80) }),
      write('set_secret', { name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), value: z.string().min(1).max(20000) })] },
  { name: 'login', description: 'Log an account in, or check logins. Returns a link, and a code when the provider uses one, for the owner to open. When a Claude login shows a code after approval, call complete with that code.',
    actions: [write('start', { account: z.string().min(1).max(80), interactive: z.boolean().optional().describe('An interactive Claude login, which remote control needs.') }), write('complete', { account: z.string().min(1).max(80), code: z.string().min(1).max(4000) }), read('status', { account: z.string().min(1).max(80).optional() })] },
];

export function ownerTool(name: string): OwnerToolDefinition | undefined { return OWNER_TOOLS.find(tool => tool.name === name); }

/** Keep explicitly structured actions available to both structured clients and text-only tool consumers. */
export function ownerToolOutput(name: string, args: Record<string, unknown>, result: OwnerToolResult) {
  const content = [{ type: 'text' as const, text: result.ok ? result.text : result.error.text }];
  const definition = ownerTool(name), action = definition ? ownerToolAction(definition, args) : undefined;
  if (result.ok && action?.structuredResult && result.data !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(result) });
    return { content, structuredContent: result };
  }
  return result.ok ? { content } : { content, isError: true };
}

/** The action a call names: tools with one action take none; ask_coordinator's action is its mode. */
export function ownerToolAction(tool: OwnerToolDefinition, args: Record<string, unknown>, action?: string): OwnerToolAction | undefined {
  if (tool.single && tool.actions.length === 1) return tool.actions[0];
  const name = tool.name === 'ask_coordinator' ? (typeof args.mode === 'string' ? args.mode : action) : action ?? (typeof args.action === 'string' ? args.action : undefined);
  return tool.actions.find(entry => entry.name === name);
}

/** One JSON input schema per tool for MCP listing: the union of its actions' fields with an `action` enum where there are several. */
export function ownerToolInputSchema(tool: OwnerToolDefinition): Record<string, unknown> {
  const variants = new Map<string, unknown[]>();
  for (const action of tool.actions) {
    const json = z.toJSONSchema(action.input, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, unknown> };
    for (const [key, value] of Object.entries(json.properties ?? {})) {
      const choices = variants.get(key) ?? [];
      if (!choices.some(choice => JSON.stringify(choice) === JSON.stringify(value))) choices.push(value);
      variants.set(key, choices);
    }
  }
  // Different actions may use one argument name for different versioned documents.
  // Advertising their union does not change the canonical per-action input validation.
  const properties: Record<string, unknown> = Object.fromEntries([...variants].map(([key, choices]) => [key, choices.length === 1 ? choices[0] : { anyOf: choices }]));
  // The mode is the action here: both values are offered (each action's own schema has only its literal).
  if (tool.name === 'ask_coordinator') return { type: 'object', properties: { ...properties, mode: { type: 'string', enum: ['ask', 'tell', 'restart'], description: 'ask: a question the coordinator answers without acting. tell: an instruction it acts on. restart: run a coordinator that stopped after failed turns again (text is not used).' } }, required: ['mode'], additionalProperties: false };
  if (tool.single) return { type: 'object', properties, additionalProperties: false };
  return { type: 'object', properties: { action: { type: 'string', enum: tool.actions.map(action => action.name), description: `One of: ${tool.actions.map(action => `${action.name} (${action.access})`).join(', ')}.` }, ...properties }, required: ['action'], additionalProperties: false };
}
