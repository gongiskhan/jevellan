import { randomUUID } from 'node:crypto';
import {
  AllowanceEventSchema, ComposerOverrideRecordSchema, ConversationControlSchema, ConversationCreatedSchema, ConversationOriginSchema, ConversationRenamedSchema, ConversationSchema, DecisionRecordSchema, FindingSchema, FinishOutsideOperationSchema, FinishOutsideSchema, HandoffSchema, OverrideRecordSchema, RenameConversationSchema, StretchFinishedSchema, StretchSchema,
  SummarySchema, UndoAppliedSchema, VerificationSchema, WorkControlSchema, WorkMessageSchema, WorkSchema, stableJson,
  type Conversation, type FinishOutsideOperation, type Handoff, type LedgerEvent, type Stretch, type Summary, type UndoApplied, type Work, type WorkControl,
} from '@jevellan/core';
import { ConversationLedger } from './ledger.js';
import { composerDecisionRecords, composerOverrides, replayComposerChoice } from './choices.js';

export type WorkMessage = { id: number; type: 'user-message' | 'note'; clientMessageId: string; text: string; workId: string; answer?: { stretch: number; option: number; label: string } };
export type ConversationView = {
  conversation: Conversation; summary: Summary; closedWorks: Work[]; stretches: Stretch[];
  handoffs: Handoff[]; messages: WorkMessage[]; pause?: Extract<WorkControl, { kind: 'pause' }>;
  finishes: FinishOutsideOperation[];
};
const emptySummary = (objective = ''): Summary => ({ schema: 'summary-v2', objective, state: '', decisions: [], nextWork: '', updatedAtStretch: 0 });
const writing = (action: Stretch['action']) => ['implement', 'test', 'integrate'].includes(action);
type Finished = ReturnType<typeof StretchFinishedSchema.parse>;
const zeroCounters = (): Work['counters'] => ({ stretches: 0, reviews: 0, noProgress: 0, testFailures: 0, costUsd: 0, unknownCostStretches: 0 });
function applyConversationControl(view: ConversationView, raw: unknown, at: string): void {
  const value = ConversationControlSchema.parse(raw); const conversation = view.conversation;
  if (value.schema === 'conversation-origin-v1') {
    if (conversation.origin && conversation.origin !== value.origin) throw new Error('This conversation already has another origin.');
    conversation.origin = value.origin; return;
  }
  if (value.schema === 'conversation-renamed-v1') {
    if (value.request.previousTitle !== conversation.title) throw new Error('The title changed. Reload before renaming it.');
    conversation.title = value.request.title; return;
  }
  const index = view.finishes.findIndex((entry) => entry.request.clientRequestId === value.request.clientRequestId);
  const previous = view.finishes[index];
  if (!previous) {
    if (value.status !== 'requested' || value.request.generation !== conversation.generation || view.finishes.some((entry) => entry.status !== 'completed')) throw new Error('This finish request is stale or another is unfinished.');
    conversation.generation++; view.finishes.push(value); return;
  }
  if (stableJson(previous.request) !== stableJson(value.request) || previous.status === 'completed') throw new Error('This finish request already has a different result.');
  if (value.status === 'completed') {
    if (conversation.state === 'running' || view.stretches.some((step) => step.status === 'running')) throw new Error('The running stretch must finish first.');
    const work = conversation.work;
    if (work && work.id !== value.workId) throw new Error('The finish result belongs to different work.');
    if (work) view.closedWorks.push(WorkSchema.parse({ ...work, closedAt: at, closedAs: 'closed-by-you' }));
    conversation.work = null; conversation.state = 'done'; conversation.generation++; delete view.pause;
    conversation.outcome = { kind: 'finished-elsewhere', ...(value.request.reason ? { reason: value.request.reason } : {}), at };
  } else if (value.status === 'blocked' && conversation.work && conversation.state !== 'running') {
    conversation.state = 'blocked'; view.pause = { schema: 'work-control-v1', kind: 'pause', state: 'blocked', reason: value.reason ?? 'Finishing outside Jevellan needs process cleanup.' };
  }
  view.finishes[index] = value;
}
function applyCompletion(work: Work, summary: Summary, result: Finished, handoff: Handoff, findings: ReturnType<typeof FindingSchema.parse>[]): Summary {
  const stretch = result.stretch; const counters = work.counters;
  if (stretch.usage.costUsd !== undefined) counters.costUsd += stretch.usage.costUsd;
  else counters.unknownCostStretches++;
  if (handoff.testsRun) counters.testFailures = handoff.testsRun.passed ? 0 : counters.testFailures + 1;
  if (['implement', 'test'].includes(stretch.action) && !result.correction) counters.noProgress = !result.changed && !handoff.findings.length && !findings.length ? counters.noProgress + 1 : 0;
  if (handoff.result?.type === 'plan') work.latestPlanRef = handoff.result.ref;
  for (const finding of [...findings, ...handoff.findings]) {
    if (finding.claim.startsWith('constraint:') && !work.constraints.includes(finding.claim)) work.constraints.push(finding.claim);
    if (finding.claim.startsWith('decision:') && !summary.decisions.includes(finding.claim)) summary.decisions.push(finding.claim);
  }
  return SummarySchema.parse({ ...summary, objective: work.request, state: handoff.summary, nextWork: [handoff.proposedNext, ...handoff.blockers].filter(Boolean).join('\n'), updatedAtStretch: stretch.n });
}
function applyVerification(work: Work, value: ReturnType<typeof VerificationSchema.parse>): void {
  const stable = value.treeClean || (value.worktreeBefore !== undefined && value.worktreeBefore === value.worktreeAfter);
  work.counters.testFailures = value.passed && value.headStable && stable ? 0 : work.counters.testFailures + 1;
}
function undoTarget(view: ConversationView, undo: UndoApplied): Work {
  const open = view.conversation.work; const closed = view.closedWorks.at(-1);
  const work = open?.id === undo.workId ? open : closed?.id === undo.workId && (!open || open.id === undo.followingWorkId) ? closed : undefined;
  if (!work || undo.followingWorkId && (open?.id !== undo.followingWorkId || open.id === work.id)) throw new Error('Undo must target the open work or last closed work, and explicitly include any newer work.');
  if (view.conversation.generation !== undo.generation) throw new Error('Undo is stale.');
  if (view.stretches.some((step) => step.status === 'running')) throw new Error('The running stretch must finish before undo.');
  const steps = view.stretches.filter((step) => [work.id, undo.followingWorkId].includes(step.workId) && step.status !== 'undone');
  if (!steps.some((step) => step.n === undo.fromStretch && step.workId === work.id) || steps.at(-1)?.n !== undo.throughStretch) throw new Error('Undo must include every active step from its starting step onwards.');
  return work;
}
/** Rebuild semantic state, preserving the original request, user messages, base and allowance. */
function applyUndo(view: ConversationView, undo: UndoApplied, history: LedgerEvent[], ledger: ConversationLedger, at: string): void {
  const work = undoTarget(view, undo);
  if (view.conversation.work?.id !== work.id) {
    const following = view.conversation.work; view.closedWorks.pop();
    if (following) {
      // Keep both requests verbatim. Later user direction becomes part of the
      // reopened work, while its original work and ledger messages remain visible.
      work.messageEventIds = [...new Set([...work.messageEventIds, following.requestEventId, ...following.messageEventIds])].sort((a, b) => Number(a) - Number(b));
      following.closedAs = 'cancelled'; following.closedAt = at; following.counters = zeroCounters(); following.constraints = [];
      delete following.latestPlanRef; delete following.approvedPlanRef; view.closedWorks.push(following);
    }
    delete work.closedAs; delete work.closedAt; view.conversation.work = work;
  }
  for (const step of view.stretches) if ([work.id, undo.followingWorkId].includes(step.workId) && step.n >= undo.fromStretch && step.n <= undo.throughStretch) step.status = 'undone';
  const active = new Set(view.stretches.filter((step) => step.workId === work.id && step.status !== 'undone').map((step) => step.n));
  work.counters = zeroCounters(); work.constraints = []; delete work.latestPlanRef; delete work.approvedPlanRef;
  let summary = emptySummary(work.request); let verificationApplies = true;
  for (const event of history) {
    if (event.type === 'stretch-start') {
      const step = StretchSchema.parse(ledger.data(event)); if (step.workId !== work.id) continue;
      if (!active.has(step.n)) { verificationApplies = false; continue; }
      work.counters.stretches++; if (['review', 'adversarial-review'].includes(step.action)) work.counters.reviews++;
    } else if (event.type === 'stretch-end' && event.stretch !== undefined && active.has(event.stretch)) {
      const result = StretchFinishedSchema.parse(ledger.data(event)); const handoff = view.handoffs.find((entry) => entry.stretch === event.stretch)!;
      const findings = history.filter((entry) => entry.id < event.id && entry.type === 'finding' && entry.stretch === event.stretch).map((entry) => FindingSchema.parse(ledger.data(entry)));
      summary = applyCompletion(work, summary, result, handoff, findings); verificationApplies = true;
    } else if (event.type === 'verification' && verificationApplies) {
      const receipt = VerificationSchema.parse(ledger.data(event)); if (receipt.workId === work.id) applyVerification(work, receipt);
    } else if (event.type === 'undo') {
      if (UndoAppliedSchema.parse(ledger.data(event)).workId === work.id) verificationApplies = true;
    } else if (event.type === 'state') {
      const value = WorkControlSchema.safeParse(ledger.data(event));
      if (value.success && value.data.kind === 'plan-approved' && value.data.ref === work.latestPlanRef) work.approvedPlanRef = value.data.ref;
    }
  }
  view.summary = summary; view.conversation.generation++; view.conversation.state = 'waiting-for-you';
  const current = view.stretches.filter((step) => step.status !== 'undone').at(-1);
  if (current) view.conversation.current = { modelId: current.modelId, effort: current.effortEffective }; else delete view.conversation.current;
  view.pause = { schema: 'work-control-v1', kind: 'pause', state: 'waiting-for-you', reason: `Steps ${undo.fromStretch} to ${undo.throughStretch} were undone. Redo has not started.` };
  if (undo.keepClosed) {
    work.closedAs = undo.keepClosed.as; work.closedAt = undo.keepClosed.at; view.closedWorks.push(work); view.conversation.work = null;
    view.conversation.state = undo.keepClosed.as === 'cancelled' ? 'cancelled' : 'done'; delete view.pause;
  } else delete view.conversation.outcome;
}

