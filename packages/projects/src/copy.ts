import { NOT_ON_MAIN, OWNER_STARTED_PREFIX, OWNER_WORKED_PREFIX, RESTARTED_PREFIX, SAVED_COMMITS_SENTENCE, clipRedacted, splitSavedCommits, type CoordinatorEvent, type Isolation, type PlacementOverride, type ProjectDecision, type ThreadReport, type ThreadState } from '@jevellan/core';
import { firstLine, tail } from './git.js';

// Every brief-verbatim Projects string (brief 9) and the server copy of phase 1. Pure functions only.
// Placement copy lives in @jevellan/decisions (D135) and is re-exported here, never retyped.
export {
  ACCOUNT_REASON_TEXT, PROJECT_MODEL_NOT_ALLOWED, PROJECT_MODEL_EFFORT, NO_PROJECT_MODEL, LEAVE_GIT_MAIN, MAIN_NOT_AVAILABLE, NOT_CHOSEN_REASON, NO_PLACEMENT, NO_THREAD_MODEL, PLACEMENT_INCOMPATIBLE, PLACEMENT_INSTRUCTIONS,
  PLACEMENT_ISOLATION_CRITERIA, REMOTE_GATE_REASON, REMOTE_NOT_AVAILABLE, TASK_SHORTENED, UNKNOWN_PLACEMENT_DEVICE, UNKNOWN_PLACEMENT_MODEL,
} from '@jevellan/decisions';
export { ASK_USER_OPTIONS, NEEDS_DECISION_QUESTION, NO_CHANGES, OWNER_STOPPED_THREAD, coordinatorWorking } from '@jevellan/core';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const pad = (value: number) => String(value).padStart(2, '0');
/** `{HH:MM}`: 24-hour local time of the device that renders the event block (D36). */
export function clockTime(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 9.1 Coordinator system append
export function coordinatorSystemAppend(projectName: string, gitPolicy: 'main' | 'external' = 'main', startMode: 'start' | 'propose' = 'start'): string {
  return `You are the coordinator of the project "${projectName}" in Jevellan. You do not write code and you do not edit files. You plan, delegate to threads, keep track, and talk with the owner.

How you work:
- When you can answer from what you can read, answer in the chat yourself and create no task.
- When you route work, end your reply with one line per item: its title and whether it is a new task or went to an existing thread. The chat shows a card for each; do not repeat their details.
- Work arrives as tasks in the project queue. Create a task for every new piece of work with jevellan_task_create: a short title, a complete brief that a capable engineer could act on without this conversation, its type, and the goal it serves or no goal. Use source owner-request only for work the owner asked for in this turn, and mark it now only when the owner wants it done right away. When the work needs something from the machine it runs on, such as a residential network or a Mac, say so in needs. Follow-ups to work already under way go to that thread with jevellan_thread_message. Never duplicate an open task. Code controls dispatch, placement and limits.
- Preserve the outcome the owner asked for, including Jev's requested-result guidance. Carry it into the thread task and check the report against it. To run an app for the owner, have the thread start a managed app with jevellan_app_start and return its verified browser link. Tests and opening a file on the server do not complete that request. Continue authorized work without asking the owner to repeat it.
- Route each new request: if it continues work an active thread is doing, send it to that thread with jevellan_thread_message; otherwise create a new task. Queue independent pieces of work together. Set after only when a task needs another task's completed result. Worktree threads have separate copies and can work concurrently, including on shared files such as a changelog; handle any later conflict through the responsible thread. Main threads share a checkout, so sequence overlapping edits there.
- Jevellan chooses where each thread runs (isolation, model, effort, device). Only pass isolation, modelId, effort or deviceId when the owner explicitly asked for them.
- When goals need work, read their motivation and health with jevellan_goals_list, the notebook, recent tasks, job runs and the code. Create at most one worthwhile refill task per listed goal; create nothing when none is worthwhile. Code enforces autonomy and caps. A nightly review report is followed by jevellan_review_followup: choose at most one combined finding task for everything worth fixing, or choose none. A failed job or another finding may warrant one finding task per distinct problem, linked with after. Never duplicate open work. Only the owner changes goals.
- Worktree threads end in a pull request handled by Jevellan's merge gate when the owner enables automatic merging. Otherwise the owner merges. You have no merge tool. ${gitPolicy === 'external' ? 'This project is set to Leave git to me. Main threads edit the existing checkout, including untracked files, and leave all git operations to the owner. Do not ask the owner to commit files or change that policy just to make a code change. Worktree threads see only committed files; do not tell them to edit outside their workspace.' : 'Main threads publish directly to main.'}
- When a thread reports, decide the next step yourself whenever the answer follows from the owner's instructions, the notebook or the code. Ask the owner with jevellan_ask_user only when the decision is genuinely theirs. Keep questions short, offer 2 to 4 options when possible, and continue other work while waiting.
- Jevellan fixes failing checks, conflicts and new review comments by itself when Project settings allow it, and tells you with thread-auto-fix events. Message a thread about its pull request only when the owner asks, automatic fixes are off, or Jevellan gave up.
- To continue work that sits on an existing branch (from another session or tool), create a task with fromBranch.
- When a thread was interrupted by a restart or a failure, resume it with jevellan_thread_message if the work is still wanted.
- When the owner states a standing preference that matches a field of jevellan_settings_update, change the setting with that tool in this turn and say so in one line. Put other standing preferences in the notebook. Never change a setting without the owner's words in this turn.
${startMode === 'propose' ? '- This project proposes before starting. Tasks you create from the owner\'s requests wait as proposals until the owner starts them. When the owner tells you in this turn to start some or all of them, call jevellan_tasks_start.\n' : ''}- Keep the notebook current with jevellan_notebook_write whenever the plan, a decision or an owner instruction changes: the owner's instructions to you, decisions in flight, the current plan and open questions. Keep it concise. When your session has been idle long enough for its cache to expire, Jevellan continues in a fresh session that starts from the notebook and the project journal, so anything in neither is lost.
- The project journal records everything that happened in this project, one file per thread, per day and per night, listed in INDEX.md. When you need detail on past work, read the relevant file instead of guessing.
- Project memory is shared by every session in this project, on Claude and on Codex. Search it before planning work in an area. Write to it with memory_write what every future session should know: how to build, run and test things, gotchas and their fixes, conventions, decisions with their reasons, and owner preferences about the work. Plans and task status belong in the notebook, not in memory.
- Questions for the owner: whenever you ask one, and whenever the owner asks for status, end your reply with every open question, oldest first, numbered exactly as in your context, each with its thread and options. The owner may answer on the cards or in chat, several at once, such as "1 B, 2 done". Match each answer to its question, record it with jevellan_answer_question, and send it to the thread that needs it with jevellan_thread_message. If one answer is unclear, ask about that one only.
- GitHub: your threads' pull requests and Jevellan's jobs reach you as events. For anything else, such as workflow runs, pull requests from people or other tools, recent commits on main, or the log of a failed check, use jevellan_github.
- When the owner must run something on a machine, such as a sign-in, a sudo command or anything a session was not allowed to do, put the exact command in ownerCommands of jevellan_ask_user with its device and folder, so the owner can run it with one tap. When it has run, its output comes back to you as a message.

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
export const OPEN_QUESTIONS = 'Open questions to the owner (numbered as the owner sees them):';
/** B3: every coordinator turn states account readiness as it is now, so an old sign-in problem is never cited as current. */
export const ACCOUNTS_NOW = 'Accounts right now (live; this replaces anything said earlier about sign-in):';
export const accountNowLine = (label: string, runtime: string, devices: string): string => `- ${label} (${runtime}): ${devices}`;
export function numberedQuestionLine(decision: Pick<ProjectDecision, 'id' | 'question' | 'options'>, number: number, title: string): string {
  return `${number}. [${oneLine(title)}] ${oneLine(decision.question)} Options: ${decision.options.map(option => oneLine(option.label)).join(', ') || '(none)'}. (questionId ${decision.id})`;
}
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

${OPEN_QUESTIONS}
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
    case 'handoff-requested': return "Write today's handoff with jevellan_handoff_write. Account for every owner message since the last handoff: each must already be a thread, a task or a memory note, or be answered or declined. Create any that are missing first. The next session starts only from the handoff, memory, the thread registry and what waits on the owner.";
    case 'setup-requested': return SETUP_REQUESTED;
    case 'settings-changed': return event.instructions !== undefined ? `[instructions changed by ${event.by === 'owner' ? 'the owner' : 'you'}] Project instructions are now:\n${event.instructions}` : `[settings changed by ${event.by === 'owner' ? 'the owner' : 'you'}] ${event.changes.map(change => `${settingLabel(change.field)}: ${change.from} → ${change.to}`).join('; ')}`;
    case 'thread-resolved': return `[thread "${title(event.threadId)}" resolved by ${event.by === 'owner' ? 'the owner' : event.by === 'deploy' ? 'the deploy' : 'inactivity'}]`;
    case 'thread-placement-changed': return `[thread "${title(event.threadId)}" moved: ${event.summary}]`;
    case 'thread-auto-fix': return autoFixEventLine(event, title(event.threadId));
    case 'memory-dreamed': return `[memory dream] ${event.summary}\nChanges: ${JSON.stringify(event.counts)}`;
    case 'user-message': return `[owner ${(context.clock ?? clockTime)(event.at)}] ${event.text}`;
    case 'thread-report': {
      const report = event.report;
      return `[${thread(event.threadId)} reported ${report.status}] ${report.summary}${reportLines(report)}${report.synthesized ? SYNTHESIZED_SUFFIX : ''}${context.askedDirectly ? ASKED_DIRECTLY_SUFFIX : ''}`;
    }
    case 'thread-published': {
      if (event.result === 'landed') return `[${thread(event.threadId)} landed as ${(event.commit ?? '').slice(0, 7)}]`;
      const outcome = event.result === 'pr-opened' ? `Pull request #${event.prNumber} opened.` : event.result === 'pr-updated' ? `Pull request #${event.prNumber} updated.`
        : event.result === 'main-published' ? `Published to main as ${(event.commit ?? '').slice(0, 7)}.` : event.result === 'checkout-completed' ? 'Completed in the project checkout. Git is left to the owner.' : 'Concluded without changes.';
      return `[${thread(event.threadId)}] ${outcome}`;
    }
    case 'thread-verification-failed': return `[${thread(event.threadId)}] Tests failed ${event.attempts} times. Last output:\n${event.tail}`;
    case 'thread-interrupted': return `[${thread(event.threadId)} interrupted: ${event.reason}] ${event.message}`;
    case 'decision-answer': {
      const { optionLabel, text } = event.answer;
      return `[owner answered] "${event.question}" → ${optionLabel ? `${optionLabel}${text ? `. Note: ${text}` : ''}` : text ?? ''}`;
    }
    case 'pr-update': return `[PR #${event.prNumber} "${title(event.threadId)}"] ${event.change === 'conflict' ? `has conflicts with ${context.base}` : PR_CHANGES[event.change]}`;
    case 'pr-ready-for-review': return `[PR #${event.prNumber} "${title(event.threadId)}" on ${event.commit.slice(0, 7)}] ready for coordinator review`;
    case 'deploy': return event.outcome === 'deployed' ? `[deployed ${event.commit.slice(0, 7)} with ${event.threads} threads]` : event.outcome === 'rolled-back' ? `[deploy ${event.commit.slice(0, 7)} rolled back: ${event.summary}]` : `[deploy ${event.commit.slice(0, 7)} failed: ${event.summary}]`;
    case 'merge-gate': return `[PR #${event.prNumber} "${title(event.threadId)}" on ${event.commit.slice(0, 7)}] ${event.outcome}: ${event.summary}`;
    case 'job-finished': return `[job "${event.name}" ${event.conclusion === 'timed-out' ? 'timed out' : event.conclusion === 'skipped' ? 'was skipped' : event.conclusion} on ${event.commit.slice(0, 7)}] ${event.summary}`;
    case 'project-reviewed': return `[nightly review at ${event.report.commit}] ${JSON.stringify(event.report)}\nChoose exactly one combined finding task, or none, with jevellan_review_followup for reviewTaskId ${event.report.taskId}. Do not create separate tasks for individual findings.`;
    case 'window-opened': return `[nightly window opened: ${event.pending} daily tasks pending]`;
    case 'window-finished': return `[nightly window finished] ${event.outcome}`;
    case 'goal-refill': return `[goals that need work: ${event.goals.map(goal => `"${goal.name}" (refills today ${goal.refillsToday} of ${goal.cap})`).join('; ')}]`;
    case 'task-reviewed': return `[task "${event.title}" ${event.outcome} by the owner]`;
    case 'task-not-started': return `[task "${event.title}" not started] ${event.reason}`;
    case 'mail': return `[mail from "${event.fromTitle ?? title(event.fromThreadId)}" (${event.fromThreadId})] ${event.subject}\n${event.body}`;
    case 'thread-user-message':
      return PREFORMATTED.some((prefix) => event.text.startsWith(prefix)) ? event.text : `[owner wrote directly to ${thread(event.threadId)}] ${event.text}`;
    case 'placement-override': return `[owner changed ${thread(event.threadId)}] ${event.summary}`;
  }
}

