import { ImproverCardSchema, unifiedDiff, type ImproverCard, type ProjectSuggestionRow, type RoutingSuggestionRow } from '@jevellan/core';

const open = ['pending', 'applying', 'recompute', 'undoing'];
const fieldName = (field: RoutingSuggestionRow['suggestion']['draft']['field']) => field.kind === 'routing-profile' ? 'routing-profile' : field.kind === 'menu-description' ? `menu/${field.modelId}/description` : `effort-guide/${field.effort}`;

export function routingCard(row: RoutingSuggestionRow, titles: ReadonlyMap<string, string>, now = Date.now()): ImproverCard {
  const { suggestion } = row; const key = suggestion.group.key; const last = suggestion.outcomes.at(-1);
  return ImproverCardSchema.parse({
    schema: 'improver-card-v1', kind: 'routing', id: suggestion.id, revision: row.revision, projectId: null, projectName: null, title: suggestion.draft.title, reason: suggestion.draft.reason,
    status: suggestion.status, decided: !open.includes(suggestion.status), error: suggestion.status === 'recompute' ? 'The field changed since this suggestion was made. It is being recomputed.' : null,
    createdAt: suggestion.createdAt, updatedAt: suggestion.updatedAt,
    evidence: { kind: 'corrections', total: suggestion.group.overrides.length, withUndo: suggestion.group.overrides.filter(item => item.mode === 'redo').length,
      items: suggestion.group.overrides.map(item => ({ id: item.id, at: item.at, conversationId: item.conversationId, conversationTitle: titles.get(item.conversationId) ?? null, stretch: item.stretch,
        field: key.field, from: key.from, to: key.to, context: item.context, mode: item.mode })) },
    change: { kind: 'field', field: suggestion.draft.field, before: suggestion.draft.before, after: suggestion.draft.after, diff: unifiedDiff(fieldName(suggestion.draft.field), `${suggestion.draft.before}\n`, `${suggestion.draft.after}\n`) },
    check: { evidence: suggestion.comparison.evidence, total: suggestion.comparison.cases.length, unchanged: suggestion.comparison.unchanged, better: suggestion.comparison.better, worse: suggestion.comparison.worse,
      changed: suggestion.comparison.cases.filter(entry => entry.change !== 'unchanged').map(entry => ({ caseId: entry.after.caseId, title: entry.after.title, change: entry.change })) },
    counts: null,
    applied: suggestion.applied && last ? { at: suggestion.outcomes.filter(outcome => outcome.kind === 'applied' || outcome.kind === 'applied-after-change').at(-1)!.at, undoUntil: suggestion.applied.undoUntil, commit: null, published: null } : null,
    outcomes: suggestion.outcomes.map(outcome => ({ kind: outcome.kind, at: outcome.at, reason: outcome.reason })),
    actions: { apply: suggestion.status === 'pending', undo: suggestion.status === 'applied' && !!suggestion.applied && Date.parse(suggestion.applied.undoUntil) > now, dismiss: ['pending', 'recompute'].includes(suggestion.status), change: suggestion.status === 'pending' },
    requests: { action: 'routing-suggestion-action-v1', revision: 'routing-revision-request-v1' },
  });
}

export function projectCard(row: ProjectSuggestionRow, now = Date.now()): ImproverCard {
  const { suggestion } = row;
  return ImproverCardSchema.parse({
    schema: 'improver-card-v1', kind: suggestion.kind, id: suggestion.id, revision: row.revision, projectId: suggestion.projectId, projectName: suggestion.projectName,
    title: suggestion.title, reason: suggestion.reason, status: suggestion.status, decided: !open.includes(suggestion.status), error: suggestion.error,
    createdAt: suggestion.createdAt, updatedAt: suggestion.updatedAt, evidence: { kind: 'notes', notes: suggestion.evidence },
    change: { kind: 'patch', diff: (suggestion.applied?.patch ?? suggestion.patch).diff, files: (suggestion.applied?.patch ?? suggestion.patch).files.map(file => ({ path: file.path, before: file.beforeText, after: file.after })) },
    check: null, counts: suggestion.counts,
    applied: suggestion.applied ? { at: suggestion.applied.at, undoUntil: suggestion.applied.undoUntil, commit: suggestion.applied.commit, published: suggestion.applied.published } : null,
    outcomes: suggestion.outcomes.map(outcome => ({ kind: outcome.kind, at: outcome.at, reason: outcome.reason })),
    actions: { apply: suggestion.status === 'pending', undo: suggestion.status === 'applied' && !!suggestion.applied && Date.parse(suggestion.applied.undoUntil) > now,
      dismiss: ['pending', 'recompute', 'expired'].includes(suggestion.status), change: suggestion.status === 'pending' },
    requests: { action: 'project-suggestion-action-v1', revision: 'project-revision-request-v1' },
  });
}
/** Open cards first, then recently decided ones; newest first within each. */
export function sortCards(cards: ImproverCard[]): ImproverCard[] {
  return cards.sort((a, b) => Number(a.decided) - Number(b.decided) || (b.decided ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt)) || a.id.localeCompare(b.id));
}