/** Pure recovery: history never launches a runtime or makes a routing decision. */
export function replayWork(ledger: ConversationLedger): ConversationView {
  let view: ConversationView | undefined;
  const composer = new Map<string, ReturnType<typeof ComposerOverrideRecordSchema.parse>>();
  const events = ledger.events();
  for (const event of events) {
    const data = ledger.data(event);
    if (!view) {
      const created = ConversationCreatedSchema.parse(data);
      if (event.type !== 'state' || created.conversation.id !== ledger.id) throw new Error('Conversation creation record is missing.');
      view = { conversation: created.conversation, summary: emptySummary(), closedWorks: [], stretches: [], handoffs: [], messages: [], finishes: [] };
      continue;
    }
    const conversation = view.conversation;
    if (event.type === 'user-message' || event.type === 'note') {
      if (view.finishes.some((entry) => entry.status !== 'completed')) throw new Error('Finish the pending outside outcome before adding another message.');
      const message = WorkMessageSchema.parse(data);
      if (view.messages.some((entry) => entry.clientMessageId === message.clientMessageId)) throw new Error('Duplicate message in conversation history.');
      if (!conversation.work) {
        if (event.type === 'note') throw new Error('A note cannot open work.');
        conversation.work = WorkSchema.parse({ schema: 'work-v1', id: message.workId, requestEventId: String(event.id), request: message.text, messageEventIds: [], constraints: [], counters: { stretches: 0, reviews: 0, noProgress: 0, testFailures: 0, costUsd: 0, unknownCostStretches: 0 }, allowance: { stretches: message.initialAllowance, grants: [] }, openedAt: event.t });
        view.summary = emptySummary(message.text);
        delete conversation.outcome;
      } else {
        if (conversation.work.id !== message.workId) throw new Error('Message belongs to another work.');
        conversation.work.messageEventIds.push(String(event.id));
      }
      if (message.allowanceGranted) {
        conversation.work.allowance.stretches += message.allowanceGranted;
        conversation.work.allowance.grants.push({ at: event.t, extra: message.allowanceGranted, via: 'reply' });
      }
      view.messages.push({ id: event.id, type: event.type, clientMessageId: message.clientMessageId, text: message.text, workId: message.workId, ...(message.answer ? { answer: message.answer } : {}) });
      conversation.generation++;
      if (event.type === 'user-message') { delete view.pause; if (conversation.state !== 'running') conversation.state = 'idle'; }
    } else if (event.type === 'allowance') {
      const grant = AllowanceEventSchema.parse(data);
      if (grant.via === 'button') {
        if (conversation.work?.id !== grant.workId) throw new Error('Allowance belongs to another work.');
        conversation.work.allowance.stretches += grant.extra;
        conversation.work.allowance.grants.push({ at: event.t, extra: grant.extra, via: 'button' });
        conversation.generation++; conversation.state = 'idle'; delete view.pause;
      } // Reply grants are part of the message transaction; this is its receipt.
    } else if (event.type === 'stretch-start') {
      if (view.finishes.some((entry) => entry.status !== 'completed')) throw new Error('A pending outside outcome cannot launch another stretch.');
      const stretch = StretchSchema.parse(data);
      if (!conversation.work || stretch.workId !== conversation.work.id || stretch.n !== conversation.stretchCount + 1 || view.stretches.some((entry) => entry.status === 'running')) throw new Error('Invalid or concurrent stretch in history.');
      view.stretches.push(stretch); conversation.stretchCount++;
      conversation.work.counters.stretches++;
      if (['review', 'adversarial-review'].includes(stretch.action)) conversation.work.counters.reviews++;
      conversation.current = { modelId: stretch.modelId, effort: stretch.effortEffective };
      conversation.state = 'running'; delete view.pause;
    } else if (event.type === 'handoff') {
      const handoff = HandoffSchema.parse(data);
      if (view.handoffs.some((entry) => entry.stretch === handoff.stretch)) throw new Error('Duplicate handoff in conversation history.');
      view.handoffs.push(handoff);
    } else if (event.type === 'stretch-end') {
      const result = StretchFinishedSchema.parse(data); const stretch = result.stretch;
      const index = view.stretches.findIndex((entry) => entry.n === stretch.n);
      const previous = view.stretches[index]; const work = conversation.work;
      const handoff = view.handoffs.find((entry) => entry.stretch === stretch.n);
      if (!previous || previous.status !== 'running' || !work || work.id !== stretch.workId || !handoff || stretch.status === 'running' || stretch.status === 'undone') throw new Error('Invalid stretch completion in history.');
      view.stretches[index] = stretch;
      const findings = events.filter((entry) => entry.id < event.id && entry.type === 'finding' && entry.stretch === stretch.n).map((entry) => FindingSchema.parse(ledger.data(entry)));
      view.summary = applyCompletion(work, view.summary, result, handoff, findings);
      conversation.state = result.pause?.state ?? 'idle';
      if (result.pause) view.pause = result.pause;
    } else if (event.type === 'verification') {
      const verification = VerificationSchema.parse(data);
      if (conversation.work?.id === verification.workId) applyVerification(conversation.work, verification);
    } else if (event.type === 'undo') {
      applyUndo(view, UndoAppliedSchema.parse(data), events.filter((entry) => entry.id < event.id), ledger, event.t);
    } else if (event.type === 'decision') {
      for (const record of composerDecisionRecords(composer, DecisionRecordSchema.parse(data))) replayComposerChoice(conversation, composer, record);
    } else if (event.type === 'override') {
      const choice = ComposerOverrideRecordSchema.safeParse(data);
      if (choice.success) replayComposerChoice(conversation, composer, choice.data);
      else {
        const correction = OverrideRecordSchema.parse(data);
        if (correction.conversationId !== conversation.id || correction.request.generation !== conversation.generation) throw new Error('Correction is stale or belongs to another conversation.');
        conversation.generation++;
      }
    } else if (event.type === 'conversation-control') {
      applyConversationControl(view, data, event.t);
    } else if (event.type === 'state') {
      const control = WorkControlSchema.parse(data); const work = conversation.work;
      switch (control.kind) {
        case 'pause':
          if (!work || conversation.state === 'running') throw new Error('Cannot pause without settled open work.');
          conversation.state = control.state; view.pause = control; break;
        case 'base-commit':
          if (!work || (work.baseCommit && work.baseCommit !== control.commit)) throw new Error('Work base commit cannot be replaced.');
          work.baseCommit = control.commit; break;
        case 'plan-approved':
          if (!work || work.latestPlanRef !== control.ref || conversation.generation !== control.generation) throw new Error('Plan approval is stale.');
          work.approvedPlanRef = control.ref; conversation.generation++; conversation.state = 'idle'; delete view.pause; break;
        case 'close':
          if (!work || conversation.state === 'running') throw new Error('Running work cannot close before process termination.');
          view.closedWorks.push(WorkSchema.parse({ ...work, closedAt: event.t, closedAs: control.closedAs }));
          conversation.work = null; conversation.state = control.closedAs === 'cancelled' ? 'cancelled' : 'done'; conversation.generation++; delete view.pause; break;
        case 'native': {
          const stretch = view.stretches.find((entry) => entry.n === control.n);
          if (!stretch || stretch.status !== 'running') throw new Error('Native identity belongs to no running stretch.');
          stretch.native = control.native; break;
        }
        case 'pins':
          if (control.modelId !== undefined) { if (control.modelId === null) delete conversation.pins.modelId; else conversation.pins.modelId = control.modelId; }
          if (control.effort !== undefined) { if (control.effort === null) delete conversation.pins.effort; else conversation.pins.effort = control.effort; }
          conversation.generation++; break;
        case 'invalidate': conversation.generation++; break;
        case 'reopen': {
          const closed = view.closedWorks.at(-1);
          if (work || !closed || closed.id !== control.workId) throw new Error('Only the last closed work can reopen, with no other work open.');
          view.closedWorks.pop(); delete closed.closedAt; delete closed.closedAs;
          conversation.work = closed; conversation.state = 'waiting-for-you'; conversation.generation++; delete view.pause; break;
        }
      }
    }
    // Recording a legacy conversation's origin is bookkeeping, not activity in the conversation.
    if (!(event.type === 'conversation-control' && (data as { schema?: unknown }).schema === 'conversation-origin-v1')) conversation.updatedAt = event.t;
  }
  if (!view) throw new Error('Conversation does not exist.');
  ConversationSchema.parse(view.conversation); SummarySchema.parse(view.summary);
  return view;
}