// 9.4 Thread system append and turn prompts
export function threadSystemAppend(input: { copiedFiles?: string[] | undefined; projectName: string; cwd: string; isolation: Isolation; branch?: string | undefined; baseBranch: string;
  deviceName: string; testCommand?: string | undefined; gitPolicy?: 'main' | 'external' | undefined; instructions?: string | undefined }): string {
  const manual = input.isolation === 'main' && input.gitPolicy === 'external';
  const isolation = input.isolation === 'worktree'
    ? `Isolation: your own git worktree on branch ${input.branch ?? ''}, based on ${input.baseBranch}. Other threads work elsewhere. Commit your work on this branch.`
    : `Isolation: you work directly on main in the project checkout of ${input.deviceName}. Other main threads may work on other devices at the same time. Before editing, reserve the files or folders you will change with jevellan_reserve, check jevellan_mail_inbox at the start of each turn, and tell other threads about changes that affect them with jevellan_mail_send. Release reservations when done.`;
  return `You are working on one task for this project's coordinator. Work the way you normally would, in the project "${input.projectName}" at ${input.cwd}.

${isolation}

- Keep the coordinator informed. End every turn with exactly one jevellan_thread_report: progress while you are still working, done when the task is complete, blocked when something outside your control stops you, and needs-decision with two to four options when a choice belongs to the owner.
- ${manual ? "This project leaves git to the owner. Preserve unrelated work; do not commit, stage, stash, reset, switch branches, push or open a pull request. Leave the edits in place for the owner." : "Commit your work with the machine's git identity and no attribution. Jevellan pushes and opens the pull request; never push or open one yourself."}
- Write reports for the owner, in their language. Explain what changed and what they can now see or do, how to try it, and any remaining limitation. Keep progress updates short. A done report should describe the outcome, not just commits, commands or internal implementation details. The summary allows up to 4,000 characters.
- For visual work, capture the affected screens at desktop and phone widths using the available browser tools. Save screenshots inside your worktree and include Markdown image links with meaningful captions in your report. Explain what each shows; state clearly when a screen could not be checked. Keep these images available for the owner.
- Run only surgical tests: the ones that cover what you changed. Jevellan runs the project's checks and the full suite.
- Project memory is shared by every session in this project, on Claude and on Codex. Read the Project memory and Project now sections you receive. Search memory with memory_search before working in an unfamiliar area. When you learn something every future session should know, such as how to run or test something, a gotcha and its fix, or a convention, write it with memory_write in a few sentences.
- If your pull request's checks fail, read them with jevellan_github.
- If the owner must run something, because you are not allowed to or it needs their sign-in, put the exact command in ownerCommands of your jevellan_thread_report with why, and report blocked or needs-decision. Never ask the owner to run something you can run yourself. When the owner runs it, its output comes back to you as a message.
- Don't review your own work beyond normal care. Tests run after you, and a nightly review covers everything that merges.${input.copiedFiles?.length ? `\n- ${copiedFilesInstructions(input.copiedFiles)}` : ''}${input.instructions ? `\n\nProject instructions from the owner:\n${input.instructions}` : ''}`;
}

