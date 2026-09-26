import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BackgroundDraftResultSchema, ImproverJobViewSchema, ImproverRequestSchema, ImproverStateSchema, RoutingDraftSchema, RoutingImproverLogSchema, RoutingOutcomeContextSchema, applyRoutingField, exportConfiguration, stableJson,
  type BackgroundDraftRequest, type BackgroundDraftResult, type ImproverJob, type ImproverRequest, type ImproverResult, type ImproverState, type ImproverJobScope, type RoutingGroup, type RoutingImproverLog, type RoutingSuggestionRow,
} from '@jevellan/core';
import { HubDatabase, HubIndexes, ImproverJobs, RoutingSuggestions, dueImproverDate } from '@jevellan/mesh';
import { compareDecisionCases, decisionCaseManifest, judgeRoutingGroup, routingGroups, savedDecisionCases, validateRoutingDraft, type DecisionClient } from '@jevellan/decisions';
import { RoutingRevisions } from './routing-revisions.js';
import { routingCard, sortCards } from './improver-cards.js';

export type RoutingImproverOptions = {
  hub: HubDatabase; deviceId: string; ready: Promise<void>; client(): DecisionClient | Promise<DecisionClient>;
  draft(request: BackgroundDraftRequest, signal: AbortSignal): Promise<BackgroundDraftResult>;
  enterOperation(id: string, title: string): () => void;
  evidence: 'live' | 'simulated';
};
type Options = RoutingImproverOptions;
type Operation = { abort: AbortController; promise: Promise<void> };
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** Routing orchestration drafts and checks suggestions; only an explicit user action can apply one. */
export class RoutingImprover {
  readonly jobs: ImproverJobs;
  readonly suggestions: RoutingSuggestions;
  readonly revisions: RoutingRevisions;
  readonly cases = savedDecisionCases();
  readonly #operations = new Map<string, Operation>();
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #tick: Promise<void> | undefined;
  constructor(readonly options: Options) {
    this.jobs = new ImproverJobs(options.hub);
    this.suggestions = new RoutingSuggestions(options.hub, decisionCaseManifest(this.cases));
    this.revisions = new RoutingRevisions({ ...options, suggestions: this.suggestions });
  }
  async run(cycle: ImproverJobScope['cycle']): Promise<ImproverJob> {
    await this.revisions.ready;
    if (this.#closed) throw new Error('The improver is stopping.');
    const settings = this.options.hub.configuration.current()!.configuration['x-jevellan'].improver;
    if (!settings.routing.enabled) throw new Error('Routing suggestions are disabled.');
    const claim = this.jobs.claim({ kind: 'routing', projectId: null, cycle }, this.options.deviceId);
    if (claim.claimed) {
      const operation: Operation = { abort: new AbortController(), promise: Promise.resolve() };
      operation.promise = this.#run(claim.job, operation).finally(() => this.#operations.delete(claim.job.id));
      this.#operations.set(claim.job.id, operation); void operation.promise.catch(() => undefined);
    }
    return claim.job;
  }
  async nightly(now = new Date()): Promise<ImproverJob | null> {
    const settings = this.options.hub.configuration.current()!.configuration['x-jevellan'].improver;
    const date = dueImproverDate(settings, now); if (!date || !settings.routing.enabled) return null;
    return this.run({ kind: 'nightly', date });
  }
  async wait(jobId: string): Promise<void> { await this.#operations.get(jobId)?.promise; }
  start(): void {
    if (this.#closed || this.#timer) return;
    const tick = () => {
      if (this.#closed || this.#tick) return;
      this.#tick = this.revisions.ready.then(async () => {
        if (this.#closed) return;
        await this.nightly();
        for (const row of this.suggestions.list()) if (row.suggestion.status === 'recompute') await this.#recompute(row);
      }).finally(() => { this.#tick = undefined; });
      void this.#tick.catch(() => undefined);
    };
    this.#timer = setInterval(tick, 60_000); this.#timer.unref(); tick();
  }
  async #recompute(row: RoutingSuggestionRow): Promise<void> {
    const current = this.suggestions.get(row.suggestion.id);
    if (current?.revision !== row.revision || current.suggestion.status !== 'recompute') return;
    await this.revisions.request({ schema: 'routing-revision-request-v1', clientRequestId: `recompute_${hash([row.suggestion.id, row.revision])}`,
      suggestionId: row.suggestion.id, revision: row.revision, kind: 'recompute' }, this.options.deviceId);
  }
  async request(raw: unknown, deviceId: string): Promise<ImproverResult> {
    await this.revisions.ready;
    if (this.#closed) throw Object.assign(new Error('The improver is stopping.'), { status: 503 });
    const request = ImproverRequestSchema.parse(raw);
    if (this.options.hub.redactor.text(JSON.stringify(request)) !== JSON.stringify(request)) throw Object.assign(new Error('Remove credentials from the suggestion request.'), { status: 400 });
    return this.handle(request, deviceId);
  }
  view(job: ImproverJob) {
    return ImproverJobViewSchema.parse({ schema: 'improver-job-view-v1', id: job.id, scope: job.scope, deviceId: job.deviceId, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, note: job.note });
  }
  /** Routing state only; the application improver adds project jobs, cards and the trial log. */
  state(): ImproverState {
    const suggestions = this.suggestions.visible(); const titles = this.conversationTitles();
    return ImproverStateSchema.parse({ schema: 'improver-state-v2', cards: sortCards(suggestions.map(row => routingCard(row, titles))), suggestions, jobs: this.jobs.list().map(job => this.view(job)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      revisions: this.revisions.recent(), projectSuggestions: [], projectRevisions: [], reports: [], lastRuns: [], trialLog: { schema: 'trial-log-v1', weeks: [] },
      pending: suggestions.filter(row => ['pending', 'recompute'].includes(row.suggestion.status)).length, notice: null });
  }
  conversationTitles(): Map<string, string> { return new Map(new HubIndexes(this.options.hub, this.options.deviceId).conversations().map(entry => [entry.id, entry.title])); }
  protected async handle(request: ImproverRequest, deviceId: string): Promise<ImproverResult> {
    if (request.operation === 'state') return this.state();
    if (request.operation === 'run') return this.view(await this.run({ kind: 'manual', id: hash([deviceId, request.clientRequestId]) }));
    if (request.operation === 'revise' && request.input.schema === 'routing-revision-request-v1') return this.revisions.request(request.input, deviceId);
    if (request.operation === 'revision') return this.revisions.get(request.id);
    if (request.operation === 'log') {
      const log = this.log(request.jobId); if (!log) throw Object.assign(new Error('Run log not found.'), { status: 404 }); return log;
    }
    if (request.operation === 'act' && request.input.schema === 'routing-suggestion-action-v1') {
      const result = this.suggestions.act(request.suggestionId, request.input, deviceId);
      if (result.suggestion.status === 'recompute') await this.#recompute(result);
      return result;
    }
    throw Object.assign(new Error('This improver operation is not available here.'), { status: 404 });
  }
  log(jobId: string): RoutingImproverLog | null { return this.options.hub.get('routing-improver-logs', jobId, RoutingImproverLogSchema)?.document ?? null; }
  #current(job: ImproverJob, operation: Operation): void {
    if (this.#closed || operation.abort.signal.aborted) throw new Error('The improver run was cancelled.');
    this.jobs.assertOwned(job);
  }
  #note(job: ImproverJob, input: Omit<RoutingImproverLog['entries'][number], 'at'>): void {
    this.jobs.assertOwned(job); const previous = this.options.hub.get('routing-improver-logs', job.id, RoutingImproverLogSchema);
    const document = previous?.document ?? { schema: 'routing-improver-log-v1' as const, jobId: job.id, startedAt: job.startedAt, entries: [] };
    document.entries.push({ ...input, at: new Date().toISOString(), note: this.options.hub.redactor.text(input.note).slice(0, 1200) });
    this.options.hub.put('routing-improver-logs', job.id, RoutingImproverLogSchema, document, previous?.revision ?? 0);
  }
  async #run(job: ImproverJob, operation: Operation): Promise<void> {
    let release: (() => void) | undefined; let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      release = this.options.enterOperation(job.id, 'Routing suggestions');
      renewal = setInterval(() => { try { this.jobs.renew(job); } catch { operation.abort.abort(); } }, 30_000); renewal.unref();
      this.#note(job, { groupId: null, stage: 'started', probability: null, runId: null, suggestionId: null, note: 'Checking recent corrections for routing preferences.' });
      const indexes = new HubIndexes(this.options.hub, this.options.deviceId);
      const groups = routingGroups(indexes.corrections(), Date.now(), this.suggestions.suppressions());
      const pending = new Set(this.suggestions.list().filter(row => ['pending', 'recompute'].includes(row.suggestion.status)).map(row => row.suggestion.group.id));
      let created = 0;
      for (const group of groups) {
        this.#current(job, operation);
        if (pending.has(group.id)) continue;
        const client = await this.options.client(); this.#current(job, operation);
        const snapshot = this.options.hub.configuration.current()!;
        const preference = await judgeRoutingGroup(client, group, snapshot.configuration['x-jevellan'].decisions.model, operation.abort.signal); this.#current(job, operation);
        this.#note(job, { groupId: group.id, stage: 'judged', probability: preference.probability, runId: null, suggestionId: null, note: 'Checked whether the corrections express a consistent preference.' });
        if (preference.probability < 0.7) continue;
        const id = `suggestion_${hash([job.id, group.id])}`; const runId = `routing_${hash([job.id, group.id, job.attempt])}`;
        const result = BackgroundDraftResultSchema.parse(await this.options.draft(this.#request(group, runId, snapshot.configuration, this.suggestions.list()), operation.abort.signal)); this.#current(job, operation);
        if (result.runId !== runId || result.handoff.status !== 'done' || result.handoff.result?.type !== 'suggestion') throw new Error('The routing draft result belongs to another run or did not complete.');
        this.#note(job, { groupId: group.id, stage: 'drafted', probability: null, runId: result.runId, suggestionId: null, note: 'A read-only reply returned a draft for review.' });
        const content: unknown = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
        const draft = validateRoutingDraft(content, snapshot.configuration, group);
        const comparison = await compareDecisionCases(client, this.cases, snapshot.configuration,
          applyRoutingField(snapshot.configuration, draft.field, draft.before, draft.after), this.options.evidence, operation.abort.signal); this.#current(job, operation);
        this.#note(job, { groupId: group.id, stage: 'checked', probability: null, runId, suggestionId: null, note: `Checked against ${comparison.cases.length} saved cases: ${comparison.unchanged} unchanged, ${comparison.better} better, ${comparison.worse} worse.` });
        const row = this.options.hub.transaction(() => {
          this.#current(job, operation);
          return this.suggestions.enqueue({ id, jobId: job.id, group, preference, draft, comparison, configurationRevision: snapshot.revision });
        });
        created++; pending.add(group.id);
        this.#note(job, { groupId: group.id, stage: 'suggested', probability: null, runId, suggestionId: row.suggestion.id, note: row.suggestion.status === 'pending' ? 'Suggestion ready for your decision.' : 'The target field changed; the suggestion needs recomputation.' });
      }
      this.#current(job, operation);
      const note = created ? `${created} routing suggestion${created === 1 ? '' : 's'} ready.` : 'No new routing suggestions.';
      this.#note(job, { groupId: null, stage: 'complete', probability: null, runId: null, suggestionId: null, note });
      this.jobs.finish(job, 'complete', note);
    } catch (error) {
      const note = this.options.hub.redactor.text(error instanceof Error ? error.message : 'Routing suggestions could not complete.').slice(0, 1200);
      try { this.#note(job, { groupId: null, stage: 'failed', probability: null, runId: null, suggestionId: null, note }); this.jobs.finish(job, 'failed', note); }
      catch { /* A replaced worker cannot change its successor's result. */ }
      throw error;
    } finally { clearInterval(renewal); release?.(); }
  }
  #request(group: RoutingGroup, id: string, configuration: Parameters<typeof exportConfiguration>[0], history: RoutingSuggestionRow[]): BackgroundDraftRequest {
    const outcomes = history.filter(row => row.suggestion.group.id === group.id).map(({ suggestion }) => ({ title: suggestion.draft.title, after: suggestion.draft.after, outcomes: suggestion.outcomes }));
    return { schema: 'background-draft-request-v1', id, title: 'Routing suggestion', projectId: null, resultType: 'suggestion',
      brief: 'Draft one precise change to the routing profile, one model menu description or one effort-guide line, based on the supplied corrections and prior decisions. The before text must exactly match that field in apm.yml. Cite only the supplied correction IDs. Do not invent evidence or edit files. Return a versioned routing-draft-v1 JSON object matching draft-schema.json as handoff.result.content with type suggestion. The change will be evaluated against saved cases and shown to the user; do not apply it.',
      files: { 'apm.yml': exportConfiguration(configuration), 'corrections.json': JSON.stringify(group), 'outcomes.json': JSON.stringify(RoutingOutcomeContextSchema.parse({ schema: 'routing-outcome-context-v1', outcomes })), 'draft-schema.json': JSON.stringify(z.toJSONSchema(RoutingDraftSchema)) } };
  }
  async close(): Promise<void> {
    this.#closed = true; clearInterval(this.#timer); const operations = [...this.#operations.values()]; for (const operation of operations) operation.abort.abort();
    await Promise.allSettled([this.revisions.close(), ...operations.map(operation => operation.promise), this.#tick]);
  }
}
