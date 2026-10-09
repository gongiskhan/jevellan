import { createHash } from 'node:crypto';
import {
  CorrectionRecordSchema, RoutingGroupKeySchema, RoutingGroupSchema, RoutingPreferenceSchema,
  RoutingSuppressionSchema, stableJson, type CorrectionRecord, type RoutingGroup, type RoutingSuppression,
} from '@jevellan/core';
import { JevError } from './contract.js';
import type { DecisionClient } from './engine.js';
export { applyRoutingField, routingFieldText, validateRoutingDraft } from '@jevellan/core';

/** Group explicit corrections only; Jev decides whether they express a preference. */
export function routingGroups(records: CorrectionRecord[], now: number, suppressed: RoutingSuppression[] = []): RoutingGroup[] {
  if (!Number.isFinite(now)) throw new Error('A valid current time is required.');
  const groups = new Map<string, { key: RoutingGroup['key']; overrides: RoutingGroup['overrides'] }>();
  const seen = new Map<string, string>();
  for (const raw of records) {
    const record = CorrectionRecordSchema.parse(raw);
    const digest = stableJson(record); const previous = seen.get(record.id);
    if (previous !== undefined) { if (previous !== digest) throw new Error('A correction has conflicting records.'); continue; }
    seen.set(record.id, digest);
    if (Date.parse(record.at) < now - 14 * 86400_000 || Date.parse(record.at) > now) continue;
    if (record.schema === 'composer-override-v1' && record.status !== 'applied') continue;
    if (!record.workId || !record.decisionId || !record.action || !record.context) continue;
    for (const change of record.changes) {
      // Resource availability is not a learned action/model/effort preference.
      if (change.field === 'runtime' || change.field === 'account') continue;
      if (change.from === change.to) continue;
      const key = RoutingGroupKeySchema.parse({ ...change, ...(change.field === 'action' ? {} : { action: record.action }) });
      const id = `routing_${createHash('sha256').update(stableJson(key)).digest('hex')}`;
      const group = groups.get(id) ?? { key, overrides: [] };
      if (!group.overrides.some(evidence => evidence.id === record.id)) group.overrides.push({
        id: record.id, at: record.at, conversationId: record.conversationId, projectId: record.projectId, workId: record.workId, decisionId: record.decisionId,
        stretch: record.schema === 'override-v1' ? record.request.stretch : record.stretch,
        context: record.context.replace(/[\r\n]+/g, ' ').slice(0, 400), mode: record.request.mode,
      });
      groups.set(id, group);
    }
  }
  const exclusions = suppressed.map(value => RoutingSuppressionSchema.parse(value));
  return [...groups].flatMap(([id, group]) => {
    const weight = group.overrides.reduce((sum, value) => sum + (value.mode === 'redo' ? 2 : 1), 0);
    if (weight < 3 || exclusions.some(value => value.groupId === id && group.overrides.filter(item => !value.overrideIds.includes(item.id)).length < 3)) return [];
    return [RoutingGroupSchema.parse({ schema: 'routing-group-v1', id, ...group, weight,
      overrides: group.overrides.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) })];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export async function judgeRoutingGroup(client: DecisionClient, group: RoutingGroup, model: string, signal: AbortSignal) {
  const validated = RoutingGroupSchema.parse(group);
  if (signal.aborted) throw new JevError('cancelled');
  const response = await client.decide({ schema: 'jev-request-v1', model, state: stableJson(validated), questions: {
    consistent_preference: { type: 'noul', instructions: 'These overrides show a consistent preference, not one-off choices.',
      criteria: { true: 'The corrections express a consistent preference for future similar decisions.', false: 'The corrections are isolated choices or do not establish a consistent preference.' } },
  } }, signal);
  if (signal.aborted) throw new JevError('cancelled');
  const answer = response.answers.consistent_preference;
  if (answer?.type !== 'noul') throw new JevError('invalid-response');
  return RoutingPreferenceSchema.parse({ schema: 'routing-preference-v1', groupId: validated.id, probability: answer.noul, requestedModel: model, returnedModel: response.model });
}