export const taskPrompt = (title: string, task: string): string => `Task: ${title}\n\n${task}`;
export const MESSAGE_SEPARATOR = '\n\n---\n\n';
/** One queued message is sent as is; several are each prefixed on their own line (D22). */
export function messagesPrompt(messages: ReadonlyArray<{ from: 'coordinator' | 'owner'; text: string }>): string {
  if (!messages.length) throw new Error('A thread turn needs at least one message.');
  if (messages.length === 1) return messages[0]!.text;
  return messages.map((message) => `From the ${message.from}:\n${message.text}`).join(MESSAGE_SEPARATOR);
}
export type ThreadTurnReason = 'task' | 'messages' | 'verification' | 'conflict' | 'checks' | 'comments' | 'continue' | 'publish' | 'steer';
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
export const PR_CLOSED = 'The pull request was closed without merging.';
export const WORKTREE_DISCARDED = ' Worktree discarded.';
export const TURN_WITHOUT_REPORT = 'The turn ended without a report.';
export const TURN_TIMED_OUT = 'The turn timed out after 6 hours.';
/** A failed turn whose runtime gave no error message (D154). */
export const TURN_FAILED = 'The turn failed.';
/** A turn whose process cleanup could not be confirmed while the daemon kept running (D155). */
export const PROCESS_UNCONFIRMED = "Jevellan could not confirm this thread's process stopped.";
/** An unexpected failure of a thread step, so no thread is left in a live state (D156). */
export const threadStepFailed = (message: string): string => clipRedacted(`This step failed: ${message}`, 400);
export const preparationRetrying = (reason: string, attempt: number, total: number, retryAt: string): string =>
  clipRedacted(`Preparation failed: ${reason.replace(/^This step failed: /u, '')} Retry ${attempt} of ${total} at ${retryAt.slice(11, 16)} UTC.`, 400);
