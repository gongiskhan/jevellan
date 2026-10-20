import { PlacementFieldSchema, ProjectThreadWhyViewSchema, type PlacementField, type PlacementRecord, type ThreadView } from '@jevellan/core';
import { placedWithoutJev } from './copy.js';

const fieldLabels: Record<PlacementField, string> = { isolation: 'Isolation', runtime: 'Runtime', account: 'Account', model: 'Model', effort: 'Effort', device: 'Device' };
const sourceLabels = { changed: 'changed by you', fixed: 'fixed', jev: 'Jev', fallback: 'fallback rule', only: 'only option' } as const;
export const PLACEMENT_QUESTIONS: Partial<Record<PlacementField, string>> = { isolation: 'isolation', model: 'pick_model', effort: 'effort', device: 'device', account: 'account' };
export type FieldSource = keyof typeof sourceLabels;
export type WhyField = { field: PlacementField; value: string; source: FieldSource; bars: Array<{ option: string; p: number; chosen: boolean }> };
export function fallbackChip(placement: Pick<PlacementRecord, 'source' | 'error'>): string | null {
  return placement.source === 'fallback' && placement.error ? placedWithoutJev(placement.error.message) : null;
}
const fieldValue = (placement: PlacementRecord, field: PlacementField): string => field === 'isolation' ? placement.isolation : field === 'runtime' ? placement.runtime
  : field === 'account' ? placement.accountId : field === 'model' ? placement.modelId : field === 'effort' ? placement.effortRequested : placement.deviceId;
