import { createHash } from 'node:crypto';
import type { AccountService } from '@jevellan/accounts';
import {
  HubUnavailable, ThreadReportSchema, isTerminal, liveWork, newId, stableJson, type CoordinatorEvent, type Project, type ProjectWorkSettings, type QueuedMessage, type SecretRedactor, type Thread,
  type ThreadReport, type ThreadState,
} from '@jevellan/core';
import type { Admission } from './admission.js';
import type { ProjectMemoryReader, ProjectToolHandlers } from './bridge-tools.js';
import { ProjectTools } from './bridge-tools.js';
import {
  DISCARD_REFUSED, MESSAGE_ID_REUSED, MORE_TURNS, NO_CHANGES, NO_SESSION_TO_ATTACH, OWNER_STOPPED_THREAD, PROCESS_UNCONFIRMED, RESTART_OPEN_PULL_REQUEST,
  RESTART_PUBLISHED_TO_MAIN, TESTS_FAILED_THREE_TIMES, THREAD_ALREADY_RESTARTED, THREAD_ENDED, THREAD_NOT_FOUND, THREAD_WORKING, TOOL_NOT_IN_TURN, TURN_FAILED, TURN_LIMIT_REACHED,
  TURN_TIMED_OUT, TURN_WITHOUT_REPORT, VERIFICATION_ATTEMPTS, WAITING_FOR_HUB, WORKTREE_DISCARDED, accountMovedNotice, alreadyAttached, cleanupFailed, commitsSavedReason, isRestarted,
  mainCheckoutKept, mainConflictPrompt, messagesPrompt, ownerWorkedLine, savedCommitsRef, sessionNotAdopted, taskPrompt, threadPrompt, threadStepFailed, threadSystemAppend,
  verificationFailurePrompt, worktreeSetupFailed, type ThreadTurnReason,
} from './copy.js';
import type { DecisionItems } from './decision-items.js';
import { firstLine } from './git.js';
import type { LaunchResult, TurnLauncher } from './launch.js';
import type { ProjectLedgers } from './ledger.js';
import type { MailService } from './mail.js';
import type { MainCheckout } from './main-checkout.js';
import type { PublicationResult, ThreadPublication } from './publication.js';
import type { ThreadEvent, ThreadStore } from './stores.js';
import { TurnExecution, type TurnOutcome } from './turn-execution.js';
import type { ThreadWorktree } from './worktree.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
type EventBody = CoordinatorEvent extends infer E ? E extends CoordinatorEvent ? Omit<E, 'schema' | 'id' | 'at'> : never : never;

// Pure transitions (brief 8.2, design 2.6.9), exported for unit tests.

/** States without live work in which a message starts the next turn (through admission, D9). */
export const REST_STATES: readonly ThreadState[] = ['idle', 'in-review', 'waiting-for-you'];
const atRest = (state: ThreadState) => REST_STATES.includes(state);
export const atTurnLimit = (thread: Pick<Thread, 'turns' | 'turnAllowance'>): boolean => thread.turns >= thread.turnAllowance;
/** A thread state with its reason replaced (removed when none). */
export function withState(thread: Thread, state: ThreadState, reason?: string): Thread {
  const next: Thread = { ...thread, state };
  if (reason) next.stateReason = reason.slice(0, 400); else delete next.stateReason;
  return next;
}
export type NextTurn = { reason: ThreadTurnReason; body: string; messages: string[] };
/** The queued messages as one turn (D22); the ids leave the queue when the turn starts. */
export function messagesTurn(thread: Pick<Thread, 'queuedMessages'>, reason: 'messages' | 'steer'): NextTurn {
  return { reason, body: messagesPrompt(thread.queuedMessages), messages: thread.queuedMessages.map((message) => message.id) };
}
export type TurnRun = { status: 'completed' | 'failed' | 'timed-out' | 'unavailable'; error?: string | undefined; finalText?: string | undefined };
/**
 * The report Jevellan writes when the thread did not (brief 8.2): a completed turn is `progress` with the last 1,200 characters
 * of its final message; a failed, timed-out or unlaunchable turn is `blocked` with its error.
 */
export function synthesizedReport(run: TurnRun, turn: number): ThreadReport {
  const summary = run.status === 'completed' ? (run.finalText ?? '').slice(-1200) || TURN_WITHOUT_REPORT
    : (run.error?.trim() || (run.status === 'timed-out' ? TURN_TIMED_OUT : TURN_FAILED)).slice(0, 1200);
  return ThreadReportSchema.parse({ schema: 'thread-report-v1', turn, status: run.status === 'completed' ? 'progress' : 'blocked', summary, changedFiles: [], synthesized: true });
}
export type TurnEndAction = { kind: 'publish' } | { kind: 'limit' } | { kind: 'decision'; reason: string } | { kind: 'continue' } | { kind: 'idle' };
/**
 * What follows a reported turn, in the D73 order: done publishes (also at the limit); a limit reached by any other report
 * waits for the owner; needs-decision waits with its question; progress or blocked continue with queued messages (D72) or rest.
 */
