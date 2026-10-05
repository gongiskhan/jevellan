import { OWNER_STARTED_PREFIX, OWNER_WORKED_PREFIX, RESTARTED_PREFIX, SAVED_COMMITS_SENTENCE, splitSavedCommits, type CoordinatorEvent, type Isolation, type PlacementOverride, type ThreadReport, type ThreadState } from '@jevellan/core';
import { firstLine, tail } from './git.js';

// Every brief-verbatim Projects string (brief 9) and the server copy of phase 1. Pure functions only.
// Placement copy lives in @jevellan/decisions (D135) and is re-exported here, never retyped.
export {
  ACCOUNT_REASON_TEXT, LEAVE_GIT_MAIN, MAIN_NOT_AVAILABLE, NOT_CHOSEN_REASON, NO_PLACEMENT, NO_THREAD_MODEL, PLACEMENT_INCOMPATIBLE, PLACEMENT_INSTRUCTIONS,
  PLACEMENT_ISOLATION_CRITERIA, REMOTE_GATE_REASON, REMOTE_NOT_AVAILABLE, TASK_SHORTENED, UNKNOWN_PLACEMENT_DEVICE, UNKNOWN_PLACEMENT_MODEL,
} from '@jevellan/decisions';
export { ASK_USER_OPTIONS, NEEDS_DECISION_QUESTION, NO_CHANGES, coordinatorWorking } from '@jevellan/core';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const pad = (value: number) => String(value).padStart(2, '0');
/** `{HH:MM}`: 24-hour local time of the device that renders the event block (D36). */
export function clockTime(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 9.1 Coordinator system append
export function coordinatorSystemAppend(projectName: string): string {
  return `You are the coordinator of the project "${projectName}" in Jevellan. You do not write code and you do not edit files. You plan, delegate to threads, keep track, and talk with the owner.

How you work:
- Threads do the work. Each thread is a full coding session (Claude Code or Codex) that carries one task end to end. Start a thread with jevellan_thread_start. Give it a short title and a complete task: the goal, the relevant context and constraints, what done means, and how to verify it. A thread cannot see this conversation, so put everything it needs in the task.
- Route each new request: if it continues work an active thread is doing, send it to that thread with jevellan_thread_message; otherwise start a new thread. Split unrelated requests into separate threads. Do not start two threads that would change the same files at the same time; sequence them instead.
- Jevellan chooses where each thread runs (isolation, model, effort, device). Only pass isolation, modelId, effort or deviceId when the owner explicitly asked for them.
- Worktree threads end in a pull request that the owner reviews and merges. You cannot merge. Main threads publish directly to main.
- When a thread reports, decide the next step yourself whenever the answer follows from the owner's instructions, the notebook or the code. Ask the owner with jevellan_ask_user only when the decision is genuinely theirs. Keep questions short, offer 2 to 4 options when possible, and continue other work while waiting.
- When checks fail or a pull request has conflicts, tell the responsible thread what to fix.
- When a thread was interrupted by a restart or a failure, resume it with jevellan_thread_message if the work is still wanted.
- Keep the notebook current with jevellan_notebook_write: the owner's standing instructions and preferences for this project, decisions taken, the current plan and open questions. Keep it concise. The notebook is your memory across sessions.

Replying to the owner: be brief and concrete. Say what you started, routed, asked or concluded, naming threads by title. Never paste long transcripts. Write in the owner's language.`;
}

// 9.2 Fresh session context
export type ActiveThreadLine = { title: string; id: string; state: ThreadState; isolation: Isolation; runtime: string; modelLabel: string;
  effort: string; deviceName: string; pr?: { number: number; checks: string } | undefined; lastSummary?: string | undefined };
/** `{runtime}` is the adapter display name (D83); the summary is kept on one line. */
export function activeThreadLine(thread: ActiveThreadLine): string {
  const pr = thread.pr ? `, PR #${thread.pr.number} ${thread.pr.checks}` : '';
  return `- ${thread.title} (${thread.id}): ${thread.state}, ${thread.isolation}, ${thread.runtime} ${thread.modelLabel} ${thread.effort} on ${thread.deviceName}${pr}. Last report: ${oneLine(thread.lastSummary ?? '') || 'none'}`;
}
export const openQuestionLine = (question: string): string => `- ${oneLine(question)}`;
export const RECENT_CONVERSATION_CHARS = 8000;
/**
 * Owner messages and coordinator replies, newest first until the budget is spent, emitted oldest first (D36). The
 * newest item always appears, cut to the budget when it alone is longer (D140).
 */
export function recentConversation(items: ReadonlyArray<{ from: 'owner' | 'coordinator'; text: string }>, max = RECENT_CONVERSATION_CHARS): string {
  const kept: string[] = []; let used = 0;
  for (const item of [...items].reverse()) {
    const line = `${item.from === 'owner' ? 'Owner' : 'You'}: ${item.text}`; const cost = line.length + (kept.length ? 2 : 0);
    if (used + cost > max) { if (!kept.length) kept.push(line.slice(0, max)); break; }
    kept.push(line); used += cost;
  }
  return kept.length ? kept.reverse().join('\n\n') : '(none)';
}
export function freshContext(input: { notebook: string | null; threads: readonly string[]; questions: readonly string[]; recent: string }): string {
  const notebook = input.notebook?.trimEnd();
  return `Project notebook:
${notebook || '(empty)'}

Active threads:
${input.threads.length ? input.threads.join('\n') : '(none)'}

Open questions to the owner:
${input.questions.length ? input.questions.join('\n') : '(none)'}

Recent conversation with the owner:
${input.recent}`;
}

// 9.3 Event block
export const eventBlock = (lines: readonly string[]): string => `Events since your last turn:\n${lines.join('\n')}`;
export const UNKNOWN_THREAD = '(unknown thread)';
export const SYNTHESIZED_SUFFIX = ' (Jevellan wrote this report because the thread did not.)';
export const ASKED_DIRECTLY_SUFFIX = ' (Jevellan asked the owner directly.)';
const PREFORMATTED = [OWNER_STARTED_PREFIX, OWNER_WORKED_PREFIX];
export type EventLineContext = {
  /** Thread title from the hub index; missing titles read `(unknown thread)`. */
  title(threadId: string): string | undefined;
  /** The base branch detected in the coordinator's checkout (D93), for `has conflicts with {base}`. */
  base: string;
  /** The fallback already created an owner question for this report (D32). */
  askedDirectly?: boolean | undefined;
  clock?: ((at: string) => string) | undefined;
};
const PR_CHANGES = { 'checks-failed': 'checks failing', 'checks-passed': 'checks passing', merged: 'merged', closed: 'closed without merging' } as const;
export function reportLines(report: Pick<ThreadReport, 'question' | 'options' | 'testsRun'>): string {
  return [
    report.question ? `\nQuestion: ${report.question}` : '',
    report.options?.length ? `\nOptions: ${report.options.map((option) => option.label).join('; ')}` : '',
    report.testsRun ? `\nTests: ${report.testsRun.passed ? 'passed' : 'failed'} (${report.testsRun.command}) ${report.testsRun.summary}` : '',
  ].join('');
}
/** One event as the coordinator reads it (brief 9.3). */
export function eventLine(event: CoordinatorEvent, context: EventLineContext): string {
  const title = (id: string) => context.title(id) ?? UNKNOWN_THREAD;
  const thread = (id: string) => `thread "${title(id)}" (${id})`;
  switch (event.kind) {
    case 'user-message': return `[owner ${(context.clock ?? clockTime)(event.at)}] ${event.text}`;
    case 'thread-report': {
      const report = event.report;
      return `[${thread(event.threadId)} reported ${report.status}] ${report.summary}${reportLines(report)}${report.synthesized ? SYNTHESIZED_SUFFIX : ''}${context.askedDirectly ? ASKED_DIRECTLY_SUFFIX : ''}`;
    }
    case 'thread-published': {
      const outcome = event.result === 'pr-opened' ? `Pull request #${event.prNumber} opened.` : event.result === 'pr-updated' ? `Pull request #${event.prNumber} updated.`
        : event.result === 'main-published' ? `Published to main as ${(event.commit ?? '').slice(0, 7)}.` : 'Concluded without changes.';
      return `[${thread(event.threadId)}] ${outcome}`;
    }
    case 'thread-verification-failed': return `[${thread(event.threadId)}] Tests failed ${event.attempts} times. Last output:\n${event.tail}`;
    case 'thread-interrupted': return `[${thread(event.threadId)} interrupted: ${event.reason}] ${event.message}`;
    case 'decision-answer': {
      const { optionLabel, text } = event.answer;
      return `[owner answered] "${event.question}" → ${optionLabel ? `${optionLabel}${text ? `. Note: ${text}` : ''}` : text ?? ''}`;
    }
    case 'pr-update': return `[PR #${event.prNumber} "${title(event.threadId)}"] ${event.change === 'conflict' ? `has conflicts with ${context.base}` : PR_CHANGES[event.change]}`;
    case 'mail': return `[mail from "${title(event.fromThreadId)}" (${event.fromThreadId})] ${event.subject}\n${event.body}`;
    case 'thread-user-message':
      return PREFORMATTED.some((prefix) => event.text.startsWith(prefix)) ? event.text : `[owner wrote directly to ${thread(event.threadId)}] ${event.text}`;
    case 'placement-override': return `[owner changed ${thread(event.threadId)}] ${event.summary}`;
  }
}

// 9.4 Thread system append and turn prompts
export function threadSystemAppend(input: { projectName: string; cwd: string; isolation: Isolation; branch?: string | undefined; baseBranch: string;
  deviceName: string; testCommand?: string | undefined }): string {
  const isolation = input.isolation === 'worktree'
    ? `Isolation: your own git worktree on branch ${input.branch ?? ''}, based on ${input.baseBranch}. Other threads work elsewhere. Commit your work on this branch.`
    : `Isolation: you work directly on main in the project checkout of ${input.deviceName}. Other main threads may work on other devices at the same time. Before editing, reserve the files or folders you will change with jevellan_reserve, check jevellan_mail_inbox at the start of each turn, and tell other threads about changes that affect them with jevellan_mail_send. Release reservations when done.`;
  return `You are working on one thread of the project "${input.projectName}", coordinated by Jevellan. A coordinator assigned you this task and may send you follow-up messages.

Workspace: ${input.cwd}
${isolation}

Rules:
- Do the whole task: understand the code, implement, and run the relevant tests yourself.
- Commit with clear messages using the machine's git identity. Never add attribution trailers, AI credits or session links to commits, code or documentation.
- Do not push and do not open pull requests. When you report done, Jevellan runs ${input.testCommand || 'the checks'}, pushes${input.isolation === 'worktree' ? ' and opens the pull request' : ''}.
- If you need a decision that is not yours to make, report needs-decision with a short question and 2 to 4 options, and stop.
- End every turn by calling jevellan_thread_report exactly once: done when the task is complete and committed, progress when you made progress and will continue when asked, needs-decision when you need an answer, blocked when you cannot continue. Keep the summary short and factual.`;
}
export const taskPrompt = (title: string, task: string): string => `Task: ${title}\n\n${task}`;
export const MESSAGE_SEPARATOR = '\n\n---\n\n';
/** One queued message is sent as is; several are each prefixed on their own line (D22). */
export function messagesPrompt(messages: ReadonlyArray<{ from: 'coordinator' | 'owner'; text: string }>): string {
  if (!messages.length) throw new Error('A thread turn needs at least one message.');
  if (messages.length === 1) return messages[0]!.text;
  return messages.map((message) => `From the ${message.from}:\n${message.text}`).join(MESSAGE_SEPARATOR);
}
export type ThreadTurnReason = 'task' | 'messages' | 'verification' | 'conflict' | 'steer';
/** A turn that starts a fresh session (no stored or usable session) gets the task block first (D94). */
export function threadPrompt(thread: { title: string; task: string }, body: string, resumed: boolean, reason: ThreadTurnReason): string {
  return reason !== 'task' && !resumed ? `${taskPrompt(thread.title, thread.task)}${MESSAGE_SEPARATOR}${body}` : body;
}

// 9.5 Owner-created thread (rendered verbatim in event blocks, D35); phase 7 detach
export const ownerStartedLine = (title: string, id: string, task: string): string => `${OWNER_STARTED_PREFIX}${title}" (${id})] ${task.slice(0, 400)}`;
export const ownerWorkedLine = (title: string): string => `${OWNER_WORKED_PREFIX}${title}" in a terminal]`;

// 9.6 Jevellan-generated thread messages
export const VERIFICATION_ATTEMPTS = 3;
export function verificationFailurePrompt(command: string, attempt: number, output: string): string {
  return `Jevellan ran ${command} after your report and it failed (attempt ${attempt} of ${VERIFICATION_ATTEMPTS}). Fix the cause, run the tests, commit, and report done again.

Last output:
${tail(output)}`;
}
export const mainConflictPrompt = (files: readonly string[]): string =>
  `Main moved while you worked and your commits conflict with it in: ${files.join(', ')}. Run git fetch origin main and git rebase origin/main, resolve the conflicts keeping both intents, run the tests, and report done again.`;

// 9.7 Pull request body: no other text, no links to Jevellan, no attribution.
export function pullRequestBody(input: { summary: string; testCommand: string | null; title: string; runtime: string; modelLabel: string; effort: string; deviceName: string }): string {
  return `${input.summary}

Tests: ${input.testCommand ? `Passed: ${input.testCommand}` : 'Not run: no test command'}

Thread: ${input.title}
Placement: ${input.runtime} ${input.modelLabel}, ${input.effort} effort, ${input.deviceName}`;
}

// 9.8 Notices. The offline notice and the fallback chip are rendered by the browser from its own copy module (D141).
export const coordinatorUnavailableNotice = (reason: string): string => `The coordinator cannot run: ${reason}`;
export const coordinatorOfflineNotice = (deviceName: string): string => `The coordinator lives on ${deviceName}, which is offline.`;
/** Move coordinator here (3.5.3): the new coordinator device's chat line, and the refusal while the coordinator runs a turn on a device that is online. */
export const coordinatorMovedNotice = (deviceName: string): string => `The coordinator moved to ${deviceName}.`;
export const placedWithoutJev = (reason: string): string => `Placed without Jev: ${reason}`;
/** `{error}` keeps no final period of its own, so the sentence stays well formed. */
export const coordinatorFailedTwiceNotice = (error: string): string => `The coordinator failed twice: ${error.trim().replace(/\.+$/, '')}. Send a message to try again.`;
export const noCoordinatorAccount = (deviceName: string): string => `No account can run the coordinator model on ${deviceName}.`;
export const noCoordinatorModel = (deviceName: string): string => `No enabled model can run the coordinator on ${deviceName}.`;
export const COORDINATOR_MEMORY_READ_ONLY = 'The coordinator cannot write project memory.';
/** A coordinator session whose account is no longer eligible continues on another account in a fresh session (D16). */
export const coordinatorAccountMovedNotice = (accountLabel: string): string => `The coordinator moved to account ${accountLabel}; a fresh session started.`;
export const coordinatorTurnTimedOut = (timeoutMs: number): string => `The coordinator turn timed out after ${duration(timeoutMs)}.`;
/** A coordinator turn whose process cleanup was not confirmed counts as a failed turn; its record stays for recovery. */
export const COORDINATOR_PROCESS_UNCONFIRMED = "Jevellan could not confirm the coordinator's process stopped.";

// Thread state reasons (brief 8.2-8.6, D9, D24, D66, D69)
export const TESTS_FAILED_THREE_TIMES = 'Tests failed three times.';
export const NO_REMOTE = 'This project has no remote; the branch stays local.';
export const BRANCH_PUSHED_NO_TOKEN = 'Branch pushed. Add a GitHub token in Settings → Git to open pull requests.';
export const NOT_GITHUB = 'The remote is not on GitHub.';
export const githubRefused = (message: string): string => `GitHub refused the pull request: ${message}`;
export const worktreeSetupFailed = (line: string): string => `Worktree setup failed: ${line}`.slice(0, 400);
function duration(timeoutMs: number): string {
  const [count, unit] = timeoutMs >= 60_000 ? [Math.round(timeoutMs / 60_000), 'minute'] : [Math.max(1, Math.round(timeoutMs / 1000)), 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
export const commandTimedOut = (timeoutMs: number): string => `the command timed out after ${duration(timeoutMs)}.`;
export const exitCodeLine = (code: number): string => `exit code ${code}`;
export const TURN_LIMIT_REACHED = 'This thread reached its turn limit.';
export const RESTARTED = 'Jevellan restarted during this step.';
export const RESTART_UNCONFIRMED = "Jevellan restarted and could not confirm this thread's process stopped.";
export const STOPPED_BY_YOU = 'Stopped by you.';
export const STOPPED_AT_TURN_LIMIT = 'Stopped by you at the turn limit.';
export const OWNER_STOPPED_THREAD = 'The owner stopped this thread.';
export const PR_CLOSED = 'The pull request was closed without merging.';
export const WORKTREE_DISCARDED = ' Worktree discarded.';
export const TURN_WITHOUT_REPORT = 'The turn ended without a report.';
export const TURN_TIMED_OUT = 'The turn timed out after 6 hours.';
/** A failed turn whose runtime gave no error message (D154). */
export const TURN_FAILED = 'The turn failed.';
/** A turn whose process cleanup could not be confirmed while the daemon kept running (D155). */
export const PROCESS_UNCONFIRMED = "Jevellan could not confirm this thread's process stopped.";
/** An unexpected failure of a thread step, so no thread is left in a live state (D156). */
export const threadStepFailed = (message: string): string => `This step failed: ${message}`.slice(0, 400);
export const THREAD_MEMORY_READ_ONLY = 'Threads cannot write project memory.';
/** D9 running limits: `device` is null for the project limit. */
export function queuedReason(limit: number, device: string | null): string {
  return `Queued: ${device === null ? 'the project' : device} is at its limit of ${limit} running threads.`;
}
const WAITING_FOR_SLOT = 'Waiting for a free slot: ';
export function waitingForSlotReason(limit: number, device: string | null): string {
  return `${WAITING_FOR_SLOT}${device === null ? 'the project' : device} is at its limit of ${limit} running threads.`;
}
/** A thread at rest whose next turn waits for admission (D9); the sweep retries exactly these (D157). */
export const isWaitingForSlot = (reason: string | undefined): boolean => !!reason?.startsWith(WAITING_FOR_SLOT);
/** A thread at rest whose next turn could not start while the hub was unreachable (D273); the sweep retries these too. */
export const WAITING_FOR_HUB = "Waiting for the hub. This thread continues when it's back.";
export const accountMovedNotice = (accountLabel: string): string => `This thread moved to account ${accountLabel}; a fresh session started.`;
export const cannotRunHere = (runtime: string): string => `${runtime} cannot run this here.`;
export const noTurnAccount = (modelLabel: string, deviceName: string, reasons: string): string => `No account can run ${modelLabel} on ${deviceName} right now: ${reasons}.`;
export const ACCOUNT_BUSY = 'This account is already running a turn, and its runtime cannot run two at once.';
export const MEMORY_HOOKS_UNDELIVERED = 'Project memory hooks could not be delivered to this account.';

// Publication and pull requests (brief 8.4, 8.5)
/** Leftover commit subject (D86): `<title>: <first line of the summary, cut to 72 characters>`. */
export const leftoverCommitSubject = (title: string, summary: string): string => `${title}: ${firstLine(summary).slice(0, 72)}`;
export const REMOTE_CREDENTIALS = 'Remove credentials from the origin URL. Use a Git credential helper or SSH.';
export const VERIFICATION_HEAD_MOVED = 'The test command changed the commit under test, so this run does not count.';
export const NO_PULL_REQUEST = 'This thread has no pull request yet.';
export const PR_NOT_OPEN = 'This pull request is no longer open.';
export const prStatusUnavailable = (message: string): string => `The pull request status could not be read: ${message}`;
export const cleanupFailed = (message: string): string => `The worktree could not be removed: ${message}`;

// Main isolation (brief 8.2 step 4 main, 8.4 main; design 3.6; D29, D44, D45, D288-D292)
/** A test command that leaves changes in the checkout: main publication rebases and pushes only a clean checkout (D290). */
export const VERIFICATION_TREE_CHANGED = 'The test command left changes in the checkout, so this run does not count.';
/** A done report while the checkout is still in the middle of a rebase or merge (for example after the main-conflict prompt). */
export const MAIN_OPERATION_PENDING = 'The checkout is in the middle of a rebase or merge. Finish or abort it, then report done again.';
export const MAIN_CHANGED_THREE_TIMES = 'Main changed during publication three times. Send a message to try again.';
/** D45: the publication lease stayed busy after three retries. */
export const MAIN_LEASE_BUSY = 'Another publication to main is in progress. Send a message to try again.';
export const MAIN_NO_REMOTE = 'This project has no remote, so main cannot be published.';
/** A stopped main thread's unpublished commits (D29): the stop reason keeps its own words, the saved ref follows (the sentence is shared with the interface, D295). */
export function commitsSavedReason(reason: string, ref: string): string {
  const saved = ` ${SAVED_COMMITS_SENTENCE}${ref}.`;
  return `${reason.slice(0, 400 - saved.length)}${saved}`.trim();
}
/** The ref a stop reason names for saved commits (`commitsSavedReason`), so a later reason keeps it. */
export const savedCommitsRef = (reason: string | undefined): string | undefined => splitSavedCommits(reason ?? '').ref ?? undefined;
/** A main thread whose checkout could not be settled keeps its claim (D291): conversations and other main threads stay off it. */
export const mainCheckoutKept = (message: string): string => `The project checkout stays held by this thread: ${message}`.slice(0, 400);
/**
 * Known `GitWorkspace` messages in thread words (D44): the dirty-checkout refusal names the conversation and the device id. Any other
 * message keeps its text; "conversation" never reaches a thread reason.
 */
export function mainCheckoutMessage(message: string, input: { projectName: string; deviceId: string; deviceName: string }): string {
  if (message === `${input.projectName} on ${input.deviceId} has changes that don't belong to this conversation. Commit, stash or publish them, then press Retry.`) {
    return `${input.projectName} on ${input.deviceName} has changes that don't belong to this thread. Commit, stash or publish them, then start the thread again.`;
  }
  return message.replace(/\bconversations\b/g, 'threads').replace(/\bconversation\b/g, 'thread').slice(0, 400);
}

// Bridge tool errors (brief 7: a short sentence the model can act on)
export const CHECK_TOOL_INPUT = 'Check the tool input.';
/** `<path>: <message>. Check the tool input.`; the message keeps a single final period. */
export function toolInputError(path: ReadonlyArray<PropertyKey>, message: string): string {
  const field = path.map(String).join('.');
  return `${field ? `${field}: ` : ''}${message.trim().replace(/\.+$/, '')}. ${CHECK_TOOL_INPUT}`;
}
// Mail and reservations between main threads (brief 7.1, 7.2; D287)
/** The sender name of the coordinator's mail in a thread's inbox (`fromTitle`). */
export const COORDINATOR_MAIL_NAME = 'Coordinator';
/** The coordinator's mail goes to threads (brief 7.1); a thread's mail can also go to `coordinator` (brief 7.2). */
export const COORDINATOR_MAIL_TO = 'Send mail to a thread id or to all.';
export const THREAD_MAIL_TO = 'Send mail to coordinator, to a thread id or to all.';
export const MAIL_TO_SELF = 'Send mail to another thread.';
export const MAIL_WORKTREE_THREAD = 'That thread works in its own worktree and reads no mail.';
export const MAIL_THREAD_ENDED = 'That thread has ended and reads no mail.';
export const MAIL_NO_RECIPIENTS = 'No other thread works on main right now.';
/** `jevellan_thread_read` with `transcript` for a thread on another device (D42). */
export const transcriptStaysOn = (deviceName: string): string => `The transcript stays on ${deviceName}.`;
/** The gist of a sentence-shaped message: its first line up to the first sentence end (a conflict's content and `Check the tool input.` stay out). */
export function firstSentence(text: string): string {
  const line = firstLine(text);
  return /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
}
export type ToolSummaryOutcome = { ok: true; result: unknown } | { ok: false; error: string };
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const rawField = (value: unknown, key: string): string | undefined => { const found = field(value, key); return typeof found === 'string' && found.trim() ? found : undefined; };
const textField = (value: unknown, key: string): string | undefined => { const found = rawField(value, key); return found === undefined ? undefined : oneLine(found); };
/**
 * The coordinator chat's line for one tool call (brief 8.1, 12.2; D200): what the coordinator did, or `Could not {action}:
 * {error}`. `title` is the title of the thread the call names; `input` is unparsed when the input was refused. At most 400
 * characters.
 */
export function coordinatorToolSummary(tool: string, input: unknown, outcome: ToolSummaryOutcome, title?: string): string {
  const result = outcome.ok ? outcome.result : undefined;
  const thread = `"${title ?? UNKNOWN_THREAD}"`;
  const line = (done: string, attempt: string) => (outcome.ok ? done : `Could not ${attempt}: ${firstSentence(outcome.error)}`).slice(0, 400);
  switch (tool) {
    case 'jevellan_threads_list': return line('Listed threads', 'list threads');
    case 'jevellan_thread_start': {
      const named = textField(input, 'title');
      return line(`${field(result, 'state') === 'queued' ? 'Queued' : 'Started'} "${named ?? ''}" · ${textField(result, 'placement') ?? ''}`, named ? `start "${named}"` : 'start a thread');
    }
    case 'jevellan_thread_message': return line(`Sent a message to ${thread}${field(result, 'delivery') === 'interrupting' ? ' and interrupted its turn' : ''}`, `send a message to ${thread}`);
    case 'jevellan_thread_read': return line(`Read ${thread}`, `read ${thread}`);
    case 'jevellan_thread_stop': return line(`Stopped ${thread}`, `stop ${thread}`);
    case 'jevellan_ask_user': return line(`Asked you: ${firstLine(rawField(input, 'question') ?? '').slice(0, 120)}`, 'ask you');
    case 'jevellan_withdraw_question':
      return line(field(result, 'withdrawn') === false ? 'The owner already answered that question' : `Withdrew a question: ${textField(input, 'reason') ?? ''}`, 'withdraw a question');
    case 'jevellan_notebook_read': return line('Read the notebook', 'read the notebook');
    case 'jevellan_notebook_write': return line('Updated the notebook', 'update the notebook');
    case 'jevellan_pr_status': {
      const number = field(field(result, 'pr'), 'number');
      return line(typeof number === 'number' ? `Checked PR #${number}` : `Checked ${thread}: no pull request`, `check the pull request of ${thread}`);
    }
    case 'jevellan_mail_send': {
      // A thread recipient reads as its title when it is known, like the other thread lines; `all` stays as written.
      const to = textField(input, 'to') ?? ''; const named = to === 'all' || title === undefined ? to : thread;
      return line(`Sent mail to ${named}: ${textField(input, 'subject') ?? ''}`, `send mail to ${named}`);
    }
    case 'memory_search': return line('Searched project memory', 'search project memory');
    case 'memory_read': return line('Read a project memory note', 'read a project memory note');
    default: return line(`Used ${tool}`, `use ${tool}`);
  }
}
/** One line from the start result (3.1 step 2j); fallback placements say why (brief 9.8). */
export function placementSummary(input: { runtime: string; modelLabel: string; effort: string; isolation: Isolation; deviceName: string; fallback?: string | undefined }): string {
  return `${input.runtime} ${input.modelLabel} · ${input.effort} · ${input.isolation === 'worktree' ? 'Worktree' : 'Main'} · ${input.deviceName}${input.fallback ? ` · placed without Jev: ${input.fallback}` : ''}`;
}

// Placement overrides (brief 10, 12.3; D50, D252)
export const MODEL_SAME_RUNTIME = 'From the next turn, the model must use the same runtime.';
export const NEXT_TURN_FIELDS = 'From the next turn, only the model and effort can change.';
export const RESTART_OPEN_PULL_REQUEST = 'This thread has an open pull request.';
export const RESTART_PUBLISHED_TO_MAIN = 'This thread already published to main.';
export const THREAD_ALREADY_RESTARTED = 'This thread was already restarted.';
/** The old thread's reason after a restart: `Restarted as {newId}.` (brief 10); the prefix is shared with the interface. */
export const restartedReason = (threadId: string): string => `${RESTARTED_PREFIX}${threadId}.`;
export const isRestarted = (reason: string | undefined): boolean => !!reason?.startsWith(RESTARTED_PREFIX);
const OVERRIDE_FIELDS = { isolation: 'Isolation', model: 'Model', effort: 'Effort', device: 'Device' } as const;
/**
 * The coordinator's `placement-override` summary (D50): `Model changed from {from} to {to}.` per change, joined with spaces, a restart's
 * `Restarted as {newId}.` (D252), then ` Note: {note}`; at most 400 characters.
 */
export function overrideSummary(input: { changes: PlacementOverride['changes']; note?: string | undefined; restartedAs?: string | undefined }): string {
  const sentences = [...input.changes.map((change) => `${OVERRIDE_FIELDS[change.field]} changed from ${change.from} to ${change.to}.`), ...(input.restartedAs ? [restartedReason(input.restartedAs)] : [])];
  const note = oneLine(input.note ?? '');
  return `${sentences.join(' ')}${note ? ` Note: ${note}` : ''}`.trim().slice(0, 400);
}

// Turn-limit decision item (brief 8.2; question text D142)
export const ALLOW_MORE_TURNS = 'Allow 10 more turns';
export const STOP_THE_THREAD = 'Stop the thread';
export const MORE_TURNS = 10;
export const turnLimitQuestion = (title: string, turns: number): string => `"${title}" reached its turn limit of ${turns} turns. Allow 10 more turns or stop it?`;

// Context links in worktrees (D26)
export const contextLinkSkipped = (name: string): string => `${name} from the project checkout is not in this worktree because git does not ignore it here.`;
export const contextUnreadable = (message: string): string => `The project checkout's instruction files could not be checked: ${message}`;

// Refusals (the HTTP status is set where they are thrown)
export const PROJECT_NOT_FOUND = 'Project not found.';
export const THREAD_NOT_FOUND = 'This thread was not found.';
export const THREAD_ENDED = 'This thread has ended. Start a new thread for new work.';
export const DISCARD_REFUSED = 'Only stopped or failed worktree threads can be discarded.';
export const THREAD_ATTACHED = 'The thread is attached in a terminal. Try again after the owner exits.';
export const START_REQUEST_REUSED = 'This request id was already used for a different thread.';
export const MESSAGE_ID_REUSED = 'This message id was already used for different content.';
export const REPORT_ALREADY_SENT = 'This turn already reported. Put everything in one report.';
export const TOOL_NOT_IN_TURN = 'This turn cannot use that tool.';
export const TURN_ENDED = 'This turn has ended. Report in your next turn.';
export const SETTINGS_CHANGED = 'Project settings changed elsewhere. Reload and try again.';
export const NOTEBOOK_CHANGED = 'The coordinator changed the notebook. Reload to see its version.';
export const notebookConflict = (revision: number, content: string): string => `The notebook changed (revision ${revision}). Current content:\n${content}`;
export const MERGE_CONFLICTS = 'This pull request has conflicts. Ask the thread to resolve them first.';
export const MERGE_CHECKS_FAILING = 'Checks are failing. Ask the thread to fix them first.';
// Threads and coordinators on other devices (phase 5, D266). Never the conversation wording of the conversation proxy.
/** A coordinator action that reached a device the coordinator does not run on (the routes proxy before this). */
export const COORDINATOR_ELSEWHERE = 'The coordinator runs on another device. Reload the project and try again.';
/** A proxied coordinator request that arrived at a device that is no longer the coordinator. */
export const COORDINATOR_NOT_HERE = 'The coordinator does not run on this device.';
export const PROJECT_OPERATION_NOT_FOUND = 'Project operation not found.';
export const THREAD_DEVICE_GONE = 'The device that runs this thread is no longer in this mesh.';
export const threadDeviceOffline = (deviceName: string): string => `${deviceName} is offline. This thread waits there until it is back.`;
export const threadDeviceUnreachable = (deviceName: string): string => `Can't reach ${deviceName}. This thread's work stays on that device.`;
export const coordinatorUnreachable = (deviceName: string): string => `Can't reach ${deviceName}. The coordinator stays on that device.`;
export const THREAD_DEVICE_REDIRECT = "The thread's device returned an unexpected redirect.";
export const COORDINATOR_DEVICE_REDIRECT = "The coordinator's device returned an unexpected redirect.";
/** A programming error: work for another device without the hub relay (unit tests build delivery without one). */
export const NO_RELAY = 'Another device is reached through the hub relay, which is not set up here.';
/** A thread start relayed to a device that is not the thread's owner. */
export const THREAD_STARTS_ELSEWHERE = 'This thread starts on another device.';
export const QUESTION_NOT_FOUND = 'This question was not found.';
/** The coordinator chat stream's cursor refusals (`Last-Event-ID` or `?after=`), answered 400 before the stream opens. */
export const EVENT_CURSOR_INVALID = 'Invalid project event cursor.';
export const EVENT_CURSOR_AHEAD = 'Project event cursor is ahead of its history.';
export const UNKNOWN_OPTION = 'Choose one of the offered options.';
/** The settings notice when a main default is shown as worktree on a Leave git project (brief 12.2). */
export const LEAVE_GIT_SETTING = 'This project is set to Leave git to me.';
/** Phase 7 terminal takeover command shown under the thread composer (brief 12.3). */
export const attachCommand = (threadId: string): string => `jevellan thread attach ${threadId}`;
