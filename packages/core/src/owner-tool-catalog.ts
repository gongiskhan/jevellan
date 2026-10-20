import { z } from 'zod';
import type { OwnerToolName } from './owner-tool-schemas.js';

/**
 * The twelve owner tools (bridge specification, "The twelve tools"): exact model-facing descriptions, the actions each takes and
 * whether each action reads or writes. The forwarder lists them as they are here; the state point validates every call against them.
 */
const project = z.string().min(1).max(200).optional().describe('Project name or id. Defaults to the session\'s project.');
const detail = z.boolean().optional().describe('Longer output (up to 12,000 characters).');
const id = (what: string) => z.string().min(1).max(128).describe(what);
const text = (max = 20000) => z.string().min(1).max(max);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

export type OwnerToolAction = { name: string; access: 'read' | 'write'; input: z.ZodObject };
export type OwnerToolDefinition = { name: OwnerToolName; description: string; actions: readonly OwnerToolAction[]; single?: true };
const read = (name: string, shape: z.ZodRawShape = {}): OwnerToolAction => ({ name, access: 'read', input: z.strictObject({ project, ...shape }) });
const write = (name: string, shape: z.ZodRawShape = {}): OwnerToolAction => ({ name, access: 'write', input: z.strictObject({ project, ...shape }) });

export const OWNER_TOOLS: readonly OwnerToolDefinition[] = [
  { name: 'status', single: true, description: "What is happening in a Jevellan project right now: what waits on the owner, what runs, lands, is queued or finished recently, plus goals, budgets, deploy, health checks and the night at a glance. Use it for any 'what's going on' question.",
    actions: [read('status', { goal: z.string().min(1).max(200).optional().describe('Goal id (G2) or title.'), section: z.enum(['waiting', 'running', 'queued', 'landed', 'finished']).optional(), detail })] },
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
      read('inspect', { task: id('Task id (T31).') })] },
  { name: 'goals', description: "Project goals: list them, see one in detail (its tasks by state, what is due, the coordinator's recent decisions), create, edit, pause, resume or mark one done. Act on a goal's tasks with work, thread and override.",
    actions: [read('list'), read('show', { goal: id('Goal id (G1) or title.') }),
      write('create', { title: text(80), motivation: text(4000), health: z.string().max(1000).optional() }),
      write('edit', { goal: id('Goal id (G1) or title.'), title: text(80).optional(), motivation: text(4000).optional(), health: z.string().max(1000).optional() }),
      write('pause', { goal: id('Goal id (G1) or title.') }), write('resume', { goal: id('Goal id (G1) or title.') }), write('done', { goal: id('Goal id (G1) or title.') })] },
  { name: 'jobs', description: 'Everything that used to run on GitHub: the night window and its ordered items, command jobs on any device, the deploy message and the last deploy, health checks, rollback, and the intake of external pull requests. See what is scheduled, running, done, failed or missed; run something now, pause, resume, change when it runs, or roll back the last deploy.',
    actions: [read('list'), read('show', { job: id('Job or night item name, slug or id.') }), read('history', { job: id('Job or night item name, slug or id.'), limit: z.number().int().min(1).max(50).optional() }),
      read('night'), read('deploy'), read('health'),
      write('run', { job: id('Job or night item name, slug or id.') }), write('pause', { job: id('Job or night item name, slug or id.') }), write('resume', { job: id('Job or night item name, slug or id.') }),
      write('schedule', { job: id('Job, night item or "night".'), windowStart: clock.optional(), days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1).max(7).optional(),
        order: z.array(z.string().min(1).max(120)).min(1).max(30).optional(), everyMinutes: z.number().int().min(5).max(1440).optional(), between: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/u).optional(),
        text: text(400).describe("The owner's words.") }),
      write('health_run', { check: z.string().min(1).max(120).optional() }), write('rollback', { confirm: z.boolean().optional() })] },
  { name: 'thread', description: "Steer a running thread: say something to it, take it over in the Claude app or a terminal (open), hand it back (return), or stop it. The coordinator can't be taken over.",
    actions: [write('say', { thread: id('Thread id (T31).'), text: text(20000), now: z.boolean().optional() }), write('open', { thread: id('Thread id (T31).') }),
      write('return', { thread: id('Thread id (T31).'), as: z.enum(['resume', 'done', 'stop']).optional(), note: text(4000).optional() }), write('stop', { thread: id('Thread id (T31).'), reason: text(400).optional() })] },
  { name: 'respond', single: true, description: 'Answer something waiting on the owner: a question, a decision, a deploy message, a failed deploy, a rollback question, an external pull request, a login. Use one of the options the item lists; questions take free text.',
    actions: [write('respond', { item: id('Waiting item id (W12).'), answer: text(20000), note: text(4000).optional() })] },
  { name: 'override', single: true, description: "Override a decision made by Jev, the coordinator or Jevellan. override_undo undoes what followed the decision and redoes it the owner's way; override_only keeps what happened and records the lesson for next time. A reason is required: it becomes the lesson.",
    actions: [write('override', { decision: id('Decision id (D201).'), choice: text(200), mode: z.enum(['override_undo', 'override_only']), reason: text(1000) })] },
  { name: 'jev', description: 'Control Jev, which decides runtime, account, model, effort and how a finished thread lands: its rules, its prompts and question sets, and the lessons learned from overrides. Changes are proposed, replayed against recent real decisions, then applied, with versions to roll back to.',
    actions: [read('rules'), read('prompts'), read('prompt_show', { name: id('Prompt or question set name (l-v1).'), version: z.number().int().positive().optional() }), read('prompt_history', { name: id('Prompt or question set name (l-v1).') }), read('lessons'),
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
    actions: [read('get', { section: z.string().min(1).max(40).optional() }), read('secrets'),
      write('set', { section: z.string().min(1).max(40), key: z.string().min(1).max(120), value: z.union([z.string().max(4000), z.number(), z.boolean()]) }),
      write('add_health_check', { check: z.record(z.string(), z.unknown()) }), write('edit_health_check', { check: z.record(z.string(), z.unknown()) }),
      write('add_account', { label: z.string().min(1).max(80), runtime: z.enum(['claude', 'codex']), budgetPercent: z.number().int().min(1).max(100).optional() }), write('remove_account', { label: z.string().min(1).max(80) }),
      write('set_secret', { name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), value: z.string().min(1).max(20000) })] },
  { name: 'login', description: 'Log an account in, or check logins. Returns a link, and a code when the provider uses one, for the owner to open. When a Claude login shows a code after approval, call complete with that code.',
    actions: [write('start', { account: z.string().min(1).max(80), interactive: z.boolean().optional().describe('An interactive Claude login, which remote control needs.') }), write('complete', { account: z.string().min(1).max(80), code: z.string().min(1).max(4000) }), read('status', { account: z.string().min(1).max(80).optional() })] },
];

