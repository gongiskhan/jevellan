import { CheckpointReceiptSchema, GitRewriteReceiptSchema, PublicationEventSchema, UndoAppliedSchema, WorkSettlementSchema, type ContextOperation } from '@jevellan/core';
import type { ConversationWork } from './work.js';

export class CheckoutHistoryError extends Error { readonly status = 409; }

/** Only receipts for operations Jevellan actually performed can advance the
 * owning work's Git boundary. Today's clean tree or remote tip is not evidence
 * that an otherwise unrecorded commit belongs to this work. */
export function recordedCheckoutHead(work: ConversationWork, workId: string, contexts: readonly ContextOperation[] = []): string | undefined {
  const view = work.load(); const target = [view.conversation.work, ...view.closedWorks].find(entry => entry?.id === workId);
  let head = target?.baseCommit; if (!head) return undefined;
  const context = contexts.find(entry => entry.workId === workId && entry.commit);
  let contextUsed = false;
  const bridgeContext = (before?: string) => {
    if (!contextUsed && context && context.beforeHead === head && (!before || before === context.commit)) { head = context.commit!; contextUsed = true; }
  };
  const advance = (before: string, after: string) => {
    if (head !== before && head !== after) bridgeContext(before);
    if (head !== before && head !== after) throw new CheckoutHistoryError('This work has an unrecorded Git boundary. Reconcile its recorded history before changing this checkout.');
    if (context?.beforeHead === before && context.commit === after) contextUsed = true;
    head = after;
  };
  for (const event of work.ledger.events()) {
    if (!['git', 'undo', 'publication', 'ownership'].includes(event.type)) continue;
    const data = work.ledger.data(event);
    if (event.type === 'git') {
      const checkpoint = CheckpointReceiptSchema.safeParse(data);
      if (checkpoint.success && checkpoint.data.workId === workId) { advance(checkpoint.data.before, checkpoint.data.after); continue; }
      const rewrite = GitRewriteReceiptSchema.safeParse(data);
      if (rewrite.success && rewrite.data.plan.workId === workId) advance(rewrite.data.plan.before, rewrite.data.after);
    } else if (event.type === 'undo') {
      const undo = UndoAppliedSchema.safeParse(data);
      if (undo.success && [undo.data.workId, undo.data.followingWorkId].includes(workId) && undo.data.after) {
        // Published undo may legitimately preserve newer unrelated commits.
        // Its validated, durable result establishes the new owned boundary.
        bridgeContext(undo.data.before); head = undo.data.after;
      }
    } else if (event.type === 'publication') {
      const publication = PublicationEventSchema.safeParse(data);
      if (publication.success && publication.data.workId === workId && publication.data.status === 'published') {
        bridgeContext(publication.data.commit);
        if (head !== publication.data.commit) throw new CheckoutHistoryError('Publication has an unrecorded Git boundary. Reconcile its checkpoint and integration receipts before continuing.');
      }
    } else {
      const settlement = WorkSettlementSchema.safeParse(data);
      if (settlement.success && settlement.data.workId === workId && settlement.data.choice === 'discard' && settlement.data.status === 'completed') { head = target!.baseCommit!; contextUsed = true; }
    }
  }
  bridgeContext(); return head;
}
