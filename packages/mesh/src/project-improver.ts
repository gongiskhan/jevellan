import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  IdSchema, ImproverDeviceRequestSchema, ImproverDeviceWorkSchema, MemoryCareReportActionSchema, MemoryCareReportInputSchema, MemoryCareReportRowSchema, MemoryCareReportSchema,
  MemoryCareStateSchema, ProjectImproverLogSchema, ProjectPatchSchema, ProjectPreviewSchema, ProjectRevisionRecordSchema, ProjectSchema, ProjectSuggestionActionSchema,
  ProjectSuggestionInputSchema, ProjectSuggestionRowSchema, ProjectSuggestionSchema, ProjectTaskResultSchema, ProjectTaskSchema, TimestampSchema, stableJson, unifiedDiff,
  type DeviceView, type ImproverDeviceWork, type ImproverJob, type ImproverJobScope, type ImproverSettings, type MemoryCareReportAction, type MemoryCareReportInput, type MemoryCareReportRow,
  type MemoryCareState, type ProjectImproverLog, type ProjectPatch, type ProjectPreview, type ProjectRevisionRecord, type Project, type ProjectSuggestion, type ProjectSuggestionAction,
  type ProjectSuggestionInput, type ProjectSuggestionRow, type ProjectTask, type ProjectTaskResult,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';
import { ImproverJobs, dueImproverDate } from './improver-jobs.js';

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
function conflict(message = 'This suggestion changed. Reload it before deciding.'): never { throw Object.assign(new Error(message), { status: 409 }); }
function missing(message: string): never { throw Object.assign(new Error(message), { status: 404 }); }
const ManualCycleSchema = z.strictObject({ schema: z.literal('improver-manual-cycle-v1'), id: IdSchema, deviceId: IdSchema, requestedAt: TimestampSchema,
  jobs: z.array(z.strictObject({ kind: z.enum(['memory', 'context']), projectId: IdSchema })) });
const ReceiptSchema = z.strictObject({ schema: z.literal('project-improver-receipt-v1'), deviceId: IdSchema, requestId: IdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.union([ProjectSuggestionRowSchema, MemoryCareReportRowSchema]) });
const UNDO_WINDOW_MS = 30_000;
const MANUAL_CYCLE_MS = 86400_000;
export const RECENT_DECISIONS_MS = 7 * 86400_000;

/** Recomputes a patch diff and checks every recorded file hash, so no device-supplied summary is trusted. */
export function checkedPatch(raw: ProjectPatch): ProjectPatch {
  const patch = ProjectPatchSchema.parse(raw);
  for (const file of patch.files) if (file.beforeText !== null && hash(file.beforeText) !== file.before) conflict('The patch does not match the files it was computed from.');
  return ProjectPatchSchema.parse({ ...patch, diff: patch.files.map(file => unifiedDiff(file.path, file.beforeText, file.after)).join('').slice(0, 1_000_000) });
}
/** Only memory care edits memory notes, and only context edits instruction files. */
function assertPatchScope(kind: ProjectSuggestion['kind'], project: Project, patch: ProjectPatch): void {
  const memory = `${project.memory.dir.replace(/\/+$/, '')}/`;
  const allowed = kind === 'memory-care' ? (path: string) => path.startsWith(memory) && /\.(?:md|markdown)$/i.test(path) : (path: string) => path === 'AGENTS.md' || path === 'CLAUDE.md';
  if (!patch.files.every(file => allowed(file.path))) conflict(kind === 'memory-care' ? 'Memory care may only change notes in the memory folder.' : 'Context suggestions may only change the instruction file.');
}

