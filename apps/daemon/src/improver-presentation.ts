import { ImproverCardPresentationSchema, ImproverCardSchema, RoutingPreviewPresentationSchema, RoutingRevisionRecordSchema, unifiedDiff,
  type ImproverCard, type RoutingSuggestionRow, type RoutingRevisionRecord } from '@jevellan/core';

export const routingFieldName = (field: RoutingSuggestionRow['suggestion']['draft']['field']) => field.kind === 'routing-profile' ? 'routing-profile' : field.kind === 'menu-description' ? `menu/${field.modelId}/description` : `effort-guide/${field.effort}`;
const checkSummary = (total: number, unchanged: number, better: number, worse: number) => `Checked against ${total} saved cases: ${unchanged} unchanged, ${better} better, ${worse} worse.`;
const simulatedNotice = (evidence: 'live' | 'simulated') => evidence === 'simulated' ? 'Simulated judge responses.' : null;

/** Recorded facts only. Rendering evidence neither judges nor changes a suggestion. */
export function presentImproverCard(raw: unknown): ImproverCard {
  const card = ImproverCardSchema.parse(raw), evidence = card.evidence;
  const projection = evidence.kind === 'corrections'
    ? { summary: `Based on ${evidence.total} correction${evidence.total === 1 ? '' : 's'} (${evidence.withUndo} with undo)`,
      entries: evidence.items.map(item => ({ id: item.id, at: item.at, label: item.conversationTitle ?? item.context, detail: `${item.field}: ${item.from ?? 'Auto'} → ${item.to ?? 'Auto'}`,
        action: { kind: 'conversation' as const, href: `/conversations/${item.conversationId}${item.stretch ? `?stretch=${item.stretch}` : ''}` } })) }
    : { summary: `Based on ${evidence.notes.length} note${evidence.notes.length === 1 ? '' : 's'}`,
      entries: evidence.notes.map(note => ({ id: note.permalink, at: null, label: note.title, detail: note.path, action: { kind: 'note' as const, permalink: note.permalink } })) };
  const check = card.check;
  return { ...card, presentation: ImproverCardPresentationSchema.parse({ schema: 'improver-card-presentation-v1', evidence: projection,
    check: check ? { summary: checkSummary(check.total, check.unchanged, check.better, check.worse), simulatedNotice: simulatedNotice(check.evidence), cases: check.changed.map(entry => ({ id: entry.caseId, text: `${entry.title} · ${entry.change}` })) } : null }) };
}

/** Enrich a received revision; the durable request, comparison and preview stay unchanged. */
export function presentRoutingRevision(record: RoutingRevisionRecord): RoutingRevisionRecord {
  if (!record.preview) return record;
  const { draft, comparison } = record.preview;
  const presentation = RoutingPreviewPresentationSchema.parse({ schema: 'routing-preview-presentation-v1',
    diff: unifiedDiff(routingFieldName(draft.field), `${draft.before}\n`, `${draft.after}\n`),
    checkSummary: checkSummary(comparison.cases.length, comparison.unchanged, comparison.better, comparison.worse), simulatedNotice: simulatedNotice(comparison.evidence) });
  return RoutingRevisionRecordSchema.parse({ ...record, preview: { ...record.preview, presentation } });
}