export function ownerTool(name: string): OwnerToolDefinition | undefined { return OWNER_TOOLS.find(tool => tool.name === name); }

/** The action a call names: tools with one action take none; ask_coordinator's action is its mode. */
export function ownerToolAction(tool: OwnerToolDefinition, args: Record<string, unknown>, action?: string): OwnerToolAction | undefined {
  if (tool.single && tool.actions.length === 1) return tool.actions[0];
  const name = tool.name === 'ask_coordinator' ? (typeof args.mode === 'string' ? args.mode : action) : action ?? (typeof args.action === 'string' ? args.action : undefined);
  return tool.actions.find(entry => entry.name === name);
}

/** One JSON input schema per tool for MCP listing: the union of its actions' fields with an `action` enum where there are several. */
export function ownerToolInputSchema(tool: OwnerToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const action of tool.actions) {
    const json = z.toJSONSchema(action.input, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, unknown> };
    for (const [key, value] of Object.entries(json.properties ?? {})) if (!(key in properties)) properties[key] = value;
  }
  // The mode is the action here: both values are offered (each action's own schema has only its literal).
  if (tool.name === 'ask_coordinator') return { type: 'object', properties: { ...properties, mode: { type: 'string', enum: ['ask', 'tell', 'restart'], description: 'ask: a question the coordinator answers without acting. tell: an instruction it acts on. restart: run a coordinator that stopped after failed turns again (text is not used).' } }, required: ['mode'], additionalProperties: false };
  if (tool.single) return { type: 'object', properties, additionalProperties: false };
  return { type: 'object', properties: { action: { type: 'string', enum: tool.actions.map(action => action.name), description: `One of: ${tool.actions.map(action => `${action.name} (${action.access})`).join(', ')}.` }, ...properties }, required: ['action'], additionalProperties: false };
}