type Options = { devices(): DeviceView[]; hubId: string; now?: () => number };
/** Hub authority for per-project improver work; checkout changes always run on the device that has the checkout. */
export class ProjectImproverHub {
  readonly jobs: ImproverJobs;
  readonly #now: () => number;
  constructor(readonly hub: HubDatabase, readonly options: Options) {
    this.#now = options.now ?? Date.now; this.jobs = new ImproverJobs(hub, this.#now); IdSchema.parse(options.hubId);
  }
  #at(offset = 0) { return new Date(this.#now() + offset).toISOString(); }
  settings(): ImproverSettings { return this.hub.configuration.current()!.configuration['x-jevellan'].improver; }
  projects(): Project[] { return this.hub.list('projects', ProjectSchema).map(row => row.document); }
  project(id: string): Project { return this.hub.get('projects', IdSchema.parse(id), ProjectSchema)?.document ?? missing('Project not found.'); }
  memorySelected(project: Project, settings = this.settings()): boolean { return settings.memory.projects[project.id] !== false; }
  /** The hub when it has the checkout, otherwise the first online device that does. */
  designated(project: Project): string | null {
    const allowed = (id: string) => !!project.paths[id] && (!project.allowedDevices || project.allowedDevices.includes(id));
    if (allowed(this.options.hubId)) return this.options.hubId;
    return this.options.devices().filter(view => view.status === 'online' && !view.revoked && allowed(view.device.id))
      .sort((a, b) => a.device.joinedAt.localeCompare(b.device.joinedAt) || a.device.id.localeCompare(b.device.id))[0]?.device.id ?? null;
  }
  requestRun(cycleId: string, deviceId: string): string {
    const existing = this.hub.get('improver-manual-cycles', cycleId, ManualCycleSchema);
    // A manual run covers the jobs enabled when it was requested; enabling a job later does not replay earlier runs.
    if (!existing) this.hub.put('improver-manual-cycles', cycleId, ManualCycleSchema, { schema: 'improver-manual-cycle-v1', id: cycleId, deviceId, requestedAt: this.#at(), jobs: this.plannedJobs() }, 0);
    return existing?.document.requestedAt ?? this.hub.get('improver-manual-cycles', cycleId, ManualCycleSchema)!.document.requestedAt;
  }
  /** Project jobs a manual run asked for, for the run receipt. */
  plannedJobs(settings = this.settings()): Array<{ kind: 'memory' | 'context'; projectId: string }> {
    return this.projects().flatMap(project => [
      ...(settings.memory.enabled && this.memorySelected(project, settings) ? [{ kind: 'memory' as const, projectId: project.id }] : []),
      ...(settings.context.enabled ? [{ kind: 'context' as const, projectId: project.id }] : []),
    ]);
  }
  /** Due cycles, each with the project jobs it may run (null: whatever is enabled now). */
  cycles(settings = this.settings()): Array<{ cycle: ImproverJobScope['cycle']; jobs: Set<string> | null }> {
    const date = dueImproverDate(settings, new Date(this.#now()));
    const manual = this.hub.list('improver-manual-cycles', ManualCycleSchema).map(row => row.document).filter(cycle => Date.parse(cycle.requestedAt) >= this.#now() - MANUAL_CYCLE_MS)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return [...(date ? [{ cycle: { kind: 'nightly' as const, date }, jobs: null }] : []),
      ...manual.map(cycle => ({ cycle: { kind: 'manual' as const, id: cycle.id }, jobs: new Set(cycle.jobs.map(job => `${job.kind}\0${job.projectId}`)) }))];
  }
  #job(scope: ImproverJobScope): ImproverJob | null { return this.jobs.list().find(job => stableJson(job.scope) === stableJson(scope)) ?? null; }

  /** Hands out due jobs and queued checkout tasks for exactly one device. */
  poll(deviceId: string, startedAt: string): ImproverDeviceWork {
    IdSchema.parse(deviceId); const settings = this.settings();
    this.#recoverTasks(deviceId, startedAt);
    const jobs: ImproverJob[] = [];
    for (const { cycle, jobs: planned } of this.cycles(settings)) for (const project of this.projects()) {
      if (this.designated(project) !== deviceId) continue;
      const allowed = (kind: 'memory' | 'context') => !planned || planned.has(`${kind}\0${project.id}`);
      const memory = settings.memory.enabled && this.memorySelected(project, settings) && allowed('memory');
      if (memory) { const claim = this.jobs.claim({ kind: 'memory', projectId: project.id, cycle }, deviceId); if (claim.claimed) jobs.push(claim.job); }
      if (!settings.context.enabled || !allowed('context')) continue;
      // Context suggestions read the notes that memory care leaves behind.
      const care = memory ? this.#job({ kind: 'memory', projectId: project.id, cycle }) : null;
      if (memory && (!care || care.status === 'running')) continue;
      const claim = this.jobs.claim({ kind: 'context', projectId: project.id, cycle }, deviceId); if (claim.claimed) jobs.push(claim.job);
    }
    const tasks: ImproverDeviceWork['tasks'] = [];
    for (const row of this.hub.list('project-suggestions', ProjectSuggestionSchema)) {
      const suggestion = row.document;
      if (suggestion.deviceId !== deviceId || suggestion.status !== 'recompute' || this.#tasks().some(task => task.targetId === suggestion.id && ['queued', 'running'].includes(task.status))) continue;
      this.#createTask({ deviceId, projectId: suggestion.projectId, kind: 'recompute', targetId: suggestion.id, targetRevision: row.revision, previewId: null, requestedBy: deviceId });
    }
    for (const task of this.#tasks().filter(value => value.deviceId === deviceId && value.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = this.#saveTask({ ...task, status: 'running', updatedAt: this.#at() });
      tasks.push({ task: running, suggestion: task.kind === 'undo-report' ? null : this.get(task.targetId), report: task.kind === 'undo-report' ? this.report(task.targetId) : null,
        preview: task.previewId ? this.hub.get('project-previews', task.previewId, ProjectPreviewSchema)?.document ?? null : null });
    }
    const projects = new Set([...jobs.map(job => job.scope.projectId!), ...tasks.map(entry => entry.task.projectId)]);
    const knownKeys = Object.fromEntries([...projects].map(id => [id, [...new Set(this.list().filter(row => row.suggestion.projectId === id && row.suggestion.status !== 'expired').map(row => row.suggestion.suppressionKey))]]));
    const open = Object.fromEntries([...projects].map(id => [id, [...new Set(this.list().filter(row => row.suggestion.projectId === id && ['pending', 'applying', 'recompute', 'undoing'].includes(row.suggestion.status)).map(row => row.suggestion.kind))]]));
    return ImproverDeviceWorkSchema.parse({ schema: 'improver-device-work-v1', settings, jobs, tasks, knownKeys, open });
  }
  /** A task still running when its device restarted never resumes silently. */
  #recoverTasks(deviceId: string, startedAt: string): void {
    for (const task of this.#tasks()) {
      if (task.deviceId !== deviceId || task.status !== 'running' || task.updatedAt >= startedAt) continue;
      this.taskResult(deviceId, task.id, { kind: 'failed', note: 'Jevellan restarted while this ran. Check the project, then retry.' });
    }
  }
  #tasks(): ProjectTask[] { return this.hub.list('project-tasks', ProjectTaskSchema).map(row => row.document); }
  task(id: string): ProjectTask | null { return this.hub.get('project-tasks', id, ProjectTaskSchema)?.document ?? null; }
  #createTask(input: Pick<ProjectTask, 'deviceId' | 'projectId' | 'kind' | 'targetId' | 'targetRevision' | 'previewId' | 'requestedBy'>): ProjectTask {
    const id = `task_${hash([input, this.#now(), this.#tasks().length])}`;
    return this.hub.put('project-tasks', id, ProjectTaskSchema, { schema: 'project-improver-task-v1', id, ...input, status: 'queued', createdAt: this.#at(), updatedAt: this.#at(), note: '' }, 0).document;
  }
  #saveTask(task: ProjectTask): ProjectTask {
    const row = this.hub.get('project-tasks', task.id, ProjectTaskSchema)!; return this.hub.put('project-tasks', task.id, ProjectTaskSchema, task, row.revision).document;
  }

  get(id: string): ProjectSuggestionRow | null {
    const row = this.hub.get('project-suggestions', IdSchema.parse(id), ProjectSuggestionSchema);
    return row ? ProjectSuggestionRowSchema.parse({ schema: 'project-suggestion-row-v1', revision: row.revision, suggestion: row.document }) : null;
  }
  list(): ProjectSuggestionRow[] { return this.hub.list('project-suggestions', ProjectSuggestionSchema).map(row => ProjectSuggestionRowSchema.parse({ schema: 'project-suggestion-row-v1', revision: row.revision, suggestion: row.document })); }
  visible(): ProjectSuggestionRow[] {
    const since = this.#now() - RECENT_DECISIONS_MS;
    return this.list().filter(row => ['pending', 'applying', 'recompute', 'undoing'].includes(row.suggestion.status) || Date.parse(row.suggestion.updatedAt) >= since)
      .sort((a, b) => b.suggestion.createdAt.localeCompare(a.suggestion.createdAt) || a.suggestion.id.localeCompare(b.suggestion.id));
  }
  #save(suggestion: ProjectSuggestion, revision: number): ProjectSuggestionRow {
    const saved = this.hub.put('project-suggestions', suggestion.id, ProjectSuggestionSchema, suggestion, revision);
    return ProjectSuggestionRowSchema.parse({ schema: 'project-suggestion-row-v1', revision: saved.revision, suggestion: saved.document });
  }
  #checkedInput(raw: ProjectSuggestionInput) {
    const input = ProjectSuggestionInputSchema.parse(raw); const project = this.project(input.projectId);
    const patch = checkedPatch(input.patch); assertPatchScope(input.kind, project, patch);
    if ((input.kind === 'memory-care') !== (input.counts !== null)) conflict('Only memory care suggestions carry counts.');
    return { ...input, patch };
  }
  /** Device-produced suggestions are bound to the job that computed them. */
  suggest(deviceId: string, job: ImproverJob, raw: ProjectSuggestionInput): ProjectSuggestionRow {
    return this.hub.transaction(() => {
      const current = this.jobs.assertOwned(job); const input = this.#checkedInput(raw);
      if (current.deviceId !== deviceId || current.scope.projectId !== input.projectId || (current.scope.kind === 'memory') !== (input.kind === 'memory-care') || current.scope.kind === 'routing') conflict('This suggestion belongs to another job.');
      const existing = this.get(input.id); if (existing) { if (existing.suggestion.jobId !== current.id) conflict('This suggestion identifier belongs to another job.'); return existing; }
      const same = this.list().find(row => row.suggestion.projectId === input.projectId && row.suggestion.suppressionKey === input.suppressionKey && row.suggestion.status !== 'expired');
      if (same) return same;
      const at = this.#at();
      return this.#save(ProjectSuggestionSchema.parse({ ...input, schema: 'project-suggestion-v1', deviceId, jobId: current.id, status: 'pending', error: null, outcomes: [], applied: null, createdAt: at, updatedAt: at }), 0);
    });
  }
  act(id: string, raw: ProjectSuggestionAction, deviceId: string): ProjectSuggestionRow {
    const request = ProjectSuggestionActionSchema.parse(raw); IdSchema.parse(deviceId);
    return this.#receipt(deviceId, request.clientRequestId, { id, request }, () => {
      const row = this.get(id); if (!row || row.revision !== request.revision) conflict();
      const suggestion = structuredClone(row.suggestion); const at = this.#at();
      if (request.kind === 'dismiss') {
        if (!['pending', 'recompute', 'expired'].includes(suggestion.status)) conflict();
        suggestion.status = 'dismissed'; suggestion.error = null;
        suggestion.outcomes.push({ schema: 'project-suggestion-outcome-v1', kind: 'dismissed', at, deviceId, reason: request.reason, commit: null });
      } else if (request.kind === 'undo') {
        if (suggestion.status !== 'applied' || !suggestion.applied) conflict();
        if (Date.parse(suggestion.applied.undoUntil) <= this.#now()) conflict('The 30-second Undo window has ended.');
        suggestion.status = 'undoing'; suggestion.error = null;
        this.#createTask({ deviceId: suggestion.deviceId, projectId: suggestion.projectId, kind: 'undo', targetId: id, targetRevision: row.revision + 1, previewId: null, requestedBy: deviceId });
      } else {
        if (suggestion.status !== 'pending') conflict();
        if (request.previewId) {
          const preview = this.hub.get('project-previews', request.previewId, ProjectPreviewSchema)?.document;
          if (!preview || preview.suggestionId !== id || preview.suggestionRevision !== row.revision) conflict('This revised change is no longer current.');
        }
        suggestion.status = 'applying'; suggestion.error = null;
        this.#createTask({ deviceId: suggestion.deviceId, projectId: suggestion.projectId, kind: 'apply', targetId: id, targetRevision: row.revision + 1, previewId: request.previewId, requestedBy: deviceId });
      }
      suggestion.updatedAt = at; return this.#save(suggestion, row.revision);
    }) as ProjectSuggestionRow;
  }
  #receipt(deviceId: string, requestId: string, body: unknown, run: () => ProjectSuggestionRow | MemoryCareReportRow): ProjectSuggestionRow | MemoryCareReportRow {
    const receiptId = hash([deviceId, requestId]); const fingerprint = hash(body);
    return this.hub.transaction(() => {
      const receipt = this.hub.get('project-receipts', receiptId, ReceiptSchema)?.document;
      if (receipt) { if (receipt.deviceId !== deviceId || receipt.requestId !== requestId || receipt.fingerprint !== fingerprint) conflict('This request identifier was used for another decision.'); return receipt.result; }
      const result = run();
      this.hub.put('project-receipts', receiptId, ReceiptSchema, { schema: 'project-improver-receipt-v1', deviceId, requestId, fingerprint, result }, 0);
      return result;
    });
  }

