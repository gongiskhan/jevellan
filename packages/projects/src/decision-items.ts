import { createHash } from 'node:crypto';
import {
  DecisionAnswerSchema, ProjectDecisionSchema, newId, type CoordinatorEvent, type DecisionAnswer, type Option, type ProjectDecision, type ProjectHub, type Thread, type ThreadReport,
} from '@jevellan/core';
import { ALLOW_MORE_TURNS, QUESTION_NOT_FOUND, STOPPED_AT_TURN_LIMIT, STOP_THE_THREAD, UNKNOWN_OPTION, turnLimitQuestion } from './copy.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
/** A stable id for a delivery that a retry must not repeat (the receiver dedupes by id). */
export function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40)}`;
}
const open = (decision: ProjectDecision) => !decision.answer && !decision.withdrawnAt;
/** The turn-limit item: from the thread, with exactly its two option labels (D31). */
export function isTurnLimitItem(decision: Pick<ProjectDecision, 'from' | 'options'>): boolean {
  return decision.from === 'thread' && decision.options.length === 2 && decision.options[0]!.label === ALLOW_MORE_TURNS && decision.options[1]!.label === STOP_THE_THREAD;
}
/**
 * What the owner can do to a thread when answering its item; a thread on another device gets them as commands, and `commandId`
 * makes a retried answer apply once there (D265).
 */
export type DecisionThreadActions = {
  allowTurns(projectId: string, threadId: string, commandId: string): Promise<void>;
  stop(projectId: string, threadId: string, reason: string, commandId: string): Promise<void>;
  /** An owner message; `messageId` makes a retried answer deliver once. */
  message(projectId: string, threadId: string, text: string, messageId: string): Promise<unknown>;
};
export type DecisionItemsOptions = {
  hub: Pick<ProjectHub, 'decisions' | 'decision' | 'createDecision' | 'withdrawDecision' | 'answerDecision'>;
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  /** Bound after construction: the thread service is built later. */
  threads(): DecisionThreadActions;
  now?(): number;
};

/**
 * Questions to the owner (brief 5.9). Coordinator questions are answered back to the coordinator as `decision-answer`
 * events; thread items (the turn limit and the thread fallback, decision 7) act on the thread directly. Answers are a
 * first-wins compare-and-swap on the hub; a retried answer delivers the same event id, so it reaches the coordinator once.
 */
export class DecisionItems {
  readonly #o: DecisionItemsOptions & { now(): number };
  constructor(o: DecisionItemsOptions) { this.#o = { ...o, now: o.now ?? Date.now }; }
  #at(): string { return new Date(this.#o.now()).toISOString(); }
  async #decision(projectId: string, decisionId: string): Promise<ProjectDecision> {
    const decision = (await this.#o.hub.decision(decisionId))?.document;
    if (!decision || decision.projectId !== projectId) throw refuse(QUESTION_NOT_FOUND, 404);
    return decision;
  }
  async #create(projectId: string, input: { question: string; options: Option[]; threadId?: string | undefined }, from: ProjectDecision['from'],
    fixed?: { id: string; at: string }): Promise<string> {
    const id = fixed?.id ?? newId('pdec', this.#o.now());
    await this.#o.hub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id, projectId, from, question: input.question,
      options: input.options, createdAt: fixed?.at ?? this.#at(), ...(input.threadId === undefined ? {} : { threadId: input.threadId }) }));
    return id;
  }
  /** `jevellan_ask_user` (phase 2): a coordinator question, optionally about one thread. */
  ask(projectId: string, input: { question: string; options?: Option[] | undefined; threadId?: string | undefined }, from: ProjectDecision['from']): Promise<string> {
    return this.#create(projectId, { ...input, options: input.options ?? [] }, from);
  }
  /**
   * The thread fallback (decision 7): a needs-decision report becomes the owner's question directly when the coordinator
   * cannot take it. Used by the coordinator's fallback (phase 2) and by an owner device whose coordinator is offline (phase 5).
   */
  fromReport(projectId: string, threadId: string, report: Pick<ThreadReport, 'question' | 'options' | 'summary'>, fixed?: { id: string; at: string }): Promise<string> {
    return this.#create(projectId, { question: report.question ?? report.summary, options: report.options ?? [], threadId }, 'thread', fixed);
  }
  /**
   * The coordinator's fallback (decision 7, D32): each queued needs-decision report becomes the owner's question under an id
   * derived from its event, created at the event's time, so a repeated fallback (a crash before the coordinator recorded it,
   * a retry after a hub error) creates nothing new, even after the owner answered. Returns the event ids now covered.
   */
  async fallbackFromReports(projectId: string, events: readonly CoordinatorEvent[]): Promise<string[]> {
    const covered: string[] = [];
    for (const event of events) {
      if (event.kind !== 'thread-report' || event.report.status !== 'needs-decision') continue;
      const id = derivedId('pdec', 'fallback', event.id);
      if (!(await this.#o.hub.decision(id))) await this.fromReport(projectId, event.threadId, event.report, { id, at: event.at });
      covered.push(event.id);
    }
    return covered;
  }
  /** Withdraws an open question; false when it was already answered. */
  async withdraw(projectId: string, decisionId: string): Promise<boolean> {
    const decision = await this.#decision(projectId, decisionId);
    if (decision.answer) return false;
    const stored = (await this.#o.hub.withdrawDecision(decisionId, this.#at())).document;
    return !!stored.withdrawnAt && !stored.answer;
  }
  /** Creates the turn-limit item once per thread: an open one is kept (brief 8.2, D31, D142). */
  async turnLimit(projectId: string, thread: Pick<Thread, 'id' | 'title' | 'turnAllowance'>): Promise<void> {
    if ((await this.#o.hub.decisions(projectId)).some((decision) => decision.threadId === thread.id && open(decision) && isTurnLimitItem(decision))) return;
    await this.#create(projectId, { question: turnLimitQuestion(thread.title, thread.turnAllowance), options: [{ label: ALLOW_MORE_TURNS }, { label: STOP_THE_THREAD }], threadId: thread.id }, 'thread');
  }
  /** A thread that Jevellan itself unblocked or stopped withdraws its open turn-limit item silently (D85). */
  async withdrawTurnLimit(projectId: string, threadId: string): Promise<void> {
    for (const decision of await this.#o.hub.decisions(projectId)) {
      if (decision.threadId === threadId && open(decision) && isTurnLimitItem(decision)) await this.#o.hub.withdrawDecision(decision.id, this.#at());
    }
  }
  /**
   * The owner's answer (brief 11). The hub keeps the first answer; then a coordinator question becomes a `decision-answer`
   * event, a turn-limit item allows turns or stops the thread (D31), and any other thread item reaches the thread as an
   * owner message. Every route is safe to repeat, because `repeated` is also reported to the retry of a lost reply.
   */
  async answer(projectId: string, decisionId: string, request: { clientRequestId: string; optionLabel?: string | undefined; text?: string | undefined }): Promise<{ repeated: boolean }> {
    const asked = await this.#decision(projectId, decisionId);
    const answer: DecisionAnswer = DecisionAnswerSchema.parse({ ...(request.optionLabel ? { optionLabel: request.optionLabel } : {}), ...(request.text ? { text: request.text } : {}) });
    if (answer.optionLabel !== undefined && !asked.options.some((option) => option.label === answer.optionLabel)) throw refuse(UNKNOWN_OPTION, 400);
    const { decision: stored, repeated } = await this.#o.hub.answerDecision(decisionId, answer, this.#at(), request.clientRequestId);
    const decision = stored.document; const given = decision.answer ?? answer;
    if (decision.from === 'coordinator') {
      const at = this.#o.now();
      await this.#o.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'decision-answer', id: derivedId('cev', 'answer', decisionId), at: new Date(at).toISOString(),
        decisionId, ...(decision.threadId === undefined ? {} : { threadId: decision.threadId }), question: decision.question, answer: given });
      return { repeated };
    }
    if (decision.threadId === undefined) return { repeated };
    const threads = this.#o.threads();
    const commandId = derivedId('tcmd', 'answer', decisionId);
    if (isTurnLimitItem(decision) && given.optionLabel === STOP_THE_THREAD) { await threads.stop(projectId, decision.threadId, STOPPED_AT_TURN_LIMIT, commandId); return { repeated }; }
    if (isTurnLimitItem(decision) && given.optionLabel === ALLOW_MORE_TURNS) {
      await threads.allowTurns(projectId, decision.threadId, commandId);
      if (given.text) await threads.message(projectId, decision.threadId, given.text, derivedId('tmsg', 'answer', decisionId));
      return { repeated };
    }
    const text = isTurnLimitItem(decision) ? given.text : [given.optionLabel, given.text].filter(Boolean).join('\n\n');
    if (text) await threads.message(projectId, decision.threadId, text, derivedId('tmsg', 'answer', decisionId));
    return { repeated };
  }
}