/** The held value is authoritative; recorded probabilities remain intact after an owner override. */
export function whyFields(placement: PlacementRecord): WhyField[] {
  return PlacementFieldSchema.options.filter(field => !['runtime', 'account'].includes(field) || placement.fixed.includes(field) || field === 'account' && placement.accountChoice).map(field => {
    const value = fieldValue(placement, field), question = PLACEMENT_QUESTIONS[field], answered = question ? placement.probabilities?.[question] : undefined;
    const bars = Object.entries(answered ?? {}).sort((a, b) => b[1] - a[1]).map(([option, p]) => ({ option, p, chosen: option === value }));
    const top = Math.max(...bars.map(bar => bar.p));
    const source: FieldSource = answered && (answered[value] ?? -1) < top ? 'changed' : placement.fixed.includes(field) ? 'fixed' : answered ? 'jev'
      : (field === 'account' ? placement.accountChoice?.source : placement.source) === 'fallback' ? 'fallback' : 'only';
    return { field, value, source, bars };
  });
}
export const placementConstraintText = (models: string[] | null, effort: string | null) => `${models === null ? 'All enabled models' : models.join(', ') || 'No allowed models'} · ${effort ? `Lowest effort: ${effort}` : 'No minimum effort'}`;
export type ThreadWhyNames = { model(id: string): string; runtime(id: string): string; device(id: string): string; account(id: string): string };
export function threadWhyView(projectId: string, view: ThreadView, names: ThreadWhyNames) {
  const { thread, placement } = view, account = names.account(placement.accountId), choice = placement.accountChoice;
  const label = (field: PlacementField, value: string) => field === 'isolation' ? value === 'main' ? 'Main' : 'Worktree' : field === 'model' ? names.model(value)
    : field === 'device' ? names.device(value) : field === 'account' ? names.account(value) : field === 'runtime' ? names.runtime(value) : value;
  const fixed = placement.fixed.map(field => fieldLabels[field]).join(', '), constraints = placement.constraints;
  return ProjectThreadWhyViewSchema.parse({ schema: 'project-thread-why-view-v1', projectId, threadId: thread.id, title: thread.title,
    followup: view.messageRoute ? view.messageRoute.outcome.source === 'jev' ? `Jev: ${view.messageRoute.outcome.goal}` : 'Jev unavailable; your full request is preserved.' : null,
    memory: view.memoryRecall ? { summary: view.memoryRecall.source === 'unavailable' ? view.memoryRecall.section : 'Recalled for the first turn or after compaction.',
      notes: view.memoryRecall.notes.map(({ permalink, title, reason }) => ({ permalink, title, reason })) } : null,
    placement: { sourceLabel: ({ jev: 'Jev', fixed: 'fixed', fallback: 'without Jev' } as const)[placement.source], fixedLine: fixed ? `Fixed: ${fixed}` : 'Fixed: none',
      reasonLine: placement.reason ? `Placement reason: ${placement.reason}` : null,
      constraintsLine: constraints ? `Project placement constraints: ${placementConstraintText(constraints.allowedModelIds?.map(names.model) ?? null, constraints.minEffort)}` : null,
      fallbackNotice: fallbackChip(placement) },
    fields: whyFields(placement).map(({ field, value, source, bars }) => {
      const rank = field === 'model' ? { chosen: placement.modelId, eligible: placement.eligibleModels, excluded: placement.excludedModels.map(row => ({ id: row.modelId, reason: row.reason })) }
        : field === 'device' ? { chosen: placement.deviceId, eligible: placement.eligibleDevices, excluded: placement.excludedDevices.map(row => ({ id: row.deviceId, reason: row.reason })) } : null;
      const mapped = field === 'effort' && placement.effortRequested !== placement.effortEffective;
      const listed = (rank?.eligible ?? []).filter(id => !bars.some(bar => bar.option === id));
      return { field, label: fieldLabels[field], sourceLabel: sourceLabels[source], valueLabel: label(field, value), showValue: !bars.length && !mapped && !listed.includes(value),
        mappedEffort: mapped ? { requested: placement.effortRequested, effective: placement.effortEffective, note: '(nearest effort this model supports)' } : null,
        bars: bars.map(bar => ({ ...bar, label: label(field, bar.option) })),
        listed: listed.map(id => ({ id, label: label(field, id), chosen: id === rank!.chosen })),
        excluded: (rank?.excluded ?? []).map(row => ({ id: row.id, label: label(field, row.id), reason: placement.fixed.includes(field) ? null : row.reason })) };
    }),
    account: { label: account, showStandalone: !placement.fixed.includes('account') && !choice, showCandidates: !!choice,
      retainedMessage: choice?.source === 'session' ? 'Kept the eligible account of the current session.' : null,
      notice: choice?.error ? `Account choice used the resource ranking: ${choice.error.message}` : null,
      candidates: (choice?.candidates ?? []).map(candidate => ({ id: candidate.accountId, label: candidate.label, chosen: candidate.accountId === placement.accountId,
        detail: `${candidate.eligible ? 'eligible' : candidate.reason === 'model-not-served' ? `This account does not serve ${thread.modelLabel}.` : candidate.reason} · ${candidate.credential === 'shared' ? 'Shared saved login' : 'Device-local login'} · Five hours ${candidate.usage?.fiveHourPct === undefined ? 'unknown' : `${candidate.usage.fiveHourPct}%`} · Week ${candidate.usage?.weeklyPct === undefined ? 'unknown' : `${candidate.usage.weeklyPct}%`} · Ceiling ${candidate.ceilingPct}%` })) },
    escalations: (view.escalations ?? []).map(entry => ({ at: entry.at, line: `${names.model(entry.from.modelId)} ${entry.from.effort} → ${names.model(entry.to.modelId)} ${entry.to.effort} (${entry.reason})` })),
    devices: (placement.deviceFacts ?? []).map(device => ({ id: device.deviceId,
      line: `${device.name}: ${device.running} running${device.facts ? `, load ${Number(device.facts.load5.toFixed(1))} on ${device.facts.cores} cores, ${Math.floor(device.facts.freeDiskBytes / 1e9)} GB free, ${Number((device.facts.freeMemoryBytes / 1e9).toFixed(1))} GB memory free` : ''}, tags ${device.tags.join(', ') || 'none'}` })),
    task: placement.taskContext ? { line: `${placement.taskContext.type}${placement.taskContext.goal ? ` · ${placement.taskContext.goal.name}` : ''}`, needsLine: placement.taskContext.needs.length ? `Needs: ${placement.taskContext.needs.join(', ')}` : null } : null,
    corrections: placement.correctionsShown ?? [], jev: { lines: placement.jevCalls.map(call => `Placement · ${call.returnedModel} · ${call.usage.input_tokens + call.usage.output_tokens} tokens · ${call.latencyMs} ms`),
      emptyLine: placement.source === 'fallback' ? 'No Jev answer was used for this placement.' : 'No Jev call was needed for this placement.', placedAt: placement.decidedAt } });
}
