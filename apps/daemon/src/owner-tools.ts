import { appendFileSync, mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CallerLogEntrySchema, HubUnavailable, ownerClock, OwnerInstallationSettingsSchema, OwnerProjectSettingsSchema, RoutineAutomationPatchSchema, SteeringRecordSchema, defaultOwnerInstallationSettings, defaultOwnerProjectSettings, newId,
  type OwnerInstallationSettings, type OwnerProjectSettings, type SteeringRecord, OWNER_TOOLS, OwnerToolResultSchema, ownerTool, ownerToolAction, type CallerLogEntry, type OwnerToolDefinition, type OwnerToolRequest, type OwnerToolResult,
  type Project, type ProjectStatusView } from '@jevellan/core';
import { OwnerShortIds, projectStatus, renderStatus, renderStatusLine } from '@jevellan/projects';
import type { Application } from './application.js';
import { OWNER_HANDLERS } from './tools/index.js';
import { OwnerTakeover } from './owner-takeover.js';
import { realTmux, type TmuxRunner } from './owner-bridge.js';

/** A refusal whose sentence goes to the owner as it is (bridge specification: one sentence, what is wrong and what is allowed). */
export class OwnerRefusal extends Error {
  constructor(message: string, readonly code = 'refused', readonly status = 400) { super(message); }
}
export type OwnerContext = { app: Application; tools: OwnerTools; project: Project; request: OwnerToolRequest; action: string; args: Record<string, unknown>; now: Date };
export type OwnerHandler = (context: OwnerContext) => Promise<{ text: string; data?: unknown }>;

const CALLER_LOG_DAYS = 30;

/**
 * The owner tools on the state point (bridge specification, "Tool route"): one entry point for the twelve tools, called by the forwarder
 * through `/api/local/tools/:name`, the CLI and the remote endpoint. It validates each call against the catalog, resolves the
 * project, runs the handler (which only calls services and renders text) and writes every call to the caller log.
 */
export class OwnerTools {
  readonly ids: OwnerShortIds;
  #logDay = '';
  constructor(readonly app: Application, readonly now: () => Date = () => new Date(), tmux: TmuxRunner = realTmux) { this.ids = new OwnerShortIds(app.hub); this.takeover = new OwnerTakeover(app, tmux); }
  get logPath(): string { return join(this.app.homes.root, 'owner-tools', 'caller-log.jsonl'); }

  async projects(): Promise<Project[]> { return (await this.app.state.projects.list()).map(row => row.project); }
  /** Bridge specification, "Project resolution": the argument, the session's project, the project holding the working folder, the only project. */
  async resolveProject(request: Pick<OwnerToolRequest, 'project' | 'cwd' | 'deviceId'>, argument?: unknown): Promise<Project> {
    const projects = await this.projects(); const wanted = typeof argument === 'string' && argument ? argument : request.project;
    if (wanted) {
      const found = projects.filter(project => project.id === wanted || project.name.toLowerCase() === wanted.toLowerCase());
      if (found.length === 1) return found[0]!;
      throw new OwnerRefusal(`Which project? Known projects: ${projects.map(project => project.name).join(', ') || 'none'}.`, 'project_unknown', 404);
    }
    if (request.cwd) {
      const cwd = resolve(request.cwd);
      const device = request.deviceId ?? this.app.device.deviceId;
      const here = projects.filter(project => { const path = project.paths[device]; return path && (cwd === resolve(path) || cwd.startsWith(resolve(path) + sep)); });
      if (here.length === 1) return here[0]!;
    }
    if (projects.length === 1) return projects[0]!;
    throw new OwnerRefusal(`Which project? Known projects: ${projects.map(project => project.name).join(', ') || 'none'}.`, 'project_unknown', 404);
  }