export class ConversationWork {
  constructor(readonly ledger: ConversationLedger, readonly allowance = 24) {
    if (!Number.isSafeInteger(allowance) || allowance < 1) throw new Error('Invalid work allowance.');
  }
  create(input: Pick<Conversation, 'title' | 'projectId' | 'ownerDeviceId' | 'origin'>): ConversationView {
    if (this.ledger.events().length) return this.load();
    const at = new Date().toISOString();
    const conversation = ConversationSchema.parse({ ...input, id: this.ledger.id, schema: 'conversation-v2', createdAt: at, updatedAt: at, state: 'idle', generation: 0, pins: {}, stretchCount: 0, work: null });
    this.ledger.append({ type: 'state', t: at, data: ConversationCreatedSchema.parse({ schema: 'conversation-created-v1', conversation }) });
    return this.#materialise();
  }
  load(): ConversationView { return replayWork(this.ledger); }
  rename(raw: unknown): ConversationView {
    const parsed = RenameConversationSchema.parse(raw); const request = RenameConversationSchema.parse({ ...parsed, title: this.ledger.redact(parsed.title), previousTitle: this.ledger.redact(parsed.previousTitle) });
    const previous = this.ledger.events().filter((event) => event.type === 'conversation-control').map((event) => ConversationRenamedSchema.safeParse(this.ledger.data(event))).find((entry) => entry.success && entry.data.request.clientRequestId === request.clientRequestId);
    if (previous?.success) {
      if (stableJson(previous.data.request) !== stableJson(request)) throw new Error('This rename id was already used for different content.');
      return this.#materialise();
    }
    const data = ConversationRenamedSchema.parse({ schema: 'conversation-renamed-v1', request }); applyConversationControl(this.load(), data, new Date().toISOString());
    this.ledger.append({ type: 'conversation-control', data }); return this.#materialise();
  }
  requestFinishOutside(raw: unknown): FinishOutsideOperation {
    const parsed = FinishOutsideSchema.parse(raw); const request = FinishOutsideSchema.parse({ ...parsed, ...(parsed.reason ? { reason: this.ledger.redact(parsed.reason) } : {}) });
    const view = this.load(); const previous = view.finishes.find((entry) => entry.request.clientRequestId === request.clientRequestId);
    if (previous) {
      if (stableJson(previous.request) !== stableJson(request)) throw new Error('This finish id was already used for different content.');
      return previous;
    }
    const data = FinishOutsideOperationSchema.parse({ schema: 'finish-outside-operation-v1', request, workId: (view.conversation.work ?? view.closedWorks.at(-1))?.id ?? null, status: 'requested' });
    applyConversationControl(view, data, new Date().toISOString()); this.ledger.append({ type: 'conversation-control', data }); this.#materialise(); return data;
  }
  finishOutsideStatus(raw: FinishOutsideOperation): ConversationView {
    const data = FinishOutsideOperationSchema.parse(raw); const view = this.load(); const previous = view.finishes.find((entry) => entry.request.clientRequestId === data.request.clientRequestId);
    if (previous && stableJson(previous) === stableJson(data)) return this.#materialise();
    applyConversationControl(view, data, new Date().toISOString()); this.ledger.append({ type: 'conversation-control', data }); return this.#materialise();
  }
  /** Adds the origin as its own ledger event, so the republished index belongs to a new event. */
  recordOrigin(origin: NonNullable<Conversation['origin']>): ConversationView {
    const view = this.load(); if (view.conversation.origin === origin) return view;
    const data = ConversationOriginSchema.parse({ schema: 'conversation-origin-v1', origin }); applyConversationControl(view, data, new Date().toISOString());
    this.ledger.append({ type: 'conversation-control', data }); return this.#materialise();
  }
  recover(): ConversationView { this.ledger.recoverAbandonedWrite(); this.ledger.recoverHandoffs(); this.#replyReceipts(); return this.#materialise(); }
  #materialise(): ConversationView {
    const view = this.load();
    this.ledger.writeProjection('conversation.json', ConversationSchema, view.conversation);
    this.ledger.writeProjection('summary.json', SummarySchema, view.summary);
    for (const stretch of view.stretches) this.ledger.writeProjection(`stretches/${String(stretch.n).padStart(4, '0')}.json`, StretchSchema, stretch);
    for (const work of view.closedWorks) this.ledger.writeProjection(`work/${work.id}.json`, WorkSchema, work);
    if (view.conversation.work) this.ledger.writeProjection(`work/${view.conversation.work.id}.json`, WorkSchema, view.conversation.work);
    return view;
  }
  message(text: string, clientMessageId: string, type: 'user-message' | 'note' = 'user-message', allowance = this.allowance, answer?: { stretch: number; option: number; label: string }): { eventId: number; repeated: boolean; correction: boolean; view: ConversationView } {
    text = this.ledger.redact(text);
    const view = this.load(); const existing = view.messages.find((entry) => entry.clientMessageId === clientMessageId);
    if (existing) {
      if (existing.text !== text || existing.type !== type) throw new Error('This message id was already used for different content.');
      this.#replyReceipts(); return { eventId: existing.id, repeated: true, correction: false, view: this.#materialise() };
    }
    if (view.finishes.some((entry) => entry.status !== 'completed')) throw new Error('Finish the pending outside outcome before adding another message.');
    if (type === 'note' && view.conversation.state !== 'running') throw new Error('Notes require a running stretch.');
    if (!Number.isSafeInteger(allowance) || allowance < 1) throw new Error('Invalid work allowance.');
    const data = WorkMessageSchema.parse({ schema: 'work-message-v1', text, clientMessageId, workId: view.conversation.work?.id ?? `work_${randomUUID()}`, initialAllowance: allowance, allowanceGranted: type === 'user-message' && view.pause?.guard ? allowance : 0, ...(answer ? { answer } : {}) });
    const event = this.ledger.append({ type, data }); this.#replyReceipts();
    return { eventId: event.id, repeated: false, correction: type === 'user-message' && view.conversation.state === 'running', view: this.#materialise() };
  }
  #replyReceipts(): void {
    const events = this.ledger.events();
    const recorded = new Set(events.filter((event) => event.type === 'allowance').map((event) => AllowanceEventSchema.parse(this.ledger.data(event)).messageEventId));
    for (const event of events.filter((entry) => entry.type === 'user-message')) {
      const message = WorkMessageSchema.parse(this.ledger.data(event));
      if (message.allowanceGranted && !recorded.has(String(event.id))) this.ledger.append({ type: 'allowance', t: event.t, data: AllowanceEventSchema.parse({ schema: 'allowance-event-v1', workId: message.workId, messageEventId: String(event.id), extra: message.allowanceGranted, via: 'reply' }) });
    }
  }
  #control(input: WorkControl): ConversationView {
    // Validate against an in-memory view before persisting an invalid transition.
    const data = WorkControlSchema.parse(input); const view = this.load(); const work = view.conversation.work;
    if (data.kind !== 'pins' && data.kind !== 'reopen' && !work) throw new Error('There is no open work.');
    if (data.kind === 'reopen' && (work || view.closedWorks.at(-1)?.id !== data.workId)) throw new Error('Only the last closed work can reopen, with no other work open.');
    if (['pause', 'close', 'plan-approved'].includes(data.kind) && view.conversation.state === 'running') throw new Error('The running stretch must finish first.');
    if (data.kind === 'base-commit' && work?.baseCommit && work.baseCommit !== data.commit) throw new Error('Work base commit cannot be replaced.');
    if (data.kind === 'plan-approved' && (work?.latestPlanRef !== data.ref || view.conversation.generation !== data.generation)) throw new Error('Plan approval is stale.');
    if (data.kind === 'native' && !view.stretches.some((stretch) => stretch.n === data.n && stretch.status === 'running')) throw new Error('Native identity belongs to no running stretch.');
    this.ledger.append({ type: 'state', data }); return this.#materialise();
  }
  pause(reason: string, state: 'waiting-for-you' | 'blocked' = 'waiting-for-you', guard?: Extract<WorkControl, { kind: 'pause' }>['guard']): ConversationView {
    return this.#control({ schema: 'work-control-v1', kind: 'pause', reason, state, ...(guard ? { guard } : {}) });
  }
  baseCommit(commit: string): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'base-commit', commit }); }
  approvePlan(ref: string, generation: number): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'plan-approved', ref, generation }); }
  pins(values: { modelId?: string | null; effort?: Conversation['pins']['effort'] | null }): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'pins', ...values }); }
  close(closedAs: 'done' | 'cancelled' | 'closed-by-you'): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'close', closedAs }); }
  reopen(workId: string): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'reopen', workId }); }
  undo(raw: UndoApplied): ConversationView {
    const value = UndoAppliedSchema.parse(raw);
    const previous = this.ledger.events().filter((event) => event.type === 'undo').map((event) => UndoAppliedSchema.parse(this.ledger.data(event))).find((entry) => entry.id === value.id);
    if (previous) {
      if (stableJson(previous) !== stableJson(value)) throw new Error('This undo id was already used for a different operation.');
      return this.#materialise();
    }
    undoTarget(this.load(), value);
    this.ledger.append({ type: 'undo', data: value }); return this.#materialise();
  }
  invalidate(reason: 'cancel' | 'undo' | 'override'): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'invalidate', reason }); }
  composer(raw: unknown): ConversationView {
    const value = ComposerOverrideRecordSchema.parse(raw); const records = new Map(composerOverrides(this).map((entry) => [entry.id, entry]));
    if (stableJson(records.get(value.id)) === stableJson(value) && this.ledger.events().some((event) => event.type === 'override' && stableJson(this.ledger.data(event)) === stableJson(value))) return this.load();
    replayComposerChoice(this.load().conversation, records, value);
    this.ledger.append({ type: 'override', ...(value.stretch ? { stretch: value.stretch } : {}), data: value }); return this.#materialise();
  }
  override(raw: unknown): ConversationView {
    const value = OverrideRecordSchema.parse(raw);
    const previous = this.ledger.events().filter((event) => event.type === 'override').flatMap((event) => { const entry = OverrideRecordSchema.safeParse(this.ledger.data(event)); return entry.success ? [entry.data] : []; }).find((entry) => entry.request.clientRequestId === value.request.clientRequestId);
    if (previous) {
      if (stableJson(previous) !== stableJson(value)) throw new Error('This correction id was already used.');
      return this.#materialise();
    }
    const view = this.load(); const step = view.stretches.find((entry) => entry.n === value.request.stretch);
    if (value.conversationId !== this.ledger.id || value.request.generation !== view.conversation.generation || !step || step.status === 'undone' || step.decisionId !== value.decisionId || step.workId !== value.workId || ![view.conversation.work?.id, view.closedWorks.at(-1)?.id].includes(step.workId)) throw new Error('This step can no longer be corrected.');
    this.ledger.append({ type: 'override', stretch: step.n, data: value }); return this.#materialise();
  }
  native(n: number, native: NonNullable<Stretch['native']>): ConversationView { return this.#control({ schema: 'work-control-v1', kind: 'native', n, native }); }
  start(raw: Stretch, generation: number): ConversationView {
    const stretch = StretchSchema.parse(raw); const view = this.load();
    if (view.finishes.some((entry) => entry.status !== 'completed')) throw new Error('A pending outside outcome cannot launch another stretch.');
    if (view.conversation.generation !== generation) throw new Error('Decision is stale.');
    if (!view.conversation.work || stretch.workId !== view.conversation.work.id || stretch.n !== view.conversation.stretchCount + 1 || stretch.status !== 'running' || view.stretches.some((entry) => entry.status === 'running')) throw new Error('Cannot start this stretch.');
    if (writing(stretch.action) && !view.conversation.work.baseCommit) throw new Error('Writing work needs its base commit recorded.');
    this.ledger.append({ type: 'stretch-start', stretch: stretch.n, data: stretch }); return this.#materialise();
  }
  finish(n: number, values: Pick<Stretch, 'status' | 'usage'> & Partial<Pick<Stretch, 'gitAfter'>>, changed: boolean, correction = false, pause?: Extract<WorkControl, { kind: 'pause' }>): ConversationView {
    const view = this.load(); const previous = view.stretches.find((entry) => entry.n === n);
    if (!previous || previous.status !== 'running' || !view.handoffs.some((entry) => entry.stretch === n) || values.status === 'running' || values.status === 'undone') throw new Error('Stretch completion requires a running stretch and its handoff.');
    const stretch = StretchSchema.parse({ ...previous, ...values, endedAt: new Date().toISOString() });
    this.ledger.append({ type: 'stretch-end', stretch: n, data: StretchFinishedSchema.parse({ schema: 'stretch-finished-v1', stretch, changed, correction, ...(pause ? { pause } : {}) }) }); return this.#materialise();
  }
  runtimeEvent(type: LedgerEvent['type'], data: unknown, stretch: number): LedgerEvent {
    if (!['text', 'thinking', 'tool-start', 'tool-end', 'usage', 'finding', 'error'].includes(type)) throw new Error('Not a runtime event.');
    if (!this.load().stretches.some((entry) => entry.n === stretch && entry.status === 'running')) throw new Error('Runtime event belongs to no running stretch.');
    return this.ledger.append({ type, data: type === 'finding' ? FindingSchema.parse(data) : data, stretch });
  }
}
