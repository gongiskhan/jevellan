import { ConversationStepPresentationSchema, RecordedNoticeSchema, type DecisionRecord, type OverrideRecord, type Stretch } from '@jevellan/core';

export function recordedDecisionNotice(notice: DecisionRecord['notices'][number]) {
  return RecordedNoticeSchema.parse({ text: notice.text, action: notice.kind === 'preferred-needs-login' && notice.accountId
    ? { label: 'Log in', href: `/settings/runtimes?account=${encodeURIComponent(notice.accountId)}&login=1` } : null });
}

/** Recorded facts only; closed-history reads need no shared configuration or changing clock. */
export function conversationStepPresentation(step: Stretch, corrections: OverrideRecord[], decision?: DecisionRecord) {
  const ticking = step.status === 'running' && !step.endedAt;
  const labels: Record<string, string> = { running: 'Running', interrupted: 'Interrupted', failed: 'Failed', 'timed-out': 'Timed out', undone: 'Undone' };
  return ConversationStepPresentationSchema.parse({ schema: 'conversation-step-presentation-v1',
    statusBadge: step.status === 'completed' ? null : { label: labels[step.status] ?? step.status, tone: step.status, spinner: step.status === 'running' },
    corrections: corrections.filter(row => row.request.stretch === step.n).map(row => ({ id: row.id, text: `corrected: ${row.changes.map(change => `${change.field} → ${change.to}`).join(', ')}` })),
    notices: (decision?.notices ?? []).filter(notice => notice.kind === 'preferred-needs-login').map(recordedDecisionNotice),
    timing: { startedAt: step.startedAt, endedAt: step.endedAt ?? null, ticking, clockStartAt: ticking ? step.startedAt : null,
      durationMs: step.endedAt ? Math.max(0, Date.parse(step.endedAt) - Date.parse(step.startedAt)) : null,
      endLabel: step.endedAt ? 'Ended' : ticking ? 'In progress' : 'End time not recorded',
      durationLabel: step.endedAt ? 'Duration' : ticking ? 'Elapsed' : null },
  });
}
