import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BackgroundDraftResultSchema, IdSchema, RoutingDraftSchema, RoutingRevisionRecordSchema, RoutingRevisionRequestSchema,
  applyRoutingField, exportConfiguration, routingFieldText, stableJson, validateRoutingDraft,
  type BackgroundDraftRequest, type BackgroundDraftResult, type RoutingRevisionRecord, type RoutingRevisionRequest,
} from '@jevellan/core';
import { compareDecisionCases, savedDecisionCases, type DecisionClient } from '@jevellan/decisions';
import type { HubDatabase, RoutingSuggestions } from '@jevellan/mesh';

const namespace = 'routing-revision-requests';
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
function conflict(message = 'This suggestion changed. Reload it before revising it.'): never { throw Object.assign(new Error(message), { status: 409 }); }
type Options = {
  hub: HubDatabase; suggestions: RoutingSuggestions; ready: Promise<void>; evidence: 'live' | 'simulated';
  client(): DecisionClient | Promise<DecisionClient>;
  draft(request: BackgroundDraftRequest, signal: AbortSignal): Promise<BackgroundDraftResult>;
  enterOperation(id: string, title: string): () => void;
};

/** HTTP completion is independent of provider completion. A repeated request always reads its saved receipt. */
export class RoutingRevisions {
  readonly ready: Promise<void>;
  readonly #operations = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  #closed = false;
  constructor(readonly options: Options) {
    this.ready = options.ready.then(() => {
      for (const row of options.hub.list(namespace, RoutingRevisionRecordSchema)) {
        if (row.document.status !== 'running') continue;
        options.hub.put(namespace, row.document.id, RoutingRevisionRecordSchema, { ...row.document, status: 'failed', finishedAt: new Date().toISOString(),
          error: 'This request was interrupted. Review the current suggestion and try again.' }, row.revision);
      }
    });
    void this.ready.catch(() => undefined);
  }
  get(id: string): RoutingRevisionRecord {
    const value = this.options.hub.get(namespace, IdSchema.parse(id), RoutingRevisionRecordSchema)?.document;
    if (!value) throw Object.assign(new Error('Revision request not found.'), { status: 404 });
    return value;
  }
  recent(): RoutingRevisionRecord[] {
    return this.options.hub.list(namespace, RoutingRevisionRecordSchema).map(row => row.document)
      .filter(value => value.status === 'running' || Date.parse(value.finishedAt!) >= Date.now() - 7 * 86400_000)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async request(raw: RoutingRevisionRequest, deviceId: string): Promise<RoutingRevisionRecord> {
    await this.ready;
    if (this.#closed) throw Object.assign(new Error('The improver is stopping.'), { status: 503 });
    const request = RoutingRevisionRequestSchema.parse(raw); IdSchema.parse(deviceId);
    if (this.options.hub.redactor.text(JSON.stringify(request)) !== JSON.stringify(request)) throw new Error('Remove credentials from the suggestion request.');
    const id = `revision_${hash([deviceId, request.clientRequestId])}`;
    const previous = this.options.hub.get(namespace, id, RoutingRevisionRecordSchema)?.document;
    if (previous) {
      if (previous.deviceId !== deviceId || stableJson(previous.request) !== stableJson(request)) conflict('This request identifier already contains another change.');
      return previous;
    }
    this.#suggestion(request);
    const configurationRevision = this.options.hub.configuration.current()!.revision;
    const release = this.options.enterOperation(id, request.kind === 'recompute' ? 'Recomputing a suggestion' : 'Revising a suggestion');
    try {
      const record = this.options.hub.put(namespace, id, RoutingRevisionRecordSchema, { schema: 'routing-revision-record-v1', id, deviceId, request,
        configurationRevision, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', error: null, preview: null, suggestion: null }, 0).document;
      const abort = new AbortController();
      const promise = this.#run(record, abort.signal).finally(() => { this.#operations.delete(id); release(); });
      this.#operations.set(id, { abort, promise }); void promise.catch(() => undefined);
      return record;
    } catch (error) { release(); throw error; }
  }
  async wait(id: string): Promise<void> { await this.#operations.get(id)?.promise; }
  #suggestion(request: RoutingRevisionRequest) {
    const row = this.options.suggestions.get(request.suggestionId);
    if (!row || row.revision !== request.revision || row.suggestion.status !== (request.kind === 'recompute' ? 'recompute' : 'pending')) conflict();
    return row.suggestion;
  }
  #current(record: RoutingRevisionRecord, signal: AbortSignal): void {
    if (this.#closed || signal.aborted) throw new Error('The suggestion request was cancelled.');
    this.#suggestion(record.request);
  }
  async #run(record: RoutingRevisionRecord, signal: AbortSignal): Promise<void> {
    const { request } = record;
    try {
      this.#current(record, signal);
      const suggestion = this.#suggestion(request); const configuration = this.options.hub.configuration.revision(record.configurationRevision)!.configuration;
      const before = routingFieldText(configuration, suggestion.draft.field);
      if (request.kind !== 'recompute' && before !== suggestion.draft.before) conflict('The field changed. Apply will recompute the suggestion before you decide.');
      let draft = suggestion.draft;
      if (request.kind === 'text') draft = validateRoutingDraft({ ...draft, after: request.after }, configuration, suggestion.group);
      else {
        const result = BackgroundDraftResultSchema.parse(await this.options.draft({ schema: 'background-draft-request-v1', id: record.id,
          title: request.kind === 'recompute' ? 'Recompute routing suggestion' : 'Revise routing suggestion', projectId: null, resultType: 'suggestion',
          brief: 'Return one revised routing-draft-v1 JSON object in handoff.result.content with type suggestion. Revise the same field as previous-draft.json. The before text must exactly match the current apm.yml. Cite only the supplied corrections. Do not edit files or apply the suggestion. '
            + (request.kind === 'instruction' ? 'Follow the user instruction in instruction.txt.' : 'The field changed since the original draft. Recompute its proposed change against the current configuration, preserving the intended preference.'),
          files: { 'apm.yml': exportConfiguration(configuration), 'previous-draft.json': JSON.stringify(suggestion.draft), 'corrections.json': JSON.stringify(suggestion.group),
            'draft-schema.json': JSON.stringify(z.toJSONSchema(RoutingDraftSchema)), ...(request.kind === 'instruction' ? { 'instruction.txt': request.instruction } : {}) },
        }, signal));
        this.#current(record, signal);
        if (result.runId !== record.id || result.handoff.status !== 'done' || result.handoff.result?.type !== 'suggestion') throw new Error('The revised draft did not complete this request.');
        draft = validateRoutingDraft(typeof result.content === 'string' ? JSON.parse(result.content) : result.content, configuration, suggestion.group);
        if (stableJson(draft.field) !== stableJson(suggestion.draft.field)) conflict('The revised draft must change the same field.');
      }
      const client = await this.options.client(); this.#current(record, signal);
      const comparison = await compareDecisionCases(client, savedDecisionCases(), configuration,
        applyRoutingField(configuration, draft.field, draft.before, draft.after), this.options.evidence, signal);
      this.#current(record, signal);
      this.options.hub.transaction(() => {
        const checked = { draft, comparison, configurationRevision: record.configurationRevision };
        const result = request.kind === 'recompute'
          ? { preview: null, suggestion: this.options.suggestions.recompute(request.suggestionId, request.revision, checked) }
          : { preview: this.options.suggestions.preview(request.suggestionId, request.revision, { ...checked, id: record.id, source: request.kind,
              instruction: request.kind === 'instruction' ? request.instruction : null }), suggestion: null };
        const row = this.options.hub.get(namespace, record.id, RoutingRevisionRecordSchema)!;
        this.options.hub.put(namespace, record.id, RoutingRevisionRecordSchema, { ...record, ...result, status: 'complete', finishedAt: new Date().toISOString() }, row.revision);
      });
    } catch (error) {
      const row = this.options.hub.get(namespace, record.id, RoutingRevisionRecordSchema)!;
      this.options.hub.put(namespace, record.id, RoutingRevisionRecordSchema, { ...record, status: 'failed', finishedAt: new Date().toISOString(),
        error: this.options.hub.redactor.text(error instanceof Error ? error.message : 'The suggestion could not be revised.').slice(0, 1200) }, row.revision);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.ready.catch(() => undefined);
    const operations = [...this.#operations.values()]; for (const operation of operations) operation.abort.abort();
    await Promise.allSettled(operations.map(operation => operation.promise));
  }
}
