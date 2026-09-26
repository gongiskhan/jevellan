import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DecisionComparisonSchema, IdSchema, RoutingDraftSchema, RoutingGroupSchema, RoutingPreferenceSchema, RoutingPreviewSchema, RoutingSuggestionActionSchema,
  RoutingSuggestionRowSchema, RoutingSuggestionSchema, applyRoutingField, configurationDigest, routingFieldText, stableJson, validateRoutingDraft,
  type DecisionComparison, type RoutingDraft, type RoutingGroup, type RoutingPreference, type RoutingPreview, type RoutingSuggestion, type RoutingSuggestionAction, type RoutingSuggestionRow, type RoutingSuppression,
} from '@jevellan/core';
import type { HubDatabase } from './database.js';

const namespace = 'routing-suggestions';
const ReceiptSchema = z.strictObject({ schema: z.literal('routing-suggestion-receipt-v1'), deviceId: IdSchema, requestId: IdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: RoutingSuggestionRowSchema });
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
function conflict(message = 'This suggestion changed. Reload it before deciding.'): never { throw Object.assign(new Error(message), { status: 409 }); }
type CheckedDraft = { draft: RoutingDraft; comparison: DecisionComparison; configurationRevision: number };

export class RoutingSuggestions {
  constructor(readonly hub: HubDatabase, private readonly cases: { digest: string; ids: string[] }, private readonly now: () => number = Date.now) {
    if (!/^[a-f0-9]{64}$/.test(cases.digest) || !cases.ids.length || new Set(cases.ids).size !== cases.ids.length) throw new Error('A complete saved-case manifest is required.');
  }
  get(id: string): RoutingSuggestionRow | null {
    const row = this.hub.get(namespace, id, RoutingSuggestionSchema);
    return row ? RoutingSuggestionRowSchema.parse({ schema: 'routing-suggestion-row-v1', revision: row.revision, suggestion: row.document }) : null;
  }
  list(): RoutingSuggestionRow[] { return this.hub.list(namespace, RoutingSuggestionSchema).map(row => RoutingSuggestionRowSchema.parse({ schema: 'routing-suggestion-row-v1', revision: row.revision, suggestion: row.document })); }
  visible(): RoutingSuggestionRow[] {
    const since = this.now() - 7 * 86400_000;
    return this.list().filter(row => ['pending', 'recompute'].includes(row.suggestion.status) || Date.parse(row.suggestion.outcomes.at(-1)!.at) >= since)
      .sort((a, b) => b.suggestion.createdAt.localeCompare(a.suggestion.createdAt) || a.suggestion.id.localeCompare(b.suggestion.id));
  }
  suppressions(): RoutingSuppression[] {
    const groups = new Map<string, Set<string>>();
    for (const { suggestion } of this.list()) {
      if (!suggestion.outcomes.length) continue;
      const seen = groups.get(suggestion.group.id) ?? new Set<string>();
      for (const override of suggestion.group.overrides) seen.add(override.id);
      groups.set(suggestion.group.id, seen);
    }
    return [...groups].map(([groupId, ids]) => ({ schema: 'routing-suppression-v1', groupId, overrideIds: [...ids].sort() }));
  }
  enqueue(input: CheckedDraft & { id: string; jobId: string; group: RoutingGroup; preference: RoutingPreference }): RoutingSuggestionRow {
    return this.hub.transaction(() => {
      const group = RoutingGroupSchema.parse(input.group); const preference = RoutingPreferenceSchema.parse(input.preference);
      const checked = this.#checked(input, group); const at = new Date(this.now()).toISOString();
      const suggestion = RoutingSuggestionSchema.parse({ schema: 'routing-suggestion-v1', id: input.id, jobId: input.jobId, creationFingerprint: hash({ jobId: input.jobId, group, preference, ...checked }), group, preference, ...checked,
        status: this.#fieldIsCurrent(checked.draft) ? 'pending' : 'recompute', createdAt: at, updatedAt: at, outcomes: [], applied: null });
      const existing = this.get(suggestion.id);
      if (existing) {
        if (existing.suggestion.creationFingerprint !== suggestion.creationFingerprint) conflict('This suggestion identifier already belongs to another draft.');
        return existing;
      }
      const pending = this.list().find(row => row.suggestion.group.id === group.id && ['pending', 'recompute'].includes(row.suggestion.status));
      if (pending) return pending;
      if (this.suppressions().some(value => value.groupId === group.id && group.overrides.filter(item => !value.overrideIds.includes(item.id)).length < 3)) conflict('This group needs three new corrections before another suggestion.');
      return this.#save(suggestion, 0);
    });
  }
  preview(id: string, revision: number, input: CheckedDraft & { id: string; source: RoutingPreview['source']; instruction: string | null }): RoutingPreview {
    return this.hub.transaction(() => {
      const current = this.#pending(id, revision); const checked = this.#checked(input, current.suggestion.group);
      if (stableJson(checked.draft.field) !== stableJson(current.suggestion.draft.field)) conflict('Change it must revise the same field.');
      const preview = RoutingPreviewSchema.parse({ schema: 'routing-preview-v1', id: input.id, suggestionId: id, suggestionRevision: revision, source: input.source,
        instruction: input.instruction, ...checked, createdAt: new Date(this.now()).toISOString() });
      const existing = this.hub.get('routing-previews', preview.id, RoutingPreviewSchema);
      if (existing) {
        if (stableJson({ ...existing.document, createdAt: preview.createdAt }) !== stableJson(preview)) conflict('This preview request already contains another change.');
        return existing.document;
      }
      return this.hub.put('routing-previews', preview.id, RoutingPreviewSchema, preview, 0).document;
    });
  }
  recompute(id: string, revision: number, input: CheckedDraft): RoutingSuggestionRow {
    return this.hub.transaction(() => {
      const row = this.get(id); if (!row || row.revision !== revision || row.suggestion.status !== 'recompute') conflict();
      const checked = this.#checked(input, row.suggestion.group);
      if (!this.#fieldIsCurrent(checked.draft)) conflict('The field changed again while recomputing.');
      return this.#save({ ...row.suggestion, ...checked, status: 'pending', updatedAt: new Date(this.now()).toISOString() }, row.revision);
    });
  }
  act(id: string, raw: RoutingSuggestionAction, deviceId: string): RoutingSuggestionRow {
    const request = RoutingSuggestionActionSchema.parse(raw); IdSchema.parse(deviceId); IdSchema.parse(id);
    const receiptId = hash([deviceId, request.clientRequestId]); const fingerprint = hash({ id, request });
    return this.hub.transaction(() => {
      const receipt = this.hub.get('routing-receipts', receiptId, ReceiptSchema)?.document;
      if (receipt) { if (receipt.deviceId !== deviceId || receipt.requestId !== request.clientRequestId || receipt.fingerprint !== fingerprint) conflict('This request identifier was used for another decision.'); return receipt.result; }
      const row = this.get(id); if (!row || row.revision !== request.revision) conflict();
      const result = this.#act(row, request, deviceId);
      this.hub.put('routing-receipts', receiptId, ReceiptSchema, { schema: 'routing-suggestion-receipt-v1', deviceId, requestId: request.clientRequestId, fingerprint, result }, 0);
      return result;
    });
  }
  #act(row: RoutingSuggestionRow, request: RoutingSuggestionAction, deviceId: string): RoutingSuggestionRow {
    const suggestion = structuredClone(row.suggestion); const now = this.now(); const at = new Date(now).toISOString();
    if (request.kind === 'dismiss') {
      if (!['pending', 'recompute'].includes(suggestion.status)) conflict();
      suggestion.status = 'dismissed'; suggestion.outcomes.push({ schema: 'suggestion-outcome-v1', kind: 'dismissed', at, deviceId, reason: request.reason, configurationRevision: null });
    } else if (request.kind === 'undo') {
      if (suggestion.status !== 'applied' || !suggestion.applied) conflict();
      if (Date.parse(suggestion.applied.undoUntil) <= now) conflict('The 30-second Undo window has ended.');
      const current = this.hub.configuration.current(); if (!current) throw new Error('Configuration is missing.');
      const configuration = applyRoutingField(current.configuration, suggestion.draft.field, suggestion.applied.after, suggestion.applied.before);
      const saved = this.hub.configuration.put(configuration, current.revision, { deviceId, source: 'improver' }, at);
      suggestion.status = 'undone'; suggestion.outcomes.push({ schema: 'suggestion-outcome-v1', kind: 'undone', at, deviceId, reason: null, configurationRevision: saved.revision });
    } else {
      if (suggestion.status !== 'pending') conflict();
      let changed = false;
      if (request.previewId) {
        const preview = this.hub.get('routing-previews', request.previewId, RoutingPreviewSchema)?.document;
        if (!preview || preview.suggestionId !== suggestion.id || preview.suggestionRevision !== row.revision) conflict('This revised draft is no longer current.');
        changed = preview.draft.after !== suggestion.draft.after;
        suggestion.draft = preview.draft; suggestion.comparison = preview.comparison; suggestion.configurationRevision = preview.configurationRevision;
      }
      if (!this.#fieldIsCurrent(suggestion.draft)) {
        suggestion.status = 'recompute'; suggestion.updatedAt = at;
        return this.#save(suggestion, row.revision);
      }
      const current = this.hub.configuration.current()!;
      const configuration = applyRoutingField(current.configuration, suggestion.draft.field, suggestion.draft.before, suggestion.draft.after);
      const saved = this.hub.configuration.put(configuration, current.revision, { deviceId, source: 'improver' }, at);
      suggestion.applied = { before: suggestion.draft.before, after: suggestion.draft.after, revision: saved.revision, undoUntil: new Date(now + 30_000).toISOString() };
      suggestion.status = 'applied'; suggestion.outcomes.push({ schema: 'suggestion-outcome-v1', kind: changed ? 'applied-after-change' : 'applied', at, deviceId, reason: null, configurationRevision: saved.revision });
    }
    suggestion.updatedAt = at;
    return this.#save(suggestion, row.revision);
  }
  #pending(id: string, revision: number): RoutingSuggestionRow {
    const row = this.get(id); if (!row || row.revision !== revision || row.suggestion.status !== 'pending') conflict(); return row;
  }
  #checked(input: CheckedDraft, group: RoutingGroup): CheckedDraft {
    const snapshot = this.hub.configuration.revision(input.configurationRevision); if (!snapshot) conflict('The evaluated configuration revision is missing.');
    const draft = validateRoutingDraft(RoutingDraftSchema.parse(input.draft), snapshot.configuration, group);
    const comparison = DecisionComparisonSchema.parse(input.comparison);
    const proposed = applyRoutingField(snapshot.configuration, draft.field, draft.before, draft.after);
    if (comparison.beforeConfiguration !== configurationDigest(snapshot.configuration) || comparison.afterConfiguration !== configurationDigest(proposed)
      || comparison.caseSet !== this.cases.digest || comparison.cases.length !== this.cases.ids.length || this.cases.ids.some(id => !comparison.cases.some(value => value.before.caseId === id))) conflict('The case comparison does not cover this draft and the complete saved-case set.');
    return { draft, comparison, configurationRevision: snapshot.revision };
  }
  #fieldIsCurrent(draft: RoutingDraft): boolean {
    const configuration = this.hub.configuration.current()?.configuration;
    if (!configuration) throw new Error('Configuration is missing.');
    try { return routingFieldText(configuration, draft.field) === draft.before; }
    catch (error) { if ((error as { status?: number }).status === 409) return false; throw error; }
  }
  #save(suggestion: RoutingSuggestion, revision: number): RoutingSuggestionRow {
    const saved = this.hub.put(namespace, suggestion.id, RoutingSuggestionSchema, suggestion, revision);
    return RoutingSuggestionRowSchema.parse({ schema: 'routing-suggestion-row-v1', revision: saved.revision, suggestion: saved.document });
  }
}
