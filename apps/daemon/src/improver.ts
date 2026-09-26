import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BackgroundDraftResultSchema, IdSchema, ImproverLastRunSchema, ImproverNoticeSchema, ImproverRunSchema, ImproverStateSchema, ImproverSummarySchema, ProjectPreviewSchema,
  ProjectRevisionDraftSchema, ProjectRevisionRecordSchema, TimestampSchema, TrialLogSchema, stableJson,
  type ConversationIndex, type ImproverRequest, type ImproverResult, type ImproverState, type ProjectPatch, type ProjectRevisionRecord, type ProjectRevisionRequest, type TrialLog,
} from '@jevellan/core';
import { HubIndexes, type ProjectImproverHub } from '@jevellan/mesh';
import { patchFile, projectPatch } from '@jevellan/memory';
import { RoutingImprover, type RoutingImproverOptions } from './routing-improver.js';
import { projectCard, sortCards } from './improver-cards.js';

const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
function conflict(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }
const NoticeSeenSchema = z.strictObject({ schema: z.literal('improver-notice-seen-v1'), at: TimestampSchema });
const TRIAL_WEEKS = 12;

function weekStart(at: string): string {
  const date = new Date(at); const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)).toISOString().slice(0, 10);
}
/**
 * Conversations finished in Jevellan are done without an outside outcome; the week is their last update.
 * Conversations marked "Finished outside Jevellan" count in the week of that answer, with its reason.
 */
export function trialLog(conversations: ConversationIndex[], now = Date.now()): TrialLog {
  const weeks = new Map<string, TrialLog['weeks'][number]>();
  const week = (at: string) => { const key = weekStart(at); const value = weeks.get(key) ?? { weekStart: key, inJevellan: 0, outside: 0, reasons: [] }; weeks.set(key, value); return value; };
  for (const conversation of conversations) {
    if (conversation.outcome?.kind === 'finished-elsewhere') {
      const entry = week(conversation.outcome.at); entry.outside++;
      entry.reasons.push({ conversationId: conversation.id, title: conversation.title, projectId: conversation.projectId, at: conversation.outcome.at, reason: conversation.outcome.reason ?? null });
    } else if (conversation.state === 'done') week(conversation.updatedAt).inJevellan++;
  }
  const oldest = weekStart(new Date(now - (TRIAL_WEEKS - 1) * 7 * 86400_000).toISOString());
  return TrialLogSchema.parse({ schema: 'trial-log-v1', weeks: [...weeks.values()].filter(entry => entry.weekStart >= oldest).sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    .map(entry => ({ ...entry, reasons: entry.reasons.sort((a, b) => b.at.localeCompare(a.at)) })) });
}