  /** Task results come only from the device the task was assigned to. */
  taskResult(deviceId: string, taskId: string, raw: ProjectTaskResult): ProjectTask {
    const result = ProjectTaskResultSchema.parse(raw);
    return this.hub.transaction(() => {
      const task = this.task(taskId) ?? missing('Improver task not found.');
      if (task.deviceId !== deviceId) conflict('This task belongs to another device.');
      if (task.status !== 'running') conflict('This task is not running.');
      const now = this.#now(); const at = new Date(now).toISOString(); const note = 'note' in result ? result.note : '';
      if (task.kind === 'undo-report') {
        const row = this.hub.get('memory-care-reports', task.targetId, MemoryCareReportSchema)!; const report = structuredClone(row.document);
        if (result.kind === 'undone') Object.assign(report, { status: 'undone', undoCommit: result.commit, undoneAt: at, error: null });
        else if (result.kind === 'failed') Object.assign(report, { status: 'applied', error: result.note });
        else conflict('This result does not belong to an undo.');
        this.hub.put('memory-care-reports', report.id, MemoryCareReportSchema, report, row.revision);
      } else {
        const row = this.get(task.targetId) ?? missing('Suggestion not found.'); const suggestion = structuredClone(row.suggestion);
        const project = this.project(suggestion.projectId);
        if (result.kind === 'applied') {
          if (task.kind !== 'apply' || suggestion.status !== 'applying') conflict('This suggestion is not being applied.');
          const preview = task.previewId ? this.hub.get('project-previews', task.previewId, ProjectPreviewSchema)!.document : null;
          if (preview) Object.assign(suggestion, { title: preview.title, reason: preview.reason, patch: preview.patch });
          suggestion.status = 'applied'; suggestion.error = null;
          suggestion.applied = { commit: result.commit, published: result.published, at, undoUntil: new Date(now + UNDO_WINDOW_MS).toISOString(), patch: suggestion.patch };
          suggestion.outcomes.push({ schema: 'project-suggestion-outcome-v1', kind: preview && stableJson(preview.patch.files) !== stableJson(row.suggestion.patch.files) ? 'applied-after-change' : 'applied', at, deviceId, reason: null, commit: result.commit });
        } else if (result.kind === 'undone') {
          if (task.kind !== 'undo' || suggestion.status !== 'undoing') conflict('This suggestion is not being undone.');
          suggestion.status = 'undone'; suggestion.error = null;
          suggestion.outcomes.push({ schema: 'project-suggestion-outcome-v1', kind: 'undone', at, deviceId, reason: null, commit: result.commit });
        } else if (result.kind === 'stale') {
          if (!['applying', 'recompute'].includes(suggestion.status)) conflict('This suggestion is not being applied.');
          suggestion.status = 'recompute'; suggestion.error = result.note;
        } else if (result.kind === 'recomputed') {
          if (!['applying', 'recompute'].includes(suggestion.status)) conflict('This suggestion is not being recomputed.');
          const input = this.#checkedInput(result.suggestion);
          if (input.kind !== suggestion.kind || input.projectId !== suggestion.projectId || input.id !== suggestion.id) conflict('The recomputed suggestion belongs to another suggestion.');
          assertPatchScope(suggestion.kind, project, input.patch);
          Object.assign(suggestion, { title: input.title, reason: input.reason, evidence: input.evidence, counts: input.counts, patch: input.patch, suppressionKey: input.suppressionKey,
            status: 'pending', error: 'The files changed since this suggestion was made, so it was recomputed. Review it again.' });
        } else if (result.kind === 'expired') {
          if (!['applying', 'recompute'].includes(suggestion.status)) conflict('This suggestion is not being recomputed.');
          suggestion.status = 'expired'; suggestion.error = result.note;
        } else {
          suggestion.error = result.note;
          if (suggestion.status === 'applying') suggestion.status = 'pending';
          else if (suggestion.status === 'undoing') suggestion.status = 'applied';
          else if (suggestion.status === 'recompute') suggestion.status = 'expired';
        }
        suggestion.updatedAt = at; this.#save(suggestion, row.revision);
      }
      const finished = result.kind !== 'stale';
      return this.#saveTask({ ...task, status: finished ? result.kind === 'failed' ? 'failed' : 'complete' : 'running', updatedAt: at, note: note.slice(0, 1200) });
    });
  }