export const preparationTaskFailed = (title: string, reason: string): string => clipRedacted(`Task "${title}" failed before its first turn: ${reason}`, 1000);
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
export const waitingForResourceReason = (reason: string): string => `${WAITING_FOR_SLOT}${reason}`;
export const isWaitingForSlot = (reason: string | undefined): boolean => !!reason?.startsWith(WAITING_FOR_SLOT);
/** A thread at rest whose next turn could not start while the hub was unreachable (D273); the sweep retries these too. */
export const WAITING_FOR_HUB = "Waiting for the hub. This thread continues when it's back.";
export const accountMovedNotice = (accountLabel: string): string => `This thread moved to account ${accountLabel}; a fresh session started.`;
export const cannotRunHere = (runtime: string): string => `${runtime} cannot run this here.`;
export const noTurnAccount = (modelLabel: string, deviceName: string, reasons: string): string => `No account can run ${modelLabel} on ${deviceName} right now: ${reasons}.`;
export const ACCOUNT_BUSY = 'This account is already running a turn, and its runtime cannot run two at once.';
/**
 * A thread attached in a terminal holds its account for turns on its device (phase 8): another thread whose next turn has no other
 * eligible account rests with this reason, and the sweep starts the turn once the terminal session ends.
 */
const WAITING_FOR_ACCOUNT = 'Waiting for account ';
export const waitingForAccountReason = (accountLabel: string): string =>
  `${WAITING_FOR_ACCOUNT}${accountLabel}, which is in use in a terminal. This thread continues when the terminal session ends.`.slice(0, 400);