  async call(name: string, request: OwnerToolRequest): Promise<OwnerToolResult> {
    const tool = ownerTool(name); const args = request.args;
    const action = tool ? ownerToolAction(tool, args, request.action) : undefined;
    const access = action?.access ?? 'read'; let projectId: string | undefined;
    const log = (ok: boolean, errorCode?: string) => this.#log({ schema: 'caller-log-v1', at: this.now().toISOString(), caller: request.caller, tool: tool?.name ?? 'status', action: action?.name ?? String(request.action ?? args.action ?? name).slice(0, 60),
      access, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('hex'), ok, ...(errorCode ? { errorCode } : {}), ...(projectId ? { projectId } : {}) });
    const fail = (code: string, text: string): OwnerToolResult => { log(false, code); return OwnerToolResultSchema.parse({ schema: 'owner-tool-result-v1', ok: false, error: { code, text } }); };
    if (!tool) return fail('unknown_tool', `There is no tool ${name}. Tools: ${OWNER_TOOLS.map(entry => entry.name).join(', ')}.`);
    if (!action) return fail('unknown_action', `${tool.name} takes ${tool.actions.map(entry => entry.name).join(', ')}.`);
    const { action: _ignored, ...rest } = args; void _ignored;
    const parsed = action.input.safeParse(rest);
    if (!parsed.success) return fail('invalid_arguments', invalidArguments(tool, tool.single ? '' : action.name, parsed.error));
    try {
      await this.app.projectWork.ready;
      const project = await this.resolveProject(request, (parsed.data as { project?: unknown }).project); projectId = project.id;
      const handler = OWNER_HANDLERS[tool.name];
      const result = await handler({ app: this.app, tools: this, project, request, action: action.name, args: parsed.data as Record<string, unknown>, now: this.now() });
      log(true);
      return OwnerToolResultSchema.parse({ schema: 'owner-tool-result-v1', ok: true, text: this.app.redactor.text(result.text), ...(result.data === undefined ? {} : { data: result.data }) });
    } catch (error) {
      if (error instanceof OwnerRefusal) return fail(error.code, error.message);
      if (error instanceof HubUnavailable) return fail('hub_unavailable', 'The state point is not reachable right now. Try again in a minute.');
      const status = (error as { status?: unknown }).status; const message = (error as { message?: unknown }).message;
      if (typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string') return fail(typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'refused', this.app.redactor.text(message));
      return fail('failed', `The request could not complete: ${this.app.redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }

  /** Every call, kept 30 days (bridge specification, "Caller log entry"). */
  #log(entry: CallerLogEntry): void {
    const line = JSON.stringify(CallerLogEntrySchema.parse(entry));
    try {
      mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 }); appendFileSync(this.logPath, `${line}\n`, { mode: 0o600 });
      const day = entry.at.slice(0, 10); if (day !== this.#logDay) { this.#logDay = day; this.#trimLog(); }
    } catch { /* the log never fails a call */ }
  }
  #trimLog(): void {
    if (!existsSync(this.logPath)) return;
    const cutoff = new Date(this.now().getTime() - CALLER_LOG_DAYS * 24 * 3600_000).toISOString();
    const kept = readFileSync(this.logPath, 'utf8').split('\n').filter(line => { if (!line) return false; try { return (JSON.parse(line) as { at: string }).at >= cutoff; } catch { return false; } });
    const temporary = `${this.logPath}.tmp`; writeFileSync(temporary, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 }); renameSync(temporary, this.logPath);
  }
  /** Bridge settings of a project on the state point (push, bridge, deploy pause, catch-up), defaults until changed. */
  projectSettings(projectId: string): OwnerProjectSettings {
    return this.app.hub.get('owner-settings', projectId, OwnerProjectSettingsSchema)?.document ?? defaultOwnerProjectSettings(projectId);
  }
  updateProjectSettings(projectId: string, change: (settings: OwnerProjectSettings) => OwnerProjectSettings): OwnerProjectSettings {
    const stored = this.app.hub.get('owner-settings', projectId, OwnerProjectSettingsSchema);
    return this.app.hub.put('owner-settings', projectId, OwnerProjectSettingsSchema, change(stored?.document ?? defaultOwnerProjectSettings(projectId)), stored?.revision ?? 0).document;
  }
  routineSettingsState(projectId: string) {
    const stored = this.app.hub.get('owner-settings', projectId, OwnerProjectSettingsSchema);
    return { owner: stored?.document ?? defaultOwnerProjectSettings(projectId), revision: stored?.revision ?? 0 };
  }
  patchRoutineSettings(projectId: string, raw: unknown, expectedRevision?: number) {
    const parsed = RoutineAutomationPatchSchema.safeParse(raw);
    if (!parsed.success) throw new OwnerRefusal(parsed.error.issues[0]?.message ?? 'Choose valid automation preferences.', 'invalid_value');
    const { owner, revision } = this.routineSettingsState(projectId);
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new OwnerRefusal('These automation settings changed. Reload before saving.', 'settings_changed', 409);
    const patch = parsed.data;
    return this.app.hub.put('owner-settings', projectId, OwnerProjectSettingsSchema, { ...owner,
      deploy: { ...owner.deploy, ...(patch.deployPaused === undefined ? {} : { paused: patch.deployPaused }), ...(patch.debounceMinutes === undefined ? {} : { debounceMinutes: patch.debounceMinutes }) },
      night: { ...owner.night, ...(patch.catchUpHours === undefined ? {} : { catchUpHours: patch.catchUpHours }) },
    }, revision).document;
  }
  installationSettings(): OwnerInstallationSettings {
    return this.app.hub.get('owner-settings', 'installation', OwnerInstallationSettingsSchema)?.document ?? defaultOwnerInstallationSettings();
  }
  updateInstallationSettings(change: (settings: OwnerInstallationSettings) => OwnerInstallationSettings): OwnerInstallationSettings {
    const stored = this.app.hub.get('owner-settings', 'installation', OwnerInstallationSettingsSchema);
    return this.app.hub.put('owner-settings', 'installation', OwnerInstallationSettingsSchema, change(stored?.document ?? defaultOwnerInstallationSettings()), stored?.revision ?? 0).document;
  }
  async deployPaused(projectId: string): Promise<boolean> { return this.projectSettings(projectId).deploy.paused; }
  async runId(projectId: string, jobRunId: string): Promise<string> { return this.ids.one(projectId, 'J', jobRunId); }

  /** Every steering act (bridge specification, "Steering record"), kept on the state point for the coordinator and the handoff. */
  steering(projectId: string, record: Pick<SteeringRecord, 'thread' | 'threadId' | 'kind' | 'by'> & { text?: string }): SteeringRecord {
    const id = newId('steering'); const document = SteeringRecordSchema.parse({ schema: 'steering-record-v1', id, projectId, at: this.now().toISOString(), deliveredToCoordinator: false, ...record });
    this.app.hub.put('owner-steering', id, SteeringRecordSchema, document, 0);
    // The coordinator is never surprised: each act reaches it as a line at its next turn.
    const lines = { say: `The owner told ${record.thread}: "${record.text ?? ''}".`, takeover: `The owner took over ${record.thread}. It is held until he hands it back.`, return: `The owner handed ${record.thread} back.`,
      stop: `The owner stopped ${record.thread}.`, auto_return: `Jevellan handed ${record.thread} back after the owner left it idle.` };
    void this.app.projectWork.steeringNote(projectId, record.threadId, lines[record.kind]).then(() => {
      const stored = this.app.hub.get('owner-steering', id, SteeringRecordSchema); if (stored) this.app.hub.put('owner-steering', id, SteeringRecordSchema, { ...stored.document, deliveredToCoordinator: true }, stored.revision);
    }).catch(() => undefined);
    return document;
  }
  steeringRecords(projectId: string): SteeringRecord[] { return this.app.hub.list('owner-steering', SteeringRecordSchema).map(row => row.document).filter(row => row.projectId === projectId).sort((a, b) => a.at.localeCompare(b.at)); }
  steeringBy(caller: string): SteeringRecord['by'] { return caller.startsWith('bridge:') ? 'bridge' : caller.startsWith('remote:') ? caller as SteeringRecord['by'] : caller === 'ui' ? 'ui' : 'cli'; }
  readonly takeover: OwnerTakeover;
  /** Replies to bridge messages are pushed (phase 4); until a push queue exists they stay in the event stream. */
  awaitCoordinatorReply(projectId: string, clientMessageId: string, context: { question?: string }): void { this.#awaiting.set(clientMessageId, { projectId, ...context }); }
  coordinatorReplyDelivered(clientMessageId: string): void { this.#awaiting.delete(clientMessageId); }
  readonly #awaiting = new Map<string, { projectId: string; question?: string }>();
  awaitingReplies(): ReadonlyMap<string, { projectId: string; question?: string }> { return this.#awaiting; }
  async latestHandoff(projectId: string): Promise<{ at: string; text: string } | null> {
    try {
      const context = await this.app.projectWork.journal?.handoffContext(projectId); const handoff = context?.handoff; if (!handoff) return null;
      return { at: handoff.at, text: [handoff.inFlight, handoff.pendingAsks, handoff.decisions].filter(Boolean).join(' ').replace(/\s+/gu, ' ') };
    } catch { return null; }
  }
  async missedSince(projectId: string, since: string): Promise<string> {
    const rows = this.app.ownerSchedules.missed(projectId, 30).filter(row => row.at >= since);
    return rows.length ? rows.map(row => `${row.items.join(', ')} on ${row.date} (${row.reason}${row.caughtUp ? '; caught up' : ''})`).join('; ') : 'none';
  }
  async missedNights(projectId: string, days: number): Promise<string[]> {
    const tz = (await this.app.projectWork.view(projectId)).settings.nightlyWindow.timezone; const now = this.now();
    return this.app.ownerSchedules.missed(projectId, days).map(row => `${ownerClock(`${row.date}T12:00:00.000Z`, now, tz).replace(/ \d\d:\d\d$/u, '')} night (${row.reason}${row.caughtUp ? `; caught up at ${ownerClock(row.at, now, tz)}` : '; ran the next night'})`);
  }
  nextInterval(interval: { everyMinutes: number; start: string; end: string }, lastStartedAt: string | null, tz: string): string { return this.app.ownerSchedules.nextInterval(interval, lastStartedAt, tz); }
  async overridesSince(projectId: string, since: string): Promise<number> {
    try { return (await this.app.projectHub.recentOverrides(projectId, 200)).filter(row => row.at >= since).length; } catch { return 0; }
  }

  /** A call refused before it ran (remote write switch, deploy refusal), logged like any other. */
  logRefusal(caller: string, tool: string, action: string, access: 'read' | 'write', args: Record<string, unknown>, errorCode: string): void {
    this.#log({ schema: 'caller-log-v1', at: this.now().toISOString(), caller, tool: OWNER_TOOLS.some(entry => entry.name === tool) ? tool as CallerLogEntry['tool'] : 'status', action: action.slice(0, 60), access,
      argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('hex'), ok: false, errorCode });
  }
  /** Whether `jobs run` names a project's deploy job (never run remotely). */
  async isDeployJob(args: Record<string, unknown>): Promise<boolean> {
    if (typeof args.job !== 'string') return false;
    for (const project of await this.projects()) {
      const settings = (await this.app.projectWork.view(project.id)).settings.deploy; const jobs = await this.app.projectWork.daily.jobs(project.id);
      const job = jobs.find(row => row.id === args.job || row.name.toLowerCase() === String(args.job).toLowerCase());
      if (job && (job.id === settings.jobId || job.id === settings.desktopJobId)) return true;
    }
    return /deploy|rollback/iu.test(args.job);
  }
  callerLog(): CallerLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).flatMap(line => { const parsed = CallerLogEntrySchema.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data] : []; });
  }

  /** The engine's status of a project, shared by the status tool, the status line and the UI. */
  async status(project: Project, goal?: string): Promise<ProjectStatusView> {
    const work = this.app.projectWork; const projectId = project.id;
    const [view, tasks, goals, daily, deploys, accounts, roster, coordinatorStop] = await Promise.all([
      work.view(projectId), work.taskList(projectId), work.goalList(projectId), work.daily.view(projectId), work.deploys.view(projectId), this.app.accounts.list(), this.app.roster(), work.coordinatorStop(projectId)]);
    const names = new Map(roster.devices.map(row => [row.device.id, row.device.name]));
    const budgets = accounts.filter(row => row.account.enabled !== false).map(row => {
      const usage = [...row.statuses].sort((a, b) => (b.usage?.observedAt ?? '').localeCompare(a.usage?.observedAt ?? ''))[0]?.usage;
      const used = usage ? Math.max(usage.weeklyPct ?? 0, usage.fiveHourPct ?? 0) : null;
      return { label: row.account.label, usedPercent: usage && (usage.weeklyPct !== undefined || usage.fiveHourPct !== undefined) ? used : null, budgetPercent: row.account.ceilingPct ?? 90 };
    });
    const view_ = projectStatus({ project: { id: projectId, name: project.name }, now: this.now(), settings: view.settings, coordinator: view.coordinator, coordinatorStalled: false, coordinatorStop,
      threads: view.threads, tasks: tasks.tasks, goals: goals.goals.map(row => row.goal), decisions: view.decisions.open, jobs: daily.jobs, dailies: daily.dailies, runs: daily.runs,
      windows: daily.window ? [daily.window] : [], deploys: deploys.records,
      budgets, deviceName: id => names.get(id) ?? id, deployPaused: this.projectSettings(projectId).deploy.paused, missedThisWeek: this.app.ownerSchedules.missed(projectId, 7).length, ...(goal ? { goalFilter: goal } : {}),
      holds: new Map(this.takeover.holds(projectId).map(hold => [hold.threadId, { since: hold.since, via: hold.via, tmuxSession: hold.tmuxSession }])),
      extraWaiting: this.takeover.holds(projectId).filter(hold => hold.warnedAt).map(hold => ({ schema: 'waiting-item-view-v1' as const, id: this.takeover.waitingId(hold), internalId: `held-${hold.threadId}`.slice(0, 128), kind: 'held_idle' as const,
        from: 'jevellan', text: `${hold.id} has been held with no activity since ${hold.keptAt ?? hold.since}.`, options: ['keep', 'return'], freeText: false, urgent: false, createdAt: hold.warnedAt!, updatedAt: hold.warnedAt!, state: 'open' as const })) }, this.ids);
    for (const run of [...view_.running, ...view_.queued, ...view_.landed, ...view_.finished]) if (run.kind === 'thread') this.app.ownerEvents.noteSource(run.internalId, run.id);
    return view_;
  }
  async statusText(project: Project, options: { goal?: string; section?: 'waiting' | 'running' | 'queued' | 'landed' | 'finished'; detail?: boolean }): Promise<string> {
    return renderStatus(await this.status(project, options.goal), options);
  }
  async statusLine(request: Pick<OwnerToolRequest, 'project' | 'cwd'>): Promise<string> {
    let project: Project;
    try { project = await this.resolveProject(request); } catch { return 'Jevellan · no project here'; }
    return renderStatusLine(await this.status(project));
  }
}

function invalidArguments(tool: OwnerToolDefinition, action: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join('.') || 'arguments';
  const name = action ? `${tool.name} ${action}` : tool.name;
  if (issue?.code === 'unrecognized_keys') return `${name} does not take ${issue.keys.join(', ')}.`;
  return `${name}: ${field} ${issue?.code === 'invalid_type' && issue.input === undefined ? 'is required' : `is not valid (${issue?.message ?? 'check it'})`}.`;
}
