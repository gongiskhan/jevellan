import { ConversationMessageSchema, PlanApprovalSchema } from './conversation-schemas.js';
import type { ConversationPublicSchema } from './conversation-schemas.js';
import { ConversationPlanReviewSchema, ConversationPlansViewSchema, type ConversationPlanReview, type ConversationPlansView } from './conversation-plan-review-schemas.js';
import { z } from 'zod';

type Source = Pick<z.infer<typeof ConversationPublicSchema>, 'conversation' | 'closedWorks' | 'stretches' | 'handoffs'> & { busy?: boolean | undefined };
export function planReviewPresentation(input: { pointer: string; step: number; generation: number; approved: boolean; offered: boolean }): ConversationPlanReview {
  return ConversationPlanReviewSchema.parse({ schema: 'conversation-plan-review-v1', ...input,
    status: input.offered ? 'awaiting-approval' : input.approved ? 'approved' : 'recorded', badge: input.offered ? 'Awaiting approval' : input.approved ? 'Approved' : 'Recorded plan',
    domId: `plan-step-${input.step}`, ariaLabel: `Plan from step ${input.step}`, title: 'Proposed plan', intro: input.offered ? 'Read the proposal below. Implementation will wait until you approve it.' : null,
    loading: 'Loading the full plan…', loadFailure: 'Could not load the full plan.', retryLabel: 'Retry loading plan', approveLabel: 'Approve plan', changesLabel: 'Request changes', feedbackLabel: 'What should change?',
    feedbackPlaceholder: 'Describe the changes you want in the plan…', sendLabel: 'Send requested changes', cancelLabel: 'Cancel' });
}
/** Canonical recorded plan/work facts; the last non-undone matching step is the only current approval target. */
export function conversationPlansView(source: Source, pauseAfterPlan: boolean): ConversationPlansView {
  const work = source.conversation.work, pointer = work?.latestPlanRef;
  const step = pointer ? source.stretches.findLast(row => row.workId === work?.id && row.status !== 'undone' && source.handoffs.some(handoff => handoff.stretch === row.n && handoff.result?.type === 'plan' && handoff.result.ref === pointer))?.n : undefined;
  const blocked = !!pointer && pauseAfterPlan && work?.approvedPlanRef !== pointer;
  return ConversationPlansViewSchema.parse({ schema: 'conversation-plans-view-v1', projectId: source.conversation.projectId, conversationId: source.conversation.id, blocked,
    current: pointer ? { pointer, step: step ?? null, domId: step === undefined ? null : `plan-step-${step}` } : null,
    reviews: source.stretches.flatMap(row => {
      const handoff = source.handoffs.find(entry => entry.stretch === row.n);
      if (handoff?.result?.type !== 'plan') return [];
      const approved = [work, ...source.closedWorks].find(entry => entry?.id === row.workId)?.approvedPlanRef === handoff.result.ref;
      return [planReviewPresentation({ pointer: handoff.result.ref, step: row.n, generation: source.conversation.generation, approved, offered: blocked && step === row.n })];
    }), notice: blocked && !source.busy && source.conversation.state !== 'running' ? { text: 'Waiting for plan approval.', label: 'Review plan ↑', target: step === undefined ? null : `plan-step-${step}` } : null });
}
export const planFeedbackReady = (text: string): boolean => !!text.trim();
export const ConversationPlanChangesRequestSchema = z.strictObject({ ...ConversationMessageSchema.shape, planChange: ConversationMessageSchema.shape.planChange.unwrap() }).superRefine((input, context) => {
  if (!planFeedbackReady(input.text) || input.kind !== 'message' || input.answer) context.addIssue({ code: 'custom', path: ['text'], message: 'Describe the changes you want in the plan.' });
});
export function planApprovalRequest(review: ConversationPlanReview) { return PlanApprovalSchema.parse({ schema: 'plan-approval-v1', generation: review.generation, ref: review.pointer }); }
export function planChangesMessage(review: ConversationPlanReview, text: string, clientMessageId: string) {
  return ConversationPlanChangesRequestSchema.parse({ schema: 'conversation-message-v1', clientMessageId, text, planChange: { ref: review.pointer, generation: review.generation } });
}