export const isWaitingForAccount = (reason: string | undefined): boolean => !!reason && (reason.startsWith(WAITING_FOR_ACCOUNT) || reason.startsWith('Waiting for an account for '));
export const accountEligibilityWait = (model: string, reason: string, at: string | null): string => `Waiting for an account for ${model}: ${reason} It continues by itself when one is available${at ? `, expected at ${at}` : ''}.`;
export const USAGE_LIMIT_CONTINUE = 'Your previous turn stopped at a usage limit. Continue the task from where it stopped.';
export const recoveryContext = (summary?: string, partial?: string, journal?: string) => [summary ? `Previous thread report:\n${summary}` : '', partial ? `Last output before the usage limit:\n${partial}` : '', journal ? `This thread's project journal:\n${journal}` : ''].filter(Boolean).join('\n\n');
export const usageLimitWait = (account: string): string => `The turn stopped at a usage limit on ${account}. Waiting for an account.`;
export const usageLimitContinue = (from: string, to: string): string => `The turn stopped at a usage limit on ${from}. Continuing on ${to}.`;
export const unavailableModelAccount = (at: string | null) => `No eligible account until ${at ?? 'an unknown time'}`;
export const movedModelNotice = (from: string, to: string, at: string | null) => `Moved from ${from} to ${to} because ${from} has no account available ${at ? `until ${at}` : 'for now'}.`;
export const escalatedModelNotice = (from: string, effort: string, to: string, nextEffort: string, reason: 'blocked' | 'verification') => `Jev moved this thread from ${from} ${effort} to ${to} ${nextEffort} after ${reason === 'blocked' ? 'a blocked report' : 'two failed test runs'}.`;
/** The launch refusal when an attach took the account between the turn's check and its launch. */
export const accountInTerminal = (accountLabel: string): string => `Account ${accountLabel} is in use in a terminal.`;
/** The coordinator's Unavailable reason while every eligible account of its model is held by an attached thread (phase 8). */
export const coordinatorWaitsForAccount = (accountLabel: string): string =>
  `${accountInTerminal(accountLabel)} The coordinator continues when the terminal session ends.`.slice(0, 400);
export const MEMORY_HOOKS_UNDELIVERED = 'Project memory hooks could not be delivered to this account.';
/** A resumed turn whose native session the runtime no longer has (P8 review R-T1): the turn runs again at once in a new session. */
export const SESSION_REPLACED = "The thread's earlier session no longer exists, so it continues in a new session.";
/**
 * Messages that waited while a publication ran and that never reached the thread, because the publication concluded it (P8 review TH-5).
 * Each message is quoted on one line; the sentence keeps within a thread notice.
 */
export const messagesNotDelivered = (texts: readonly string[]): string =>
  clipRedacted(`The thread concluded before these messages reached it: ${texts.map((text) => `"${oneLine(text)}"`).join('; ')}`, 400);
/** A relayed envelope this device could not read was dropped (P8 review S-2): what it was, from where, and under which id. */
export function relayedEnvelopeLost(lost: { id: string | null; sourceDeviceId: string | null; kind: string | null }): string {
  const what = lost.kind === 'coordinator-event' ? 'An event for the coordinator' : lost.kind === 'thread-start' ? 'A thread start' : lost.kind === 'thread-command' ? 'A thread command'
    : 'A relayed message';
  return clipRedacted(`${what} from device ${lost.sourceDeviceId ?? '(unknown)'} could not be read here and was dropped (${lost.id ?? 'no id'}). Every device should run the same Jevellan version.`, 400);
}

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
/** The thread page line while every sweep settles the claim again (phase 8 retry of D291). */
export function checkoutStillHeld(message: string): string {
  const retry = ' Jevellan tries again until it is released.';
  return `${mainCheckoutKept(message).slice(0, 400 - retry.length)}${retry}`;
}
/** The thread notice once a retried settlement released the claim. */
export const MAIN_CHECKOUT_RELEASED = 'The project checkout was given back.';
/**
 * The thread notice when a retried stop settlement found the checkout changed since the stop was refused (P8 review N-2: the owner came
 * back to main with work of their own): the claim is released and git is left exactly as the owner left it.
 */
export const CHECKOUT_LEFT_AS_IS = "The checkout changed after the Stop, so Jevellan gave it back as it is: nothing was committed, saved or reset, and any of the thread's commits still on main stay there.";
/**
 * A main thread's next turn while its claimed checkout is off main (P8 review TH-1: the owner switched it to a branch of their own): no
 * turn runs on another branch, the thread rests with its messages, and the sweeps start the turn once the checkout is back on main.
 */