  report(id: string): MemoryCareReportRow | null {
    const row = this.hub.get('memory-care-reports', IdSchema.parse(id), MemoryCareReportSchema);
    return row ? MemoryCareReportRowSchema.parse({ schema: 'memory-care-report-row-v1', revision: row.revision, report: row.document }) : null;
  }
  reports(): MemoryCareReportRow[] {
    const since = this.#now() - RECENT_DECISIONS_MS;
    return this.hub.list('memory-care-reports', MemoryCareReportSchema).filter(row => Date.parse(row.document.at) >= since || row.document.status === 'undoing')
      .map(row => MemoryCareReportRowSchema.parse({ schema: 'memory-care-report-row-v1', revision: row.revision, report: row.document })).sort((a, b) => b.report.at.localeCompare(a.report.at));
  }
  putReport(deviceId: string, job: ImproverJob, raw: MemoryCareReportInput): MemoryCareReportRow {
    return this.hub.transaction(() => {
      const current = this.jobs.assertOwned(job); const input = MemoryCareReportInputSchema.parse(raw); const project = this.project(input.projectId);
      if (current.deviceId !== deviceId || current.scope.kind !== 'memory' || current.scope.projectId !== input.projectId) conflict('This report belongs to another job.');
      const patch = checkedPatch(input.patch); assertPatchScope('memory-care', project, patch);
      const existing = this.report(current.id); if (existing) return existing;
      const report = MemoryCareReportSchema.parse({ schema: 'memory-care-report-v1', id: current.id, jobId: current.id, projectId: input.projectId, projectName: input.projectName, deviceId,
        counts: input.counts, evidence: input.evidence, patch, commit: input.commit, published: input.published, at: this.#at(), status: 'applied', error: null, undoCommit: null, undoneAt: null });
      const saved = this.hub.put('memory-care-reports', report.id, MemoryCareReportSchema, report, 0);
      return MemoryCareReportRowSchema.parse({ schema: 'memory-care-report-row-v1', revision: saved.revision, report: saved.document });
    });
  }
  actReport(id: string, raw: MemoryCareReportAction, deviceId: string): MemoryCareReportRow {
    const request = MemoryCareReportActionSchema.parse(raw); IdSchema.parse(deviceId);
    return this.#receipt(deviceId, request.clientRequestId, { id, request }, () => {
      const row = this.hub.get('memory-care-reports', IdSchema.parse(id), MemoryCareReportSchema);
      if (!row || row.revision !== request.revision) conflict('This memory care result changed. Reload it before undoing.');
      if (row.document.status !== 'applied') conflict('This memory care result is not applied.');
      this.#createTask({ deviceId: row.document.deviceId, projectId: row.document.projectId, kind: 'undo-report', targetId: id, targetRevision: row.revision + 1, previewId: null, requestedBy: deviceId });
      const saved = this.hub.put('memory-care-reports', id, MemoryCareReportSchema, { ...row.document, status: 'undoing', error: null }, row.revision);
      return MemoryCareReportRowSchema.parse({ schema: 'memory-care-report-row-v1', revision: saved.revision, report: saved.document });
    }) as MemoryCareReportRow;
  }