export function turnEndAction(thread: Pick<Thread, 'turns' | 'turnAllowance' | 'queuedMessages'>, report: Pick<ThreadReport, 'status' | 'question'>): TurnEndAction {
  if (report.status === 'done') return { kind: 'publish' };
  if (atTurnLimit(thread)) return { kind: 'limit' };
  if (report.status === 'needs-decision') return { kind: 'decision', reason: firstLine(report.question ?? '').slice(0, 400) };
  return thread.queuedMessages.length ? { kind: 'continue' } : { kind: 'idle' };
}
/** Where a message goes by thread state (2.6.9 deliver): refused, steering the running turn, after the step, or a turn now. */
export function deliveryRoute(state: ThreadState): 'ended' | 'running' | 'later' | 'rest' {
  return isTerminal(state) ? 'ended' : state === 'running' ? 'running' : atRest(state) ? 'rest' : 'later';
}
/** The reason after Discard (2.6.9): the old reason with ` Worktree discarded.`, kept within 400 characters. */
export function discardedReason(reason: string | undefined): string {
  return `${(reason ?? '').slice(0, 400 - WORKTREE_DISCARDED.length)}${WORKTREE_DISCARDED}`.trim();
}
/** The worktree is gone: discarded, or removed by a restart (D252). */
export const isDiscarded = (reason: string | undefined): boolean => !!reason?.endsWith(WORKTREE_DISCARDED.trim()) || isRestarted(reason);
/** Why Restart is not allowed (brief 10): an open pull request, a publication to main, or an earlier restart (D252). */
export function restartRefusal(thread: Pick<Thread, 'pr' | 'isolation' | 'publishedCommit' | 'stateReason'>): string | undefined {
  if (thread.pr?.state === 'open') return RESTART_OPEN_PULL_REQUEST;
  if (thread.isolation === 'main' && thread.publishedCommit) return RESTART_PUBLISHED_TO_MAIN;
  return isRestarted(thread.stateReason) ? THREAD_ALREADY_RESTARTED : undefined;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const SEEN_MESSAGES = 200;

export type ThreadRunnerContext = {
  deviceId: string; deviceName: string; redactor: SecretRedactor;
  store: ThreadStore; ledgers: ProjectLedgers;
  project(projectId: string): Promise<Project>;
  /** Work settings (the hub copy, or the last good one during an outage). */
  workSettings(projectId: string): Promise<ProjectWorkSettings>;
  worktrees: Pick<ThreadWorktree, 'create' | 'setup' | 'exists' | 'remove' | 'repository'>;
  /** Main isolation (brief 8.2 step 4 main, D29): the claimed project checkout. */
  main: Pick<MainCheckout, 'prepare' | 'ready' | 'workspace' | 'release' | 'stop'>;
  publication: Pick<ThreadPublication, 'publishWorktree' | 'publishMain'>;
  launcher: Pick<TurnLauncher, 'launch'>;
  accounts: Pick<AccountService, 'recordUsage' | 'recordError'>;
  admission: Pick<Admission, 'admit'>;
  decisions: Pick<DecisionItems, 'turnLimit' | 'withdrawTurnLimit'>;
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  /** Read-only project memory for the thread's tools. */
  memory(project: Project): ProjectMemoryReader;
  /** Mail and reservations, the main-isolation thread tools (brief 7.2). */
  mail: Pick<MailService, 'threadTool' | 'releaseThread'>;
  /** The runtime adapter's display name (D83). */
  runtimeName(runtime: string): string;
  enterOperation(id: string, title: string): () => void;
  /** The thread left live work: queued starts and turns waiting for a slot may run now. */
  rested(projectId: string): void;
  /**
   * The owner device's decision fallback for the project (decision 7, D280): its waiting needs-decision reports become the owner's
   * questions now when the coordinator's device is away. Never fails.
   */
  askDirectly(projectId: string): Promise<void>;
  timers: { threadTurnTimeoutMs: number; setupTimeoutMs: number };
  now(): number;
};
type Ran = { status: TurnOutcome['status'] | 'unavailable' | 'unconfirmed'; error?: string | undefined; finalText?: string; report?: ThreadReport | undefined };

/**
 * One local thread on its owner device (brief 8.2-8.4): preparation, turns, acting on reports, publication with the
 * three-attempt verification loop, the turn limit, stop, discard and allow-turns. Every step runs on one promise chain per
 * thread; messages and stops reach a running turn at once. A daemon shutdown never rewrites the state (D24): restart
 * recovery does.
 */
export class ThreadRunner {
  readonly #c: ThreadRunnerContext;
  #chain: Promise<void> = Promise.resolve();
  #pending = 0;
  #execution: TurnExecution | undefined;
  #turn: number | undefined;
  #steer = false;
  readonly #abort = new AbortController();
  #stopping: string | undefined;
  #concluding = 0;
  #closed = false;
  #hold: (() => void) | undefined;
  constructor(readonly threadId: string, context: ThreadRunnerContext) { this.#c = context; }
  /** A step is running or waiting on this thread's chain. */
  get busy(): boolean { return this.#pending > 0; }
  /** The thread's running turn is `turn` (bridge tokens are valid only then). */
  isCurrent(turn: number): boolean { return this.#turn === turn; }
  #thread(): Thread { const thread = this.#c.store.get(this.threadId); if (!thread) throw refuse(THREAD_NOT_FOUND, 404); return thread; }
  #at(): string { return new Date(this.#c.now()).toISOString(); }
  #message(error: unknown): string { return this.#c.redactor.text(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim(); }
  /** Stopping, concluding (a merge or close), or shutting down: no further step starts. */
  #halted(): boolean { return this.#closed || this.#stopping !== undefined || this.#concluding > 0; }
  #serial<T>(task: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#chain.then(task);
    this.#chain = result.then(() => undefined, () => undefined).finally(() => { this.#pending -= 1; });
    return result;
  }
  #releaseHold(): void { const hold = this.#hold; this.#hold = undefined; hold?.(); }
  /** A step of work: an admission hold is kept until the thread is live; nothing is left live at the end (D156). */
  #work(task: () => Promise<void>, hold?: () => void): Promise<void> {
    return this.#serial(async () => {
      this.#releaseHold(); this.#hold = hold;
      try { if (!this.#closed) await task(); }
      catch (error) { if (!this.#closed) await this.#unexpected(error); }
      finally { this.#releaseHold(); this.#settle(); }
    });
  }
  /** Writes the thread, releasing the admission hold once it is live and announcing when it leaves live work. */
  #set(mutate: (thread: Thread) => Thread, event?: ThreadEvent): Thread {
    const before = this.#thread();
    const thread = this.#c.store.update(this.threadId, mutate, event);
    if (liveWork(thread.state)) this.#releaseHold();
    if (liveWork(before.state) && !liveWork(thread.state)) this.#c.rested(thread.projectId);
    return thread;
  }
  async #tell(projectId: string, body: EventBody, fixed?: { id: string; at: string }): Promise<void> {
    const at = this.#c.now();
    await this.#c.toCoordinator(projectId, { schema: 'coordinator-event-v1', id: fixed?.id ?? newId('cev', at), at: fixed?.at ?? new Date(at).toISOString(), ...body } as CoordinatorEvent);
  }
  #notice(thread: Thread, text: string, kind: 'info' | 'error'): void {
    this.#c.ledgers.thread(thread.projectId, thread.id).append({ type: 'notice', data: { schema: 'project-notice-v1', text, kind } });
  }
  #settle(): void {
    if (this.#closed || this.#stopping !== undefined) return;
    const thread = this.#c.store.get(this.threadId);
    if (thread && liveWork(thread.state)) this.#set((current) => withState(current, 'idle'));
  }
  async #unexpected(error: unknown): Promise<void> {
    try {
      const thread = this.#thread();
      // The hub is unreachable before a turn with waiting messages starts (D273): no failure. The thread rests with its messages
      // and the waiting sweep starts them once the hub answers; the notice is written once per wait, not at every sweep.
      if (error instanceof HubUnavailable && thread.queuedMessages.length && this.#stopping === undefined && (liveWork(thread.state) || atRest(thread.state))) {
        if (thread.stateReason === WAITING_FOR_HUB && atRest(thread.state)) return;
        this.#notice(thread, this.#message(error), 'error');
        this.#set((current) => withState(current, atRest(current.state) ? current.state : 'idle', WAITING_FOR_HUB));
        return;
      }
      const text = threadStepFailed(this.#message(error));
      this.#notice(thread, text, 'error');
      if (!liveWork(thread.state) || this.#stopping !== undefined) return;
      const rested = this.#set((current) => withState(current, 'idle', text));
      await this.#tell(rested.projectId, { kind: 'thread-interrupted', threadId: rested.id, reason: 'failed', message: text.slice(0, 1000) });
    } catch { /* The thread files themselves failed; restart recovery repairs the state. */ }
  }
  async #fail(reason: string): Promise<void> {
    const thread = this.#set((current) => ({ ...withState(current, 'failed', reason), endedAt: current.endedAt ?? this.#at() }));
    await this.#releaseReservations(thread);
    await this.#tell(thread.projectId, { kind: 'thread-interrupted', threadId: thread.id, reason: 'failed', message: reason.slice(0, 1000) });
  }
  /**
   * A main thread that stopped, failed or published gives its reservations back (brief 7.2, design 3.6). They are advisory and
   * expire by themselves, so a hub that cannot be reached now changes nothing else; worktree threads hold none and ask nothing.
   */
  async #releaseReservations(thread: Thread): Promise<void> {
    if (thread.isolation !== 'main') return;
    await this.#c.mail.releaseThread(thread.projectId, thread.id).catch(() => undefined);
  }

  /** `queued` or `preparing` -> worktree and setup -> the first turn (brief 8.2 steps 4-5). `hold` is released once the thread is live. */
  prepare(hold?: () => void): Promise<void> {
    return this.#work(async () => {
      let thread = this.#thread();
      if (this.#halted() || (thread.state !== 'queued' && thread.state !== 'preparing')) return;
      if (thread.state === 'queued') thread = this.#set((current) => withState(current, 'preparing'));
      if (await this.#prepare()) await this.#loop({ reason: 'task', body: taskPrompt(thread.title, thread.task), messages: [] });
    }, hold);
  }
  /**
   * The worktree (brief 8.3) and the setup command, or for main isolation the checkout claim and a clean, fast-forwarded main (8.2
   * step 4 main; no setup command there). Idempotent, so a preparation interrupted by a restart runs again before the next turn (D67);
   * the fields are stored only once preparation passed. False when the thread failed or stopped.
   */
  async #prepare(): Promise<boolean> {
    let thread = this.#thread();
    if (!liveWork(thread.state)) thread = this.#set((current) => withState(current, 'preparing'));
    const release = this.#c.enterOperation(this.threadId, thread.title);
    try {
      const project = await this.#c.project(thread.projectId); const signal = this.#abort.signal;
      if (thread.isolation === 'main') {
        // A stop that arrives meanwhile settles the claim once this step ends (its own step on the chain).
        const made = await this.#c.main.prepare(project, thread);
        if (this.#halted()) return false;
        this.#set((current) => ({ ...current, cwd: made.cwd, baseBranch: made.baseBranch, baseCommit: made.baseCommit }));
        return true;
      }
      const ledger = this.#c.ledgers.thread(thread.projectId, thread.id);
      const made = await this.#c.worktrees.create(project, thread, signal);
      if (made.contextNote) this.#notice(thread, made.contextNote, 'info');
      const fields = { cwd: made.cwd, branch: made.branch, baseBranch: made.baseBranch, baseCommit: made.baseCommit };
      const command = (await this.#c.workSettings(thread.projectId)).setupCommand;
      if (command) {
        const setup = await this.#c.worktrees.setup({ ...thread, ...fields }, command, ledger, { timeoutMs: this.#c.timers.setupTimeoutMs, signal });
        if (this.#halted()) return false;
        // A failed thread keeps its worktree fields, so its branch shows and Discard can remove it.
        if (!setup.ok) { this.#set((current) => ({ ...current, ...fields })); await this.#fail(setup.reason); return false; }
      }
      if (this.#halted()) return false;
      this.#set((current) => ({ ...current, ...fields }));
      return true;
    } catch (error) {
      if (this.#halted()) return false;
      // Main preparation failures are already in thread words (D44): the refusal itself is the reason.
      await this.#fail(thread.isolation === 'main' ? this.#message(error) || TURN_FAILED : worktreeSetupFailed(firstLine(this.#message(error)) || TURN_FAILED));
      return false;
    } finally { release(); }
  }
  async #loop(first: NextTurn | null): Promise<void> {
    let next = first;
    while (next && !this.#halted()) next = await this.#turnOnce(next);
  }
  /** One turn (2.6.9 steps 1 and 3-9); returns the turn that continues the live step, if any. */
  async #turnOnce(next: NextTurn): Promise<NextTurn | null> {
    let thread = this.#thread();
    // Before every turn, also verification turns and messages that arrive at rest (D73).
    if (atTurnLimit(thread)) { await this.#atLimit(); return null; }
    const project = await this.#c.project(thread.projectId);
    // A main thread is prepared once (a second preparation refuses its own commits); later turns only claim the checkout again.
    const ready = thread.isolation === 'main' ? await this.#c.main.ready(project, thread) : !!thread.cwd && await this.#c.worktrees.exists(project, thread);
    if (!ready) {
      if (!(await this.#prepare())) return null;
      thread = this.#thread();
    }
    if (this.#halted()) return null;
    const turn = thread.turns + 1; const ledger = this.#c.ledgers.thread(thread.projectId, thread.id);
    const release = this.#c.enterOperation(this.threadId, thread.title);
    let ran: Ran;
    try {
      this.#steer = false;
      thread = this.#set((current) => ({ ...withState(current, 'running'), queuedMessages: current.queuedMessages.filter((message) => !next.messages.includes(message.id)) }));
      this.#turn = turn;
      ran = await this.#run(project, thread, turn, next);
    } finally { this.#turn = undefined; this.#steer = false; release(); }
    if (ran.status === 'shutdown') return null;
    if (ran.status === 'unconfirmed') { await this.#fail(PROCESS_UNCONFIRMED); return null; }
    const ended = ran.status === 'unavailable' ? 'failed' : ran.status;
    ledger.append({ type: 'thread-turn-end', turn, data: { schema: 'thread-turn-end-v1', turn, status: ended, ...(ran.error ? { error: ran.error } : {}) } });
    if (ran.status === 'stopped') {
      // Stop sets its own state; a merge or close stopped the turn and decides next, else the thread rests.
      if (this.#stopping === undefined && !this.#closed) this.#set((current) => withState(current, 'idle'));
      return null;
    }
    if (ran.status === 'steered') {
      thread = this.#set((current) => ({ ...current, turns: current.turns + 1 }));
      if (atTurnLimit(thread)) { await this.#atLimit(); return null; }
      if (thread.queuedMessages.length) return messagesTurn(thread, 'steer');
      this.#set((current) => withState(current, 'idle'));
      return null;
    }
    const report = ran.report ?? synthesizedReport({ status: ran.status, error: ran.error, finalText: ran.finalText }, turn);
    thread = this.#set((current) => ({ ...current, turns: current.turns + 1, lastReport: report }), { type: 'thread-report', data: report, turn });
    return this.#act(thread, report);
  }
  /** Launch and drain one turn. The grant is closed and the process gone before this returns. */
  async #run(project: Project, thread: Thread, turn: number, next: NextTurn): Promise<Ran> {
    const placement = thread.placement; const labels = this.#c.store.labels(thread.id);
    const ledger = this.#c.ledgers.thread(thread.projectId, thread.id);
    const tools = new ProjectTools({ kind: 'thread', projectId: thread.projectId, threadId: thread.id, turn, isolation: thread.isolation }, this.#handlers(), this.#c.redactor);
    let launched: LaunchResult;
    try {
      launched = await this.#c.launcher.launch({ owner: { kind: 'thread', projectId: thread.projectId, id: thread.id }, turn, runtime: placement.runtime, modelId: placement.modelId,
        model: placement.model, modelLabel: labels.modelLabel, effort: placement.effortEffective, pinnedAccountId: placement.accountId, permissions: 'write', cwd: thread.cwd,
        systemAppend: threadSystemAppend({ projectName: project.name, cwd: thread.cwd, isolation: thread.isolation, branch: thread.branch, baseBranch: thread.baseBranch,
          deviceName: this.#c.deviceName, testCommand: project.testCommand }),
        prompt: (resumed) => threadPrompt(thread, next.body, resumed, next.reason), ...(thread.nativeSessionId ? { resume: thread.nativeSessionId } : {}),
        safetyProfile: 'thread', timeoutMs: this.#c.timers.threadTurnTimeoutMs, tools, gitIdentityFrom: this.#c.worktrees.repository(project) });
    } catch (error) { await tools.close(); return { status: 'unavailable', error: this.#message(error) }; }
    if (launched.kind === 'unavailable') { await tools.close(); return { status: 'unavailable', error: launched.reason }; }
    const started = launched;
    try {
      if (started.accountChanged) {
        // The session lives in the old account's home (D16): drop it so no later turn tries to resume it here.
        this.#set((current) => { const moved: Thread = { ...current, placement: { ...current.placement, accountId: started.accountId } }; delete moved.nativeSessionId; return moved; });
        this.#notice(thread, accountMovedNotice(started.accountLabel), 'info');
      }
      this.#c.store.setLabels(thread.id, { accountLabel: started.accountLabel });
      if (started.gitIdentity && stableJson(this.#c.store.local(thread.id).gitIdentity ?? null) !== stableJson(started.gitIdentity)) {
        const identity = started.gitIdentity; this.#c.store.updateLocal(thread.id, (local) => ({ ...local, gitIdentity: identity }));
      }
      ledger.append({ type: 'thread-turn-start', turn, data: { schema: 'thread-turn-v1', turn, resumed: started.resumed, runtime: placement.runtime, modelId: placement.modelId,
        model: placement.model, effort: placement.effortEffective, accountId: started.accountId } });
      const execution = new TurnExecution({ run: started.run, accountId: started.accountId, secretRef: started.secretRef, model: placement.model, deviceId: this.#c.deviceId,
        accounts: this.#c.accounts, initialUsage: started.usage, redactor: this.#c.redactor,
        onSession: (sessionId) => { this.#c.store.update(thread.id, (current) => ({ ...current, nativeSessionId: sessionId })); },
        onProcess: (native) => {
          this.#c.store.updateLocal(thread.id, (local) => ({ ...local, process: { turn, pid: native.pid, pgid: native.pgid, ...(native.startIdentity ? { startIdentity: native.startIdentity } : {}), startedAt: this.#at() } }));
        } });
      this.#execution = execution;
      if (this.#closed) void execution.shutdown().catch(() => undefined);
      else if (this.#stopping !== undefined || this.#concluding > 0) void execution.stop().catch(() => undefined);
      else if (this.#steer) void execution.steer().catch(() => undefined);
      let outcome: TurnOutcome;
      // A rejected outcome means the process cleanup was not confirmed: its identity stays recorded for recovery.
      try { outcome = await execution.done; } catch { return { status: 'unconfirmed' }; }
      this.#c.store.updateLocal(thread.id, (local) => { const cleared = { ...local }; delete cleared.process; return cleared; });
      return { status: outcome.status, finalText: outcome.finalText, report: tools.report, ...(outcome.error ? { error: outcome.error.message } : {}) };
    } finally {
      this.#execution = undefined;
      await started.release();
    }
  }
  #handlers(): ProjectToolHandlers {
    return {
      isCurrent: (scope) => scope.kind === 'thread' && scope.threadId === this.threadId && this.isCurrent(scope.turn),
      call: async (scope, name, input) => { if (scope.kind !== 'thread') throw refuse(TOOL_NOT_IN_TURN, 403); return this.#c.mail.threadTool(scope, name, input); },
      memory: async (scope) => this.#c.memory(await this.#c.project(scope.projectId)),
    };
  }
  /** Step 9 in the D73 order. */
  async #act(thread: Thread, report: ThreadReport): Promise<NextTurn | null> {
    const action = turnEndAction(thread, report);
    switch (action.kind) {
      case 'publish': return this.#publish();
      case 'limit': await this.#atLimit(report); return null;
      case 'continue': return messagesTurn(thread, 'messages');
      case 'decision': await this.#report(this.#set((current) => withState(current, 'waiting-for-you', action.reason)), report); return null;
      case 'idle': await this.#report(this.#set((current) => withState(current, 'idle')), report); return null;
    }
  }
  /**
   * The report to the coordinator. A needs-decision report keeps its event on the thread first (D280), so that while the coordinator's
   * device is away this device asks the owner under that event's fallback id, before the report leaves, and at later sweeps.
   */
  async #report(thread: Thread, report: ThreadReport): Promise<void> {
    const now = this.#c.now(); const event = { id: newId('cev', now), at: new Date(now).toISOString() };
    if (report.status === 'needs-decision') {
      this.#c.store.updateLocal(thread.id, (local) => ({ ...local, decisionReport: { eventId: event.id, at: event.at, asked: false } }));
      await this.#c.askDirectly(thread.projectId);
    }
    await this.#tell(thread.projectId, { kind: 'thread-report', threadId: thread.id, report }, event);
  }
  /**
   * The turn limit (brief 8.2, D73): the owner decides with the turn-limit item, created at once and only once; queued
   * messages stay; a report that reached the limit still goes to the coordinator.
   */
  async #atLimit(report?: ThreadReport): Promise<void> {
    let thread = this.#thread();
    if (thread.state !== 'waiting-for-you' || thread.stateReason !== TURN_LIMIT_REACHED) thread = this.#set((current) => withState(current, 'waiting-for-you', TURN_LIMIT_REACHED));
    try { await this.#c.decisions.turnLimit(thread.projectId, thread); }
    catch (error) { this.#notice(thread, threadStepFailed(this.#message(error)), 'error'); }
    if (report) await this.#report(thread, report);
  }
  /** Publication of a done report (brief 8.4, 2.6.9 #publish); returns the verification fix turn when there is one. */
  async #publish(): Promise<NextTurn | null> {
    let thread = this.#set((current) => withState(current, 'publishing'));
    const release = this.#c.enterOperation(this.threadId, thread.title);
    try {
      const project = await this.#c.project(thread.projectId);
      const local = this.#c.store.local(thread.id); const ledger = this.#c.ledgers.thread(thread.projectId, thread.id); const signal = this.#abort.signal;
      let result: PublicationResult;
      if (thread.isolation === 'main') {
        // Publication can follow a restart without a turn (allow-turns), so the claim is this process's first.
        if (!(await this.#c.main.ready(project, thread))) throw new Error('The project checkout was never prepared for this thread.');
        result = await this.#c.publication.publishMain({ project, thread, local, ledger, workspace: this.#c.main.workspace(project, thread), signal });
      } else {
        result = await this.#c.publication.publishWorktree({ project, thread, local, ledger,
          labels: { runtimeName: this.#c.runtimeName(thread.placement.runtime), modelLabel: this.#c.store.labels(thread.id).modelLabel }, signal,
          onPushed: (commit) => { this.#c.store.updateLocal(thread.id, (current) => ({ ...current, pushedCommit: commit })); } });
      }
      const outcome = result.outcome;
      // A passed (or skipped) verification resets the counter (brief 8.4 step 3).
      const attempts = (current: Thread) => result.verified && result.verified.status !== 'failed' ? 0 : current.verificationAttempts;
      const projectId = thread.projectId; const threadId = thread.id;
      switch (outcome.kind) {
        case 'no-changes': {
          thread = this.#set((current) => ({ ...withState(current, 'done', NO_CHANGES), verificationAttempts: attempts(current), endedAt: current.endedAt ?? this.#at() }),
            { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'no-changes' } });
          if (thread.isolation === 'main') { await this.#giveBack(project, thread, 'unchanged'); await this.#releaseReservations(thread); }
          else await this.#cleanup(project, thread);
          await this.#tell(projectId, { kind: 'thread-published', threadId, result: 'no-changes' });
          return null;
        }
        case 'verification-failed': {
          const count = thread.verificationAttempts + 1; const verification = outcome.verification;
          if (count < VERIFICATION_ATTEMPTS) {
            this.#set((current) => ({ ...current, verificationAttempts: count }));
            return { reason: 'verification', body: verificationFailurePrompt(verification.command ?? '', count, verification.tail), messages: [] };
          }
          // The next done report gets three attempts again (D158).
          this.#set((current) => ({ ...withState(current, 'idle', TESTS_FAILED_THREE_TIMES), verificationAttempts: 0 }));
          await this.#tell(projectId, { kind: 'thread-verification-failed', threadId, attempts: count, tail: verification.tail });
          return this.#afterStep();
        }
        case 'no-remote': case 'branch-only': case 'error': {
          const published = outcome.kind === 'no-remote' ? { result: 'local-only' as const } : outcome.kind === 'branch-only' ? { result: 'branch-pushed' as const, branch: outcome.branch } : undefined;
          thread = this.#set((current) => ({ ...withState(current, 'idle', outcome.reason), verificationAttempts: attempts(current) }),
            published && { type: 'thread-publication', data: { schema: 'thread-publication-v1', ...published } });
          // The coordinator hears why no pull request opened (D23).
          const last = thread.lastReport;
          await this.#report(thread, ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: last?.turn ?? Math.max(1, thread.turns), status: 'blocked',
            summary: outcome.reason.slice(0, 1200), ...(last?.testsRun ? { testsRun: last.testsRun } : {}), changedFiles: last?.changedFiles ?? [], synthesized: true }));
          return this.#afterStep();
        }
        case 'pr': {
          this.#set((current) => ({ ...withState(current, 'in-review'), pr: outcome.pr, verificationAttempts: attempts(current) }),
            { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: outcome.result, prNumber: outcome.pr.number, ...(thread.branch ? { branch: thread.branch } : {}), pr: outcome.pr } });
          await this.#tell(projectId, { kind: 'thread-published', threadId, result: outcome.result, prNumber: outcome.pr.number });
          return this.#afterStep();
        }
        case 'main-conflict': {
          // Main was already fetched: the agent rebases onto it itself, in a turn that continues this step (brief 8.4 main, 9.6).
          this.#set((current) => ({ ...current, verificationAttempts: attempts(current) }),
            { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'conflict', files: outcome.files } });
          return { reason: 'conflict', body: mainConflictPrompt(outcome.files), messages: [] };
        }
        case 'main-published': {
          thread = this.#set((current) => ({ ...withState(current, 'done'), publishedCommit: outcome.commit, verificationAttempts: attempts(current), endedAt: current.endedAt ?? this.#at() }),
            { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'main-published', commit: outcome.commit } });
          await this.#giveBack(project, thread, 'published');
          await this.#releaseReservations(thread);
          await this.#tell(projectId, { kind: 'thread-published', threadId, result: 'main-published', commit: outcome.commit });
          return null;
        }
      }
    } catch (error) {
      if (this.#halted()) return null;
      throw error;
    } finally { release(); }
  }
  /**
   * Messages that arrived during publication are delivered after it (2.6.9 deliver), in a turn that continues the step,
   * like messages queued during a turn (D72, D160).
   */
  #afterStep(): NextTurn | null {
    const thread = this.#thread();
    return atRest(thread.state) && thread.queuedMessages.length ? messagesTurn(thread, 'messages') : null;
  }
  /** A concluded main thread gives the checkout back; if the hub cannot take it now the claim stays, and the thread says so (D291). */
  async #giveBack(project: Project, thread: Thread, commits: 'published' | 'unchanged'): Promise<void> {
    try { await this.#c.main.release(project, thread, commits); }
    catch (error) { this.#notice(thread, mainCheckoutKept(this.#message(error)), 'error'); }
  }
  /**
   * A stopped main thread (D29): its unpublished commits are saved and the checkout returns to main, then the claim is released. The
   * stop reason names the saved ref. When the checkout cannot be settled the claim stays and the thread says why (D291).
   */
  async #stopMain(thread: Thread, reason: string): Promise<string> {
    if (thread.state === 'queued') return reason;
    try {
      const { saved } = await this.#c.main.stop(await this.#c.project(thread.projectId), thread, this.#c.store.local(thread.id).gitIdentity);
      return saved ? commitsSavedReason(reason, saved) : reason;
    } catch (error) {
      this.#notice(thread, mainCheckoutKept(this.#message(error)), 'error');
      return reason;
    }
  }
  async #cleanup(project: Project, thread: Thread): Promise<void> {
    try {
      await this.#c.worktrees.remove(project, thread);
      this.#c.ledgers.thread(thread.projectId, thread.id).append({ type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'cleanup', ...(thread.branch ? { branch: thread.branch } : {}) } });
    } catch (error) { this.#notice(thread, cleanupFailed(this.#message(error)), 'error'); }
  }

  /**
   * A message for this thread (2.6.9 deliver; sender rules are checked by the thread service). It is queued at once; at rest
   * it starts a turn through admission, a running turn is interrupted when asked, and live steps take it afterwards.
   * Message ids are remembered, so a retried message repeats and a reused id with other text is refused (D153).
   */
  async deliver(raw: QueuedMessage): Promise<{ delivery: 'started' | 'queued' | 'interrupting'; repeated: boolean }> {
    const thread = this.#thread();
    if (isTerminal(thread.state)) throw refuse(THREAD_ENDED, 409);
    const message: QueuedMessage = { ...raw, text: this.#c.redactor.text(raw.text) }; const hash = digest(message.text);
    const seen = this.#c.store.local(thread.id).seenMessages?.find((entry) => entry.id === message.id);
    if (seen) { if (seen.digest !== hash) throw refuse(MESSAGE_ID_REUSED, 409); return { delivery: 'queued', repeated: true }; }
    this.#c.store.update(thread.id, (current) => ({ ...current, queuedMessages: [...current.queuedMessages, message] }));
    this.#c.store.updateLocal(thread.id, (local) => ({ ...local, seenMessages: [...(local.seenMessages ?? []), { id: message.id, digest: hash }].slice(-SEEN_MESSAGES) }));
    const route = deliveryRoute(thread.state);
    if (route === 'running') {
      if (!message.interrupt) return { delivery: 'queued', repeated: false };
      if (this.#execution) void this.#execution.steer().catch(() => undefined); else this.#steer = true;
      return { delivery: 'interrupting', repeated: false };
    }
    if (route !== 'rest') return { delivery: 'queued', repeated: false };
    return { delivery: await this.#fromRest(), repeated: false };
  }
  /** The sweep (D9): a thread at rest whose next turn waited for a slot tries again. */
  resume(): Promise<'started' | 'queued'> { return this.#fromRest(); }
  /** A turn from rest: the limit, then admission; the turn itself runs on the chain and is not awaited. */
  async #fromRest(): Promise<'started' | 'queued'> {
    const release = await this.#admit();
    if (!release) return 'queued';
    void this.#work(async () => {
      const thread = this.#thread();
      if (this.#halted() || !atRest(thread.state) || !thread.queuedMessages.length) return;
      await this.#loop(messagesTurn(thread, 'messages'));
    }, release);
    return 'started';
  }
  async #admit(): Promise<(() => void) | undefined> {
    const thread = this.#thread();
    if (this.#halted() || !atRest(thread.state) || !thread.queuedMessages.length) return undefined;
    if (atTurnLimit(thread)) { await this.#work(() => this.#atLimit()); return undefined; }
    const admitted = await this.#c.admission.admit(thread.projectId, thread.ownerDeviceId, thread.id);
    if (admitted.ok) return admitted.release;
    const current = this.#thread();
    if (atRest(current.state) && current.stateReason !== admitted.reason) this.#set((latest) => ({ ...latest, stateReason: admitted.reason }));
    return undefined;
  }
  /**
   * Stop (brief 8.2): preparation and publication are aborted and the running turn's process group terminated; the thread
   * is `stopped` with `reason`, its worktree and branch kept, or for main isolation its checkout settled and released (D29).
   * `notify` tells the coordinator (a stop from the owner, D28).
   */
  async stop(reason: string, notify: boolean): Promise<void> {
    if (isTerminal(this.#thread().state)) return;
    this.#stopping ??= reason;
    this.#abort.abort();
    await this.#execution?.stop().catch(() => undefined);
    await this.#serial(async () => {
      const current = this.#thread();
      if (isTerminal(current.state)) return;
      // The turn's process is gone here (an unconfirmed one failed the thread instead), so a main checkout can be settled.
      const ended = current.isolation === 'main' ? await this.#stopMain(current, this.#stopping ?? reason) : this.#stopping ?? reason;
      const stopped = this.#set((latest) => ({ ...withState(latest, 'stopped', ended), endedAt: latest.endedAt ?? this.#at() }));
      // An open turn-limit question no longer applies (D161), and other main threads may take the paths now.
      await this.#c.decisions.withdrawTurnLimit(stopped.projectId, stopped.id).catch(() => undefined);
      await this.#releaseReservations(stopped);
      if (notify) await this.#tell(stopped.projectId, { kind: 'thread-interrupted', threadId: stopped.id, reason: 'stopped', message: OWNER_STOPPED_THREAD });
    });
  }
  /**
   * Restart (brief 10, D252): the thread ends with `reason` (`Restarted as {newId}.`): a running one stops without telling the
   * coordinator (the restart tells it), an ended one keeps its state. Its worktree and local branch are then removed, keeping
   * that reason (Discard would append to it); a main thread's checkout is settled by the stop, and the saved-commits sentence stays
   * after the reason (D29). Repeating it changes nothing.
   */
  async restarted(reason: string): Promise<void> {
    // A repeat, or a thread discarded before, has no worktree left.
    const gone = isDiscarded(this.#thread().stateReason);
    await this.stop(reason, false);
    await this.#serial(async () => {
      let thread = this.#thread();
      // A main thread's stop named where its unpublished commits went (D29): the restart reason keeps that sentence.
      const saved = savedCommitsRef(thread.stateReason); const next = saved ? commitsSavedReason(reason, saved) : reason;
      if (thread.stateReason !== next) thread = this.#set((current) => withState(current, current.state, next));
      if (gone || thread.isolation !== 'worktree' || !thread.cwd || thread.state === 'done') return;
      await this.#cleanup(await this.#c.project(thread.projectId), thread);
    });
  }
  /** Discard (brief 8.2): removes the worktree and local branch of a stopped or failed worktree thread. */
  discard(): Promise<void> {
    return this.#serial(async () => {
      const thread = this.#thread();
      if ((thread.state !== 'stopped' && thread.state !== 'failed') || thread.isolation !== 'worktree') throw refuse(DISCARD_REFUSED, 409);
      if (isDiscarded(thread.stateReason)) return;
      await this.#c.worktrees.remove(await this.#c.project(thread.projectId), thread);
      this.#set((current) => ({ ...current, stateReason: discardedReason(current.stateReason) }),
        { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'cleanup', ...(thread.branch ? { branch: thread.branch } : {}) } });
    });
  }
  /**
   * Allow 10 more turns (brief 8.2, 12.3): only at the limit, so a repeated answer or request adds nothing (D159). The
   * turn-limit item is withdrawn silently (D85); queued messages then run through admission, and a publication whose fix
   * turn the limit blocked runs again so its prompt is regenerated (D73).
   */
  async allowTurns(): Promise<void> {
    const next = await this.#serial(async (): Promise<'publish' | 'messages' | null> => {
      const thread = this.#thread();
      if (this.#closed || isTerminal(thread.state) || !atTurnLimit(thread)) return null;
      const limited = thread.state === 'waiting-for-you' && thread.stateReason === TURN_LIMIT_REACHED;
      const allowed = this.#set((current) => ({ ...(limited ? withState(current, 'idle') : current), turnAllowance: current.turnAllowance + MORE_TURNS }));
      try { await this.#c.decisions.withdrawTurnLimit(allowed.projectId, allowed.id); }
      catch (error) { this.#notice(allowed, threadStepFailed(this.#message(error)), 'error'); }
      if (allowed.queuedMessages.length) return 'messages';
      return limited && allowed.lastReport?.status === 'done' && !allowed.pr && !allowed.publishedCommit ? 'publish' : null;
    });
    if (next === 'messages') await this.#fromRest();
    else if (next === 'publish') {
      void this.#work(async () => {
        if (this.#halted() || !atRest(this.#thread().state)) return;
        await this.#loop(await this.#publish());
      });
    }
  }
  /**
   * Terminal takeover (brief phase 7, D46, D297): a thread at rest with a session, and no step on its chain, becomes `attached`
   * with `attach.startedAt`. `prepare` (the checkout and the account) runs first; the thread is checked again afterwards and set
   * without any wait in between, so no turn can start in the meantime, and none starts while it is attached (messages wait). It
   * never waits on the chain, which could hold a turn for hours.
   */
  async attach<T>(prepare: (thread: Thread) => Promise<T>): Promise<{ thread: Thread; prepared: T }> {
    const prepared = await prepare(this.#attachable());
    this.#attachable();
    return { thread: this.#set((current) => ({ ...withState(current, 'attached'), attach: { startedAt: this.#at() } })), prepared };
  }
  #attachable(): Thread {
    const thread = this.#thread();
    if (isTerminal(thread.state)) throw refuse(THREAD_ENDED, 409);
    if (thread.state === 'attached') throw refuse(alreadyAttached(thread.id), 409);
    if (!atRest(thread.state) || this.busy || this.#halted()) throw refuse(THREAD_WORKING, 409);
    if (!thread.nativeSessionId) throw refuse(NO_SESSION_TO_ATTACH, 409);
    return thread;
  }
  /**
   * The owner left the terminal (brief phase 7): `find` names the session the terminal left (undefined keeps the stored one; a failed
   * search keeps it too, with a notice), the thread rests, the coordinator hears the owner-worked line, and messages that waited
   * start the next turn through admission (2.6.9 step 2). A thread that is no longer attached (detached before, or stopped while
   * attached) changes nothing.
   */
  async detach(find: (thread: Thread) => Promise<string | undefined>): Promise<{ adopted: boolean; state: ThreadState }> {
    const detached = await this.#serial(async () => {
      const thread = this.#thread();
      if (thread.state !== 'attached') return null;
      let sessionId: string | undefined;
      try { sessionId = await find(thread); }
      catch (error) { this.#notice(thread, sessionNotAdopted(this.#message(error)), 'error'); }
      const adopted = sessionId !== undefined && sessionId !== thread.nativeSessionId;
      const rested = this.#set((current) => {
        const next: Thread = { ...withState(current, 'idle'), ...(sessionId === undefined ? {} : { nativeSessionId: sessionId }) }; delete next.attach; return next;
      });
      return { thread: rested, adopted };
    });
    if (!detached) return { adopted: false, state: this.#thread().state };
    const { thread } = detached;
    // The turn below starts outside the chain step above: admission at the turn limit waits on the chain itself.
    try { await this.#tell(thread.projectId, { kind: 'thread-user-message', threadId: thread.id, text: ownerWorkedLine(thread.title) }); }
    catch (error) { this.#notice(thread, threadStepFailed(this.#message(error)), 'error'); }
    if (this.#thread().queuedMessages.length) await this.#fromRest();
    return { adopted: detached.adopted, state: this.#thread().state };
  }
  /**
   * A merge or close found by the pull request tracker (D95): a running fix turn is stopped (its report discarded), a
   * publication finishes first, then `apply` runs on this thread's chain.
   */
  async transition(apply: () => Promise<void>): Promise<void> {
    this.#concluding += 1;
    try {
      await this.#execution?.stop().catch(() => undefined);
      await this.#serial(apply);
    } finally { this.#concluding -= 1; }
  }
  /** Daemon shutdown: terminate the running turn and wait for the chain; states stay for restart recovery (D24). */
  async shutdown(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    await this.#execution?.shutdown().catch(() => undefined);
    await this.#chain;
    this.#releaseHold();
  }
}
