// Every brief-verbatim string of the Projects interface (brief 12 and the interface half of 9.8) plus the interface's own
// Projects copy. Pages import from here and never retype these texts. The Projects area never says conversation,
// stretch or handoff (tests/project-work-ui.test.ts scans this module).

// 12.1 Navigation
export const PROJECTS = 'Projects';
/** Read after `Projects` on the sidebar section toggle, so its name is `Projects section`, not the Settings tab's `Projects` (D214). */
export const SECTION_SUFFIX = ' section';
export const OPEN = 'Open';
export const NO_PROJECTS = 'No projects yet.';
export const ADD_PROJECT = 'Add a project';
export const runningCount = (count: number): string => `${count} running`;
/** Read after the magenta waiting count for screen readers. */
export const WAITING_SUFFIX = ' waiting';
export const LOADING_PROJECT = 'Loading project…';
export const LOADING_THREAD = 'Loading thread…';
export const BACK_TO_PROJECT = 'Back to the project';

// 12.2 Project page header
export const COORDINATOR_IDLE = 'Idle';
export const COORDINATOR_WORKING_CHIP = 'Working…';
export const COORDINATOR_UNAVAILABLE = 'Unavailable';
export const COORDINATOR_OFFLINE = 'Offline';
export const coordinatorSession = (runtime: string, modelLabel: string, effort: string): string => `${runtime} ${modelLabel} · ${effort}`;
export const NEW_THREAD = 'New thread';
export const NOTEBOOK = 'Notebook';
export const PROJECT_MENU = 'Project menu';
export const PROJECT_SETTINGS = 'Project settings';
export const FRESH_COORDINATOR = 'Fresh coordinator session';
export const MOVE_COORDINATOR = 'Move coordinator here';
/** Shown after Fresh coordinator session, which changes nothing visible until the next turn (D77). */
export const FRESH_STARTED = 'The next coordinator turn starts a fresh session.';
export const RECONNECTING = 'Reconnecting…';

// 12.2 Sections, their empty lines and the tab bar below 1180 px
export const WAITING_FOR_YOU = 'Waiting for you';
export const RUNNING = 'Running';
export const PULL_REQUESTS = 'Pull requests';
export const CONCLUDED = 'Concluded';
export const NOTHING_WAITING = 'Nothing waiting.';
export const NO_THREADS_RUNNING = 'No threads running.';
export const NO_OPEN_PULL_REQUESTS = 'No open pull requests.';
export const NOTHING_CONCLUDED = 'Nothing concluded in the last 14 days.';
export const TAB_LABELS = { chat: 'Chat', waiting: 'Waiting', threads: 'Threads', 'pull-requests': 'Pull requests' } as const;
export const PROJECT_SECTIONS = 'Project sections';
export const LOADING = 'Loading…';
export const RELOAD = 'Reload';
export const SAVING = 'Saving…';

// 12.2 Chat
export const CHAT_PLACEHOLDER = 'Tell the coordinator what you need';
export const CHAT_INPUT_LABEL = 'Message the coordinator';
export const CHAT_LABEL = 'Coordinator chat';
/** The owner's own messages in the chat, as in every other chat of the app. */
export const YOU = 'You';
export const COORDINATOR_WORKING = 'Coordinator is working…';
export const STOP = 'Stop';
export const STOP_COORDINATOR = 'Stop the coordinator';
export const SEND = 'Send';
export const EMPTY_CHAT = 'Describe what you want done. The coordinator splits it into threads, runs them on your devices and accounts, and brings back what needs you.';
/** An event card or owner message the coordinator has not received in a turn yet (D2a). */
export const WAITING_FOR_COORDINATOR = 'Waiting for the coordinator';
export const OPEN_THREAD = 'Open thread';