export const WAITING_FOR_MAIN = `${NOT_ON_MAIN} This thread continues once the checkout is back on main.`;
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
    case 'jevellan_handoff_write': return line('Saved coordinator work', 'save coordinator work');
    case 'jevellan_jobs_list': return line('Read jobs', 'read jobs');
    case 'jevellan_job_runs': return line('Read job runs', 'read job runs');
    case 'jevellan_daily_list': return line('Read daily work', 'read daily work');
    case 'jevellan_job_run': return line('Queued job', 'queued a job');
    case 'jevellan_goals_list': return line('Read goals', 'read goals');
    case 'jevellan_threads_list': return line('Listed threads', 'list threads');
    case 'jevellan_tasks_list': return line('Listed tasks', 'list tasks');
    case 'jevellan_task_create': return line(`${field(result, 'state') === 'draft' ? 'Proposed' : 'Queued'} task "${textField(input, 'title') ?? ''}"`, 'create a task');
    case 'jevellan_tasks_start': return line('Started proposed tasks', 'start proposed tasks');
    case 'jevellan_setup_propose': return line(SETUP_PROPOSED, 'propose project setup');
    case 'jevellan_settings_update': return line('Changed project settings', 'change project settings');
    case 'jevellan_task_update': return line('Updated a queued task', 'update a task');
    case 'jevellan_task_cancel': return line('Cancelled a queued task', 'cancel a task');
    case 'jevellan_thread_start': {
      const named = textField(input, 'title');
      return line(`${field(result, 'state') === 'queued' ? 'Queued' : 'Started'} "${named ?? ''}" · ${textField(result, 'placement') ?? ''}`, named ? `start "${named}"` : 'start a thread');
    }
    case 'jevellan_thread_message': return line(`Sent a message to ${thread}${field(result, 'delivery') === 'interrupting' ? ' and interrupted its turn' : ''}`, `send a message to ${thread}`);
    case 'jevellan_thread_read': return line(`Read ${thread}`, `read ${thread}`);
    case 'jevellan_thread_stop': return line(`Stopped ${thread}`, `stop ${thread}`);
    case 'jevellan_ask_user': return line(`Asked you: ${firstLine(rawField(input, 'question') ?? '').slice(0, 120)}`, 'ask you');
    case 'jevellan_answer_question': return line('Recorded your chat answer', 'record your chat answer');
    case 'jevellan_github': return line(`Read GitHub ${textField(input, 'action') ?? ''}`, 'read GitHub');
    case 'jevellan_withdraw_question':
      return line(field(result, 'withdrawn') === false ? 'The owner already answered that question' : `Withdrew a question: ${textField(input, 'reason') ?? ''}`, 'withdraw a question');
    case 'jevellan_notebook_read': return line('Read the notebook', 'read the notebook');
    case 'jevellan_notebook_write': return line('Updated the notebook', 'update the notebook');
    case 'jevellan_pr_status': {
      const number = field(field(result, 'pr'), 'number');
      return line(typeof number === 'number' ? `Checked PR #${number}` : `Checked ${thread}: no pull request`, `check the pull request of ${thread}`);
    }
    case 'jevellan_pr_diff': return line(`Read the pull request diff of ${thread}`, `read the pull request diff of ${thread}`);
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
export const NEXT_TURN_FIELDS = 'From the next turn, only the account, model and effort can change within the same runtime.';
export const RESTART_OPEN_PULL_REQUEST = 'This thread has an open pull request.';
export const RESTART_PUBLISHED_TO_MAIN = 'This thread already published to main.';
export const THREAD_ALREADY_RESTARTED = 'This thread was already restarted.';
/** The old thread's reason after a restart: `Restarted as {newId}.` (brief 10); the prefix is shared with the interface. */
export const restartedReason = (threadId: string): string => `${RESTARTED_PREFIX}${threadId}.`;
export const isRestarted = (reason: string | undefined): boolean => !!reason?.startsWith(RESTARTED_PREFIX);
const OVERRIDE_FIELDS = { isolation: 'Isolation', runtime: 'Runtime', account: 'Account', model: 'Model', effort: 'Effort', device: 'Device' } as const;
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
export const SETTINGS_CHANGED = 'These settings changed elsewhere. Reload to see them.';
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
/** Releases a thread whose attach could not detach (D47). */
export const detachCommand = (threadId: string): string => `jevellan thread detach ${threadId}`;
// Terminal takeover refusals (brief phase 7, D46, D297), answered by the local control routes and printed by the command.
export const THREAD_WORKING = 'The thread is working. Wait for the turn to end or stop it.';
export const NO_SESSION_TO_ATTACH = 'This thread has no session to attach to.';
export const threadRunsOn = (deviceName: string): string => `This thread runs on ${deviceName}. Run the command there.`;
export const alreadyAttached = (threadId: string): string => `This thread is already attached in a terminal. Exit that terminal first, or run ${detachCommand(threadId)}.`;
/** Stop, Restart and Discard of an attached thread, from the owner and the coordinator alike (phase 8): the terminal session ends first. */
export const attachedRefusal = (threadId: string): string =>
  `This thread is attached in a terminal: exit that terminal session first, or run ${detachCommand(threadId)}.`;
export const ATTACH_RUNTIMES_ONLY = 'Only Claude and Codex threads can be taken over in a terminal.';
/** A thread notice when detach could not search the account home: the thread continues its earlier session. */
export const sessionNotAdopted = (message: string): string => `The session from the terminal could not be found, so the thread keeps its earlier session. ${message}`.trim().slice(0, 400);

export const PROJECT_PAUSED = 'The project is paused.';
export const newThreadsPerDayReached = (count: number) => `New threads per day reached (${count}). The next one starts tomorrow, or after you raise the limit in Project settings.`;

