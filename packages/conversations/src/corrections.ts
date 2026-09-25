import { CheckpointReceiptSchema, DecisionRecordSchema, GitRewriteReceiptSchema, OverrideRecordSchema, PublicationEventSchema, RedoOperationSchema, UndoAppliedSchema, type DecisionRecord, type GitUndoPlan, type OverrideRecord } from '@jevellan/core';
import type { ConversationWork } from './work.js';

export function overrides(work: ConversationWork): OverrideRecord[] {
  return work.ledger.events().filter((event) => event.type === 'override').flatMap((event) => { const value = OverrideRecordSchema.safeParse(work.ledger.data(event)); return value.success ? [value.data] : []; });
}
export function redoOperations(work: ConversationWork) {
  const records = new Map<string, ReturnType<typeof RedoOperationSchema.parse>>();
  for (const event of work.ledger.events().filter((entry) => entry.type === 'git')) {
    const value = RedoOperationSchema.safeParse(work.ledger.data(event)); if (value.success) records.set(value.data.id, value.data);
  }
  return [...records.values()];
}
export function correctionContext(decision: DecisionRecord): string {
  const context = decision.context;
  return context ? `${context.action} in ${context.project.replace(/[\r\n]+/g, ' ')}, ${context.changeSize} change${context.riskyAreasTouched.length ? `, areas: ${context.riskyAreasTouched.join(', ')}` : ', no risky areas recorded'}` : `${decision.action.chosen}; this earlier decision did not record project change facts`;
}

/** Bind undo to recorded checkpoints, never an inferred range in today's remote history. */
export function undoRange(work: ConversationWork, stretch: number, followingWorkId?: string): Pick<GitUndoPlan, 'target' | 'sourceTip' | 'ranges'> & { published: boolean } {
  const view = work.load(); const step = view.stretches.find((entry) => entry.n === stretch);
  if (!step?.gitBefore || step.status === 'undone') throw new Error('The selected step has no active recorded Git boundary.');
  const following = followingWorkId ? view.conversation.work : undefined;
  if (followingWorkId && (following?.id !== followingWorkId || view.closedWorks.at(-1)?.id !== step.workId)) throw new Error('The newer work no longer matches this undo request.');
  const workIds = [step.workId, ...(followingWorkId ? [followingWorkId] : [])];
  const active = new Set(view.stretches.filter((entry) => workIds.includes(entry.workId) && entry.n >= stretch && entry.status !== 'undone').map((entry) => entry.n));
  const events = work.ledger.events();
  const rewrites = events.filter((event) => event.type === 'git').flatMap((event) => {
    const receipt = GitRewriteReceiptSchema.safeParse(work.ledger.data(event));
    return receipt.success && workIds.includes(receipt.data.plan.workId) ? [receipt.data] : [];
  });
  const boundary = (original: string) => rewrites.reduce((commit, receipt) => receipt.pairs.find((pair) => pair.before === commit)?.after ?? commit, original);
  const range = (before: string, after: string) => {
    const startBoundaries = [before];
    for (const receipt of rewrites) {
      const end = receipt.pairs.find((pair) => pair.before === after);
      // A merge base is still the same published commit. Only a range replayed
      // onto newer upstream acquires that upstream as its starting boundary.
      before = receipt.pairs.find((pair) => pair.before === before)?.after ?? (end && before === receipt.plan.base ? receipt.plan.upstream : before);
      after = end?.after ?? after; startBoundaries.push(before);
    }
    return { before, after, startBoundaries };
  };
  const receipts = events.filter((event) => event.type === 'git').flatMap((event) => {
    const value = CheckpointReceiptSchema.safeParse(work.ledger.data(event)); return value.success && workIds.includes(value.data.workId) && active.has(value.data.stretch) ? [{ ...value.data, originalBefore: value.data.before, originalAfter: value.data.after, ...range(value.data.before, value.data.after), eventId: event.id }] : [];
  });
  const completedUndos = redoOperations(work).flatMap((operation) => {
    if (!workIds.includes(operation.workId) || operation.result?.plan.mode !== 'revert') return [];
    const event = events.find((entry) => entry.type === 'undo' && UndoAppliedSchema.parse(work.ledger.data(entry)).id === operation.id);
    if (!event) return [];
    const redo = events.find((entry) => entry.type === 'decision' && DecisionRecordSchema.parse(work.ledger.data(entry)).redoOf === operation.id);
    const destinations = [operation.result.after];
    if (redo) for (const entry of events.filter((entry) => entry.type === 'publication' && entry.id > event.id && entry.id < redo.id)) {
      const publication = PublicationEventSchema.parse(work.ledger.data(entry));
      if (publication.workId === operation.workId && publication.status === 'published') destinations.push(publication.commit);
    }
    return [{ eventId: event.id, target: range(operation.result.plan.target, operation.result.plan.sourceTip).before, destinations: destinations.map(boundary) }];
  });
  const startsWithFollowing = following && receipts[0]?.workId === following.id && receipts[0].originalBefore === following.baseCommit;
  const target = startsWithFollowing ? receipts[0]!.before : range(step.gitBefore, receipts[0]?.originalAfter ?? step.gitAfter ?? step.gitBefore).before;
  let sourceTip = target; let previousEvent = 0; let previousWork = step.workId; let separated = false;
  for (const receipt of receipts) {
    if (receipt.before !== sourceTip) {
      const transition = completedUndos.some((undo) => undo.target === sourceTip && undo.destinations.includes(receipt.before) && undo.eventId > previousEvent && undo.eventId < receipt.eventId);
      const nextWork = following && previousWork === step.workId && receipt.workId === following.id && receipt.originalBefore === following.baseCommit;
      if (!transition && !nextWork && !receipt.startBoundaries.includes(sourceTip)) throw new Error('Checkpoint history crosses rewritten integration or an unrecorded boundary. Reconcile its recorded boundaries before retrying.');
      separated = true;
    }
    sourceTip = receipt.after; previousEvent = receipt.eventId; previousWork = receipt.workId;
  }
  for (const entry of view.stretches.filter((entry) => active.has(entry.n))) {
    if (entry.gitAfter && entry.gitAfter !== entry.gitBefore && !receipts.some((receipt) => receipt.stretch === entry.n && receipt.after === boundary(entry.gitAfter!))) throw new Error('This earlier step has no complete checkpoint receipt. Its changes cannot be inferred from remote history.');
  }
  const published = work.ledger.events().filter((event) => event.type === 'publication').some((event) => {
    const publication = PublicationEventSchema.parse(work.ledger.data(event)); return workIds.includes(publication.workId) && publication.status === 'published';
  });
  return { target, sourceTip, published, ...(separated ? { ranges: receipts.map(({ before, after }) => ({ before, after })) } : {}) };
}