// Chat event cards: one sentence per coordinator event (D215). `name` is a quoted thread title or `a thread`.
export const UNKNOWN_THREAD_NAME = 'a thread';
export const quotedTitle = (title: string): string => `"${title}"`;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const eventCopy = {
  reportProgress: (name: string) => sentence(`${name} reported progress`),
  reportDone: (name: string) => sentence(`${name} is done`),
  reportDecision: (name: string) => sentence(`${name} needs a decision`),
  reportBlocked: (name: string) => sentence(`${name} is blocked`),
  prOpened: (name: string, n: number | undefined) => sentence(`${name} opened ${n ? `pull request #${n}` : 'a pull request'}`),
  prUpdated: (name: string, n: number | undefined) => sentence(`${name} updated ${n ? `pull request #${n}` : 'its pull request'}`),
  mainPublished: (name: string) => sentence(`${name} published to main`),
  noChanges: (name: string) => sentence(`${name} concluded without changes`),
  testsFailed: (name: string, attempts: number) => `Tests failed ${attempts === 1 ? 'once' : `${attempts} times`} in ${name}`,
  interruptedRestart: (name: string) => sentence(`${name} was interrupted by a restart`),
  interruptedTimeout: (name: string) => sentence(`${name} timed out`),
  interruptedFailed: (name: string) => sentence(`${name} failed`),
  interruptedStopped: (name: string) => sentence(`${name} was stopped`),
  answered: (question: string) => `You answered: ${question}`,
  answer: (optionLabel: string | undefined, text: string | undefined) => optionLabel ? `${optionLabel}${text ? `. ${text}` : ''}` : text ?? '',
  checksFailed: (name: string, n: number) => `Checks failing on pull request #${n} of ${name}`,
  checksPassed: (name: string, n: number) => `Checks passing on pull request #${n} of ${name}`,
  prMerged: (name: string, n: number) => `Pull request #${n} of ${name} was merged`,
  prClosed: (name: string, n: number) => `Pull request #${n} of ${name} was closed without merging`,
  prConflict: (name: string, n: number) => `Pull request #${n} of ${name} has conflicts`,
  mail: (name: string, subject: string) => `Mail from ${name}: ${subject}`,
  ownerStarted: (name: string) => `You started ${name}`,
  ownerWorked: (name: string) => `You worked on ${name} in a terminal`,
  ownerWrote: (name: string) => `You wrote to ${name}`,
  overridden: (name: string) => `You changed ${name}`,
} as const;

// 12.2 Decision card (Waiting for you)
export const FROM_COORDINATOR = 'From the coordinator';
export const fromThread = (title: string): string => `From "${title}"`;
export const ANSWER_IN_OWN_WORDS = 'Answer in your own words';
export const SENT_TO_COORDINATOR = 'Sent to the coordinator.';
/** A thread's own question goes back to that thread, not to the coordinator (D224). */
export const sentToThread = (title: string): string => `Sent to "${title}".`;
export const SENT_TO_THREAD = 'Sent to the thread.';
export const ANSWERED = 'Answered';
export const questionWithdrawn = (reason: string): string => `A question was withdrawn: ${reason}`;

// 12.2 Thread row and 12.3 placement line
export const WORKTREE = 'Worktree';
export const MAIN = 'Main';
export const worktreeOn = (branch: string): string => `Worktree on ${branch}`;
export const threadMetaText = (p: { runtime: string; modelLabel: string; effort: string; isolation: string; device: string }): string =>
  `${p.runtime} · ${p.modelLabel} · ${p.effort} · ${p.isolation} · ${p.device}`;
export const placementLineText = (p: { runtime: string; modelLabel: string; effort: string; accountLabel: string; isolation: string; device: string }): string =>
  `${p.runtime} · ${p.modelLabel} · ${p.effort} effort · ${p.accountLabel} · ${p.isolation} · ${p.device}`;
/** Thread states in words, for the dot's tooltip and screen readers (the dots carry the color, D54). */
export const STATE_LABELS = {
  queued: 'Queued', preparing: 'Preparing', running: 'Running', idle: 'Idle', publishing: 'Publishing', 'in-review': 'In review',
  'waiting-for-you': 'Waiting for you', attached: 'Attached', done: 'Done', stopped: 'Stopped', failed: 'Failed',
} as const;
export const mergedOutcome = (n: number): string => `Merged #${n}`;
export const PUBLISHED_TO_MAIN = 'Published to main';
export const NO_CHANGES_OUTCOME = 'No changes';
export const STOPPED = 'Stopped';
export const FAILED = 'Failed';

// 12.2 Pull request row and merge confirmation
export const pullRequestTitle = (n: number, title: string): string => `#${n} ${title}`;
export const CHECKS_PASSING = 'Checks passing';
export const CHECKS_FAILING = 'Checks failing';
export const CHECKS_RUNNING = 'Checks running';
export const NO_CHECKS = 'No checks';
export const CONFLICTS = 'Conflicts';
export const MERGE = 'Merge';
export const OPEN_ON_GITHUB = 'Open on GitHub';
/** Merge tooltips; the server refuses the same merges with the same sentences (D75). */
export const MERGE_BLOCKED_CONFLICTS = 'This pull request has conflicts. Ask the thread to resolve them first.';
export const MERGE_BLOCKED_CHECKS = 'Checks are failing. Ask the thread to fix them first.';
export const mergeTitle = (n: number): string => `Squash and merge #${n}?`;
export const mergeBody = (title: string, baseBranch: string): string => `${title} will be squashed into ${baseBranch}. The thread's worktree is removed afterwards.`;
export const CANCEL = 'Cancel';
/** The merge body when no base branch can be read (no checkout here and the thread page unreachable). */
export const UNKNOWN_BASE = 'its base branch';
export const MERGE_FAILED = 'The pull request was not merged.';

// 12.2 New thread modal
export const TITLE = 'Title';
export const TASK = 'Task';
export const PLACEMENT = 'Placement';
export const ISOLATION = 'Isolation';
export const AUTOMATIC = 'Automatic';
export const MODEL = 'Model';
export const EFFORT = 'Effort';
export const DEVICE = 'Device';
export const START_THREAD = 'Start thread';
export const STARTING = 'Starting…';
/** Placement phase gates (D88), the same sentences placement refuses with (D221). */
export const MAIN_NOT_AVAILABLE = 'Main isolation is not available yet.';
export const REMOTE_NOT_AVAILABLE = 'Threads run only on this device for now.';

// 12.2 Notebook panel
export const EDIT = 'Edit';
export const SAVE = 'Save';
export const NOTEBOOK_CHANGED = 'The coordinator changed the notebook. Reload to see its version.';
export const LOADING_NOTEBOOK = 'Loading notebook…';
export const NOTEBOOK_EMPTY = 'Nothing in the notebook yet. The coordinator keeps decisions, conventions and the current plan here.';
export const NOTEBOOK_CONTENT = 'Notebook content';
export const notebookUpdated = (by: 'coordinator' | 'owner', when: string): string =>
  `Updated by ${by === 'owner' ? 'you' : 'the coordinator'} · ${when}`;

// 12.2 Project settings modal
export const DEFAULT_ISOLATION = 'Default isolation';
export const WORKTREE_AND_PULL_REQUEST = 'Worktree and pull request';
export const LEAVE_GIT_SETTING = 'This project is set to Leave git to me.';
export const COORDINATOR_MODEL = 'Coordinator model';
export const AUTOMATIC_FIRST_AVAILABLE = 'Automatic: first available';
export const COORDINATOR_EFFORT = 'Coordinator effort';
export const SETUP_COMMAND = 'Worktree setup command';
export const SETUP_COMMAND_PLACEHOLDER = 'npm ci';
export const MAX_RUNNING_THREADS = 'Max running threads';
export const MAX_PER_DEVICE = 'Max per device';
export const TURN_LIMIT = 'Turn limit per thread';
export const SETTINGS_SAVED = 'Project settings saved.';

// 12.3 Thread page
export const WHY = 'Why';
export const OVERRIDE = 'Override';
export const DISCARD = 'Discard';
export const discardQuestion = (branch: string): string => `Remove the worktree and local branch ${branch}?`;
export const ALLOW_MORE_TURNS = 'Allow 10 more turns';
export const THREAD_PLACEHOLDER = 'Message this thread';
export const INTERRUPT_TURN = 'Interrupt current turn';
export const attachedNotice = (device: string): string => `Attached in a terminal on ${device}. Messages wait until you exit.`;
/** `command` is the thread view's `attachCommand` (`jevellan thread attach {threadId}`), never retyped here. */
export const takeOverLine = (device: string, command: string): string => `Take over in a terminal on ${device}: ${command}`;
export const FROM_NEXT_TURN = 'From the next turn';
export const RESTART_WITH_CHOICES = 'Restart with these choices';
export const OPEN_PULL_REQUEST_BLOCKS_RESTART = 'This thread has an open pull request.';
export const APPLY = 'Apply';
export const JUMP_TO_LATEST = 'Jump to latest';
/** The label of a Jevellan turn prompt in a thread transcript (D56). */
export const PROMPT = 'Prompt';
/** Prompts longer than this collapse in thread transcripts (D56). */
export const PROMPT_COLLAPSE_CHARACTERS = 1200;
export const STOP_THREAD_TITLE = 'Stop this thread?';
export const STOP_THREAD_BODY = 'The current turn ends and the thread takes no more work.';
export const STOP_KEEPS_WORKTREE = 'Its worktree and branch stay until you discard them.';
/** Discard of a worktree thread that failed before it had a branch. */
export const DISCARD_NO_BRANCH = 'Remove the worktree?';
export const DISCARD_BODY = 'Uncommitted work and commits that were not pushed are lost.';
/** The toast after Discard; the server appends the same words to the state reason. */
export const WORKTREE_DISCARDED = 'Worktree discarded.';
export const MORE_TURNS_ALLOWED = 'The thread can take 10 more turns.';
/** The composer of a concluded thread; the server refuses messages to it with the same sentence (D81). */
export const THREAD_ENDED = 'This thread has ended. Start a new thread for new work.';
/** The composer's live line while a turn, the preparation or the publication runs. */
export const turnRunning = (turn: number): string => `Working on turn ${turn}…`;
export const PREPARING = 'Preparing…';
export const PUBLISHING = 'Publishing…';
export const TRANSCRIPT_LABEL = 'Thread transcript';
export const TRANSCRIPT_TRUNCATED = 'Showing the most recent part of the transcript.';
export const NO_TRANSCRIPT_YET = 'Nothing here yet. The transcript appears once the first turn starts.';
export const TRANSCRIPT_UNAVAILABLE = 'The transcript cannot be read right now. Reports are shown on their own.';
/** Report cards (12.3): the turn they report, their status chip and the tests they ran. */
export const reportHeading = (turn: number): string => `Report · turn ${turn}`;
export const REPORT_STATUS = { progress: 'Progress', done: 'Done', 'needs-decision': 'Needs a decision', blocked: 'Blocked' } as const;
/** A report Jevellan wrote because the turn ended without one or failed (brief 8.2). */
export const SYNTHESIZED_REPORT = 'Recorded by Jevellan';
export const TESTS_PASSED = 'Tests passed';
export const TESTS_FAILED = 'Tests failed';
/** Messages that wait for the thread's next turn (D81). */
export const QUEUED_MESSAGES = 'Waiting for the next turn';
export const COORDINATOR = 'Coordinator';
export const INTERRUPTS_TURN = 'Interrupts the current turn';
/** The thread header's pull request chip and its state once it is no longer open. */
export const pullRequestNumber = (n: number): string => `#${n}`;
export const PR_MERGED = 'Merged';
export const PR_CLOSED = 'Closed';
export const OPEN_PULL_REQUEST = 'Open the pull request on GitHub';

// 12.4 Settings, Git
export const GITHUB_TOKEN = 'GitHub token';
export const savedUpdated = (date: string): string => `Saved · updated ${date}`;
export const NOT_SET = 'Not set';
export const REPLACE = 'Replace';
export const REMOVE = 'Remove';
export const GITHUB_TOKEN_HELP = 'Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and Checks read on your repositories is enough.';
/** The card's first save, when no token is set (Replace would have nothing to replace). */
export const ADD_TOKEN = 'Add token';
export const ADD_TOKEN_TITLE = 'Add a GitHub token';
export const REPLACE_TOKEN_TITLE = 'Replace the GitHub token';
export const TOKEN_REPLACED_NOTE = 'The saved token is replaced when you submit this form.';
export const SAVE_TOKEN = 'Save token';
export const TOKEN_SAVED = 'GitHub token saved.';
export const REMOVE_TOKEN_TITLE = 'Remove the GitHub token?';
export const REMOVE_TOKEN_BODY = 'Threads then push their branches without opening pull requests, and their pull requests can no longer be checked or merged from Jevellan.';
export const TOKEN_REMOVED = 'GitHub token removed.';

// 9.8 Notices
export const coordinatorUnavailableNotice = (reason: string): string => `The coordinator cannot run: ${reason}`;
export const coordinatorOfflineNotice = (device: string): string => `The coordinator lives on ${device}, which is offline.`;
export const placedWithoutJev = (reason: string): string => `Placed without Jev: ${reason}`;