// Projects parity: owner settings and the coordinator's routing contract.
export const COORDINATOR_ANSWER_IN_CHAT = 'Answer it in the chat if you can from the notebook, memory, the threads, GitHub or the repository. Create a task only if the answer needs a change, a run or a long investigation.';
export const COORDINATOR_CARRY_RESULT = 'Carry this result into the thread task and check the report against it before concluding.';
export const coordinatorOwnerInstructions = (instructions: string) => `Project instructions from the owner (every new thread receives them too):\n${instructions}\n\n`;
export const OWNER_SETTINGS_ONLY = 'Only an owner message in this turn can change project settings.';
export const OWNER_START_ONLY = 'Only an owner message in this turn can start proposed tasks.';
export const INSTRUCTIONS_TOO_LONG = 'Project instructions would exceed 16,000 characters.';
export const GUIDANCE_TOO_LONG = 'Guidance for Jev would exceed 2,000 characters.';
export const STARTED_IN_CHAT = "Started on the owner's word in chat.";
export const proposedTask = (title: string) => `Proposed "${title}". It starts when the owner starts it.`;
export const startedTask = (title: string) => `Started "${title}".`;
export const SETTING_LABELS: Record<string, string> = { maxRunningThreads: 'max running threads', maxNewThreadsPerDay: 'new threads per day', startMode: 'start mode',
  'prAutoFix.checks': 'fixing failing checks', 'prAutoFix.conflicts': 'resolving conflicts', 'prAutoFix.comments': 'addressing review comments', instructions: 'project instructions', 'placement.guidance': 'guidance for Jev' };
export const settingLabel = (field: string) => SETTING_LABELS[field] ?? field;
export const settingText = (value: unknown) => (value === true ? 'on' : value === false ? 'off' : value === 'start' ? 'start right away' : value === 'propose' ? 'propose first' : typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 400);
function autoFixEventLine(event: Extract<CoordinatorEvent, { kind: 'thread-auto-fix' }>, title: string): string {
  const prefix = `pull request #${event.prNumber} of "${title}"`;
  if (event.outcome === 'started') return `[${prefix}: Jevellan asked the thread to fix ${event.fixKind === 'checks' ? 'the failing checks' : event.fixKind === 'conflicts' ? 'the conflict' : `${event.comments ?? 0} review comments`} (round ${event.round} of ${event.maxRounds})]`;
  if (event.outcome === 'fixed') return `[${prefix}: ${event.fixKind === 'checks' ? 'checks pass' : event.fixKind === 'conflicts' ? 'conflict resolved' : 'review comments addressed'} after automatic fixes]`;
  return `[${prefix}: still ${event.fixKind === 'checks' ? 'failing checks' : event.fixKind === 'conflicts' ? 'conflicting' : 'has review comments'} after ${event.maxRounds} automatic fixes; the owner was asked]`;
}

export const SETTING_CHANGED_AGAIN = 'Changed again since.';

export const PROJECT_SETTINGS_UNAVAILABLE = 'Project settings are unavailable.';

export const RESOLVED_BY_OWNER = 'Resolved by you.';
export const RESOLVED_BY_INACTIVITY = 'Resolved after a week without activity.';
export const ACTION_NO_CHECKS = 'This pull request has no failing checks.';
export const ACTION_NO_CONFLICTS = 'This pull request has no conflicts.';
export const ACTION_NO_COMMENTS = 'There are no new review comments.';
export const ACTION_NO_COMMITS = 'This thread has no commits to publish.';
export const ACTION_OPEN_PR = 'This thread already has an open pull request.';
export const ACTION_WORKING = 'The thread is working. Wait for the turn to end or stop it.';
export const ACTION_ID_REUSED = 'This action id was already used for a different action.';
export const ACTION_RESOLVE_OPEN_PR = 'Merge or close the open pull request before resolving this thread.';
export const ACTION_NOT_RESOLVABLE = 'Only an idle, waiting or failed thread can be resolved.';
export const ACTION_NOT_REOPENABLE = 'Only a resolved idle or failed thread can be reopened.';
export const PUBLISH_REQUESTED = 'Publish the saved work through managed verification and publication.';
/** The failing runs and jobs are named by id (fix-051), so the thread asks for exactly those with jevellan_github. */
export function checksFixPrompt(n: number, sha: string, names: string[], jobs: ReadonlyArray<{ runId: number; jobId: number; name: string }> = []): string {
  const failing = jobs.length ? `\nFailing jobs on this head: ${jobs.slice(0, 10).map(job => `${job.name} (run ${job.runId}, job ${job.jobId})`).join('; ')}. Read each with jevellan_github: action "run" with its runId, then "job_log" with its jobId.` : '';
  return `Checks failed on pull request #${n} at ${sha.slice(0, 7)}: ${names.slice(0, 10).join(', ')}.${failing}\nRead the failing jobs and their logs with jevellan_github, find the cause, fix it in this worktree, run the relevant tests and report done.\nIf the failure is not caused by this pull request (for example an outage, or a flaky test you can show is unrelated), report blocked and say why.`;
}
/** The thread notice and ledger line when a fix turn first moves its worktree to the pull request's current head (fix-051). */
export const pullHeadUpdated = (n: number, sha: string) => `Updated the worktree to pull request #${n}'s head ${sha.slice(0, 7)} before this fix.`;
export const pullHeadUpdateFailed = (n: number, message: string) => `Could not update the worktree to pull request #${n}'s head before this fix: ${message}`;
export function pullHeadConflictPrompt(n: number, sha: string, files: string[]): string {
  return `Someone else pushed to pull request #${n}. Its head ${sha.slice(0, 7)} is being merged into this branch (not rebased) and the merge stopped on conflicts in: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', …' : ''}.\nResolve them keeping the intent of both sides, commit the merge, then continue with the request below.`;
}
export function conflictFixPrompt(n: number, base: string): string {
  return `Pull request #${n} conflicts with ${base}. Fetch origin, merge origin/${base} into this branch (do not rebase), resolve the conflicts keeping the intent of both sides, run the relevant tests and report done.`;
}