  preview(preview: ProjectPreview): ProjectPreview {
    return this.hub.transaction(() => {
      const value = ProjectPreviewSchema.parse(preview); const row = this.get(value.suggestionId);
      if (!row || row.revision !== value.suggestionRevision || row.suggestion.status !== 'pending') conflict();
      const patch = checkedPatch(value.patch); assertPatchScope(row.suggestion.kind, this.project(row.suggestion.projectId), patch);
      const original = new Map(row.suggestion.patch.files.map(file => [file.path, file]));
      if (patch.files.some(file => { const source = original.get(file.path); return !source || source.before !== file.before || source.after === null && file.after !== null; })) conflict('Change it may only revise files this suggestion already changes.');
      const existing = this.hub.get('project-previews', value.id, ProjectPreviewSchema);
      if (existing) { if (stableJson({ ...existing.document, createdAt: value.createdAt }) !== stableJson({ ...value, patch })) conflict('This preview request already contains another change.'); return existing.document; }
      return this.hub.put('project-previews', value.id, ProjectPreviewSchema, { ...value, patch }, 0).document;
    });
  }
  revision(id: string): ProjectRevisionRecord | null { return this.hub.get('project-revisions', IdSchema.parse(id), ProjectRevisionRecordSchema)?.document ?? null; }
  revisions(): ProjectRevisionRecord[] {
    return this.hub.list('project-revisions', ProjectRevisionRecordSchema).map(row => row.document)
      .filter(value => value.status === 'running' || Date.parse(value.finishedAt!) >= this.#now() - RECENT_DECISIONS_MS).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  putRevision(record: ProjectRevisionRecord): ProjectRevisionRecord {
    const previous = this.hub.get('project-revisions', record.id, ProjectRevisionRecordSchema);
    return this.hub.put('project-revisions', record.id, ProjectRevisionRecordSchema, record, previous?.revision ?? 0).document;
  }

  careState(projectId: string): MemoryCareState | null { return this.hub.get('memory-care-states', IdSchema.parse(projectId), MemoryCareStateSchema)?.document ?? null; }
  finish(deviceId: string, job: ImproverJob, status: 'complete' | 'skipped' | 'failed', note: string, careState: MemoryCareState | null): ImproverJob {
    return this.hub.transaction(() => {
      const current = this.jobs.assertOwned(job); if (current.deviceId !== deviceId || current.scope.kind === 'routing') conflict('This job belongs to another device.');
      if (careState) {
        const state = MemoryCareStateSchema.parse(careState);
        if (current.scope.kind !== 'memory' || state.projectId !== current.scope.projectId || state.deviceId !== deviceId) conflict('This memory care state belongs to another job.');
        const previous = this.hub.get('memory-care-states', state.projectId, MemoryCareStateSchema);
        this.hub.put('memory-care-states', state.projectId, MemoryCareStateSchema, state, previous?.revision ?? 0);
      }
      return this.jobs.finish(current, status, this.hub.redactor.text(note).slice(0, 1200));
    });
  }
  log(jobId: string): ProjectImproverLog | null { return this.hub.get('project-improver-logs', IdSchema.parse(jobId), ProjectImproverLogSchema)?.document ?? null; }
  note(deviceId: string, job: ImproverJob, stage: ProjectImproverLog['entries'][number]['stage'], note: string): void {
    this.hub.transaction(() => {
      const current = this.jobs.assertOwned(job); if (current.deviceId !== deviceId) conflict('This job belongs to another device.');
      const previous = this.hub.get('project-improver-logs', current.id, ProjectImproverLogSchema);
      const document = previous?.document ?? { schema: 'project-improver-log-v1' as const, jobId: current.id, startedAt: current.startedAt, entries: [] };
      document.entries.push({ at: this.#at(), stage, note: this.hub.redactor.text(note).slice(0, 1200) });
      this.hub.put('project-improver-logs', current.id, ProjectImproverLogSchema, document, previous?.revision ?? 0);
    });
  }

  /** The device-authenticated protocol; the caller has already authenticated deviceId. */
  request(deviceId: string, raw: unknown) {
    const request = ImproverDeviceRequestSchema.parse(raw);
    switch (request.operation) {
      case 'poll': return this.poll(deviceId, request.startedAt);
      case 'renew': { const current = this.jobs.assertOwned(request.job); if (current.deviceId !== deviceId) conflict('This job belongs to another device.'); return this.jobs.renew(current); }
      case 'finish': return this.finish(deviceId, request.job, request.status, request.note, request.careState);
      case 'log': this.note(deviceId, request.job, request.stage, request.note); return { schema: 'improver-device-ack-v1' as const };
      case 'care-state': return { schema: 'memory-care-state-result-v1' as const, state: this.careState(request.projectId) };
      case 'suggest': return this.suggest(deviceId, request.job, request.suggestion);
      case 'report': return this.putReport(deviceId, request.job, request.report);
      case 'task-result': return this.taskResult(deviceId, request.taskId, request.result);
    }
  }
}