type Options = RoutingImproverOptions & { projects: ProjectImproverHub; kick(): void };
/** The hub's single improver authority: routing, project jobs, cards, notices and the trial log. */
export class Improver extends RoutingImprover {
  readonly projects: ProjectImproverHub;
  readonly #revisions = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  readonly #kick: () => void;
  #stopped = false;
  constructor(options: Options) {
    super(options); this.projects = options.projects; this.#kick = options.kick;
    const recovered = this.revisions.ready.then(() => {
      for (const record of this.projects.revisions()) if (record.status === 'running') this.projects.putRevision({ ...record, status: 'failed', finishedAt: new Date().toISOString(), error: 'This request was interrupted. Review the current suggestion and try again.' });
    });
    void recovered.catch(() => undefined);
  }
  override state(): ImproverState {
    const base = super.state(); const projectSuggestions = this.projects.visible(); const reports = this.projects.reports();
    return ImproverStateSchema.parse({ ...base, cards: sortCards([...base.cards, ...projectSuggestions.map(row => projectCard(row))]), projectSuggestions, projectRevisions: this.projects.revisions(), reports, lastRuns: this.#lastRuns(),
      trialLog: trialLog(new HubIndexes(this.options.hub, this.options.deviceId).conversations()), ...this.#summary() });
  }
  #summary() {
    const routing = this.suggestions.list().filter(row => ['pending', 'recompute'].includes(row.suggestion.status));
    const projects = this.projects.list().filter(row => ['pending', 'recompute'].includes(row.suggestion.status));
    return { pending: routing.length + projects.length, notice: this.#notice() };
  }
  /** One quiet line per kind of news since the list last showed it. */
  #notice() {
    const seen = this.options.hub.get('improver-notice', 'seen', NoticeSeenSchema)?.document.at ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    const fresh = [
      ...this.suggestions.list().filter(row => row.suggestion.status === 'pending' && row.suggestion.createdAt > seen).map(row => row.suggestion.id),
      ...this.projects.list().filter(row => row.suggestion.status === 'pending' && row.suggestion.createdAt > seen).map(row => row.suggestion.id),
    ];
    const reports = this.projects.reports().filter(row => row.report.status === 'applied' && row.report.at > seen);
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const lines = [
      ...fresh.length ? [`${plural(fresh.length, 'new suggestion', 'new suggestions')} from the improver`] : [],
      ...reports.map(({ report }) => `Memory care for ${report.projectName}: merged ${plural(report.counts.merged, 'note', 'notes')}, archived ${report.counts.archived}, fixed ${plural(report.counts.fixedLinks, 'link', 'links')}.`),
    ];
    return lines.length ? ImproverNoticeSchema.parse({ schema: 'improver-notice-v1', id: hash({ fresh, reports: reports.map(row => row.report.id), lines }), lines: lines.slice(0, 20) }) : null;
  }
  #lastRuns() {
    const settings = this.options.hub.configuration.current()!.configuration['x-jevellan'].improver;
    const jobs = this.jobs.list().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const commit = (jobId: string) => this.projects.report(jobId)?.report.commit ?? this.projects.list().find(row => row.suggestion.jobId === jobId && row.suggestion.applied?.commit)?.suggestion.applied!.commit ?? null;
    const row = (kind: 'routing' | 'memory' | 'context', project: { id: string; name: string } | null) => {
      const job = jobs.find(value => value.scope.kind === kind && value.scope.projectId === (project?.id ?? null));
      if (job) return ImproverLastRunSchema.parse({ kind, projectId: project?.id ?? null, projectName: project?.name ?? null, jobId: job.id, deviceId: job.deviceId, status: job.status, at: job.finishedAt ?? job.startedAt, result: job.note || (job.status === 'running' ? 'Running.' : ''), commit: job.status === 'complete' ? commit(job.id) : null });
      const waiting = project && !this.projects.designated(this.projects.project(project.id));
      return ImproverLastRunSchema.parse({ kind, projectId: project?.id ?? null, projectName: project?.name ?? null, jobId: null, deviceId: null, status: 'waiting', at: null, result: waiting ? `Waiting for a device with ${project.name} to come online.` : 'Not run yet.', commit: null });
    };
    return [
      ...settings.routing.enabled ? [row('routing', null)] : [],
      ...this.projects.projects().flatMap(project => [
        ...settings.memory.enabled && this.projects.memorySelected(project, settings) ? [row('memory', project)] : [],
        ...settings.context.enabled ? [row('context', project)] : [],
      ]),
    ];
  }
  protected override async handle(request: ImproverRequest, deviceId: string): Promise<ImproverResult> {
    if (this.#stopped) throw Object.assign(new Error('The improver is stopping.'), { status: 503 });
    switch (request.operation) {
      case 'summary': return ImproverSummarySchema.parse({ schema: 'improver-summary-v1', ...this.#summary() });
      case 'notice-seen': {
        const notice = this.#notice();
        if (notice?.id === request.id) {
          const previous = this.options.hub.get('improver-notice', 'seen', NoticeSeenSchema);
          this.options.hub.put('improver-notice', 'seen', NoticeSeenSchema, { schema: 'improver-notice-seen-v1', at: new Date().toISOString() }, previous?.revision ?? 0);
        }
        return ImproverSummarySchema.parse({ schema: 'improver-summary-v1', ...this.#summary() });
      }
      case 'run-now': {
        const id = hash([deviceId, request.clientRequestId]); const settings = this.options.hub.configuration.current()!.configuration['x-jevellan'].improver;
        const routing = settings.routing.enabled ? this.view(await this.run({ kind: 'manual', id })) : null;
        const requestedAt = this.projects.requestRun(id, deviceId); this.#kick();
        return ImproverRunSchema.parse({ schema: 'improver-run-v1', id, requestedAt, routing, projects: this.projects.plannedJobs(settings) });
      }
      case 'log': return this.projects.log(request.jobId) ?? super.handle(request, deviceId);
      case 'revision': return this.projects.revision(request.id) ?? super.handle(request, deviceId);
      case 'revise': return request.input.schema === 'project-revision-request-v1' ? this.#revise(request.input, deviceId) : super.handle(request, deviceId);
      case 'act': {
        if (request.input.schema !== 'project-suggestion-action-v1') return super.handle(request, deviceId);
        const result = this.projects.act(request.suggestionId, request.input, deviceId); this.#kick(); return result;
      }
      case 'report': { const result = this.projects.actReport(request.reportId, request.input, deviceId); this.#kick(); return result; }
      default: return super.handle(request, deviceId);
    }
  }
  /** Change it: a direct edit is checked immediately; plain words run one short read-only draft. Neither applies anything. */
  async #revise(input: ProjectRevisionRequest, deviceId: string): Promise<ProjectRevisionRecord> {
    const id = `revision_${hash([deviceId, input.clientRequestId])}`; const previous = this.projects.revision(id);
    if (previous) { if (previous.deviceId !== deviceId || stableJson(previous.request) !== stableJson(input)) conflict('This request identifier already contains another change.'); return previous; }
    const row = this.projects.get(IdSchema.parse(input.suggestionId));
    if (!row || row.revision !== input.revision || row.suggestion.status !== 'pending') conflict('This suggestion changed. Reload it before revising it.');
    const record = this.projects.putRevision(ProjectRevisionRecordSchema.parse({ schema: 'project-revision-record-v1', id, deviceId, request: input, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', error: null, preview: null }));
    const files = new Map(row.suggestion.patch.files.map(file => [file.path, file]));
    const revised = (after: Array<{ path: string; after: string }>): ProjectPatch => {
      const changes = new Map(after.map(entry => [entry.path, entry.after]));
      if ([...changes.keys()].some(path => !files.has(path) || files.get(path)!.after === null)) conflict('Change it may only revise files this suggestion adds or edits.');
      const next = [...files.values()].map(file => changes.has(file.path) ? patchFile(file.path, file.beforeText, changes.get(file.path)!) : file).filter(file => file.after !== file.beforeText);
      if (!next.length) conflict('The revised change no longer changes anything.');
      return projectPatch(next);
    };
    const finish = (title: string, reason: string, patch: ProjectPatch) => {
      const preview = this.projects.preview(ProjectPreviewSchema.parse({ schema: 'project-preview-v1', id, suggestionId: row.suggestion.id, suggestionRevision: row.revision, source: input.kind,
        instruction: input.kind === 'instruction' ? input.instruction : null, title, reason, patch, createdAt: new Date().toISOString() }));
      return this.projects.putRevision({ ...this.projects.revision(id)!, status: 'complete', finishedAt: new Date().toISOString(), preview });
    };
    const fail = (error: unknown) => this.projects.putRevision({ ...this.projects.revision(id)!, status: 'failed', finishedAt: new Date().toISOString(),
      error: this.options.hub.redactor.text(error instanceof Error ? error.message : 'The suggestion could not be revised.').slice(0, 1200) });
    if (input.kind === 'text') {
      try { return finish(row.suggestion.title, row.suggestion.reason, revised(input.files)); } catch (error) { fail(error); throw error; }
    }
    const release = this.options.enterOperation(id, 'Revising a suggestion'); const abort = new AbortController();
    const promise = (async () => {
      try {
        const editable = [...files.values()].filter(file => file.after !== null);
        const result = BackgroundDraftResultSchema.parse(await this.options.draft({ schema: 'background-draft-request-v1', id, title: 'Revise improver suggestion', projectId: row.suggestion.projectId, resultType: 'suggestion',
          brief: 'Revise this proposed project change following the user\'s instruction in instruction.txt. before/ holds the original files and proposed/ the current proposal. Return a project-revision-draft-v1 JSON object matching draft-schema.json as handoff.result.content with type suggestion, giving the complete new text for each file you change. Only files under proposed/ may be changed. Do not edit files.',
          files: { ...Object.fromEntries(editable.flatMap(file => [[`proposed/${file.path}`, file.after!], ...file.beforeText === null ? [] : [[`before/${file.path}`, file.beforeText]]])),
            'instruction.txt': input.instruction, 'suggestion.json': JSON.stringify({ title: row.suggestion.title, reason: row.suggestion.reason, kind: row.suggestion.kind }), 'draft-schema.json': JSON.stringify(z.toJSONSchema(ProjectRevisionDraftSchema)) } }, abort.signal));
        if (result.runId !== id || result.handoff.status !== 'done' || result.handoff.result?.type !== 'suggestion') throw new Error('The revised draft did not complete this request.');
        const draft = ProjectRevisionDraftSchema.parse(typeof result.content === 'string' ? JSON.parse(result.content) : result.content);
        finish(draft.title, draft.reason, revised(draft.files));
      } catch (error) { fail(error); throw error; }
      finally { release(); this.#revisions.delete(id); }
    })();
    this.#revisions.set(id, { abort, promise }); void promise.catch(() => undefined);
    return record;
  }
  async waitRevision(id: string): Promise<void> { await this.#revisions.get(id)?.promise.catch(() => undefined); }
  override async close(): Promise<void> {
    this.#stopped = true; const operations = [...this.#revisions.values()]; for (const operation of operations) operation.abort.abort();
    await Promise.allSettled(operations.map(operation => operation.promise)); await super.close();
  }
}