export function commentsFixPrompt(n: number, comments: import('@jevellan/core').PullComment[]): string {
  return `New review comments on pull request #${n}:\n${comments.map(row => `- ${row.author}${row.path ? ` on ${row.path}:${row.line ?? '?'}` : ''}: ${row.body}`).join('\n')}\nAddress each one: change the code where the comment is right, run the relevant tests and report done. In your report, list any comment you did not act on and why.`;
}

export const LEAVE_AUTOMATIC_FIXES = 'Leave it to me';
export const allowAutomaticFixes = (n: number) => `Allow ${n} more automatic fixes`;
export const automaticFixQuestion = (n: number, kind: import('@jevellan/core').PrAutoFixKind, max: number) =>
  `Pull request #${n} still ${kind === 'checks' ? 'has failing checks' : kind === 'conflicts' ? 'has conflicts' : 'has review comments'} after ${max} automatic fixes.`;

export const AUTOMATIC_FIX_CANCELLED = 'Automatic fix cancelled because its project setting changed before it started.';

export const notificationQuestionTitle = (project: string) => `${project}: question`;
export const notificationThreadTitle = (project: string, title: string) => `${project}: ${title}`;
export const notificationFailedBody = (reason: string) => `Failed: ${reason}`;
export const notificationCoordinatorStopped = (error: string) => `The coordinator stopped: ${error}`;
export const NOTIFICATION_TEST_TITLE = 'Jevellan';
export const NOTIFICATION_TEST_BODY = 'Notifications work on this device.';

export const unsafeCopyFile = (path: string) => `Cannot copy ${path}: use a regular file inside the project, without a symlink.`;
export const skippedCopyFile = (path: string, device?: string) => device ? `Skipped ${path}: not in ${device}'s project folder.` : `Skipped ${path}: the repository tracks it.`;
export const copiedFileCommitted = (commit: string, path: string) => `Commit ${commit.slice(0, 7)} adds ${path}, which was copied from the project folder and must not be committed. Remove it from this branch's history and report done again.`;
export const copiedFilesInstructions = (paths: string[]) => `These files were copied from the project folder and are not part of the repository; never commit them: ${paths.join(', ')}.`;
export const LIBRARY_TOO_LARGE = 'Files up to 50 MB.';
export const LIBRARY_FULL = "This project's library is full (2 GB). Delete files to add more.";
export const libraryInstructions = (directory: string, thread: boolean) => `The project library is at ${directory}. Attached files appear in messages as library/<path>; read them from that folder.${thread ? '\nTo keep a file for the owner (a report, an export, an image), add it to the library with jevellan_library_add and mention it in your report.' : ''}`;
export const libraryAdded = (path: string) => `Added to the library as library/${path}.`;
export const LIBRARY_FOLDER_ALIAS = 'Library folders cannot alias another location.';
export const LIBRARY_INVALID_PAGE = 'The hub returned an invalid library page.';
export const LIBRARY_FILE_NOT_FOUND = 'Library file not found.';
export const LIBRARY_RELOAD = 'Reload the library to see its current files.';
export const LIBRARY_CONTENT_TYPE = 'Give the file a content type.';
export const LIBRARY_THREAD_REQUIRED = 'A thread output needs its thread.';
export const LIBRARY_INVALID_FILE = 'The hub returned an invalid library file.';
export const LIBRARY_SHORT_NAME = 'Use a shorter file name.';
export const LIBRARY_INCOMPLETE = 'The upload ended before the whole file arrived.';
export const LIBRARY_UNAVAILABLE = 'The project library is unavailable.';
export const LIBRARY_FILE_UNAVAILABLE = 'The library file is unavailable.';
export const LIBRARY_HASH_FAILED = 'The library file failed its hash check.';
export const LIBRARY_HEADERS_REQUIRED = 'Content-Type and Content-Length are required.';
export const LIBRARY_THREAD_FORBIDDEN = 'This thread cannot add files to that library.';
export const LIBRARY_OPERATION_MISSING = 'Library operation not found.';
export const LIBRARY_READ_ONLY = 'This session can only read the project library.';

export const SETUP_ALREADY_PROPOSED = 'Setup was already proposed for this project. The owner can ask for it again from the project menu.';
export const SETUP_PROPOSED = 'Proposed project setup';
export const SETUP_REQUESTED = '[the owner requested setup recommendations]';
export const SETUP_PROMPT = `This project is new to you. Before anything else, read the README, AGENTS.md or CLAUDE.md, the package or build files, the CI workflows (jevellan_github) and the last 20 commits.
Write a short notebook entry: what the project is, how it is built and tested, and what looks unfinished.
Then call jevellan_setup_propose with what you would set: the test command, the worktree setup command, project instructions drawn from the repository's own conventions, untracked files new worktrees need (such as .env.local), environment variable and secret names they need (never values), and at most three goals.
Propose only what the repository supports, and leave out what you cannot tell. Then answer the owner's message, if there is one.`;
