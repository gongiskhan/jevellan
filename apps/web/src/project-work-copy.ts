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
export const LOADING_CHAT = 'Loading chat…';
export const LOADING_THREAD = 'Loading thread…';
export const BACK_TO_PROJECT = 'Back to the project';

// 12.2 Project page header
export const COORDINATOR_IDLE = 'Idle';
export const COORDINATOR_WORKING_CHIP = 'Working…';
export const COORDINATOR_UNAVAILABLE = 'Unavailable';
export const COORDINATOR_OFFLINE = 'Offline';
export const coordinatorSession = (runtime: string, modelLabel: string, effort: string): string => `${runtime} ${modelLabel} · ${effort}`;
export const NEW_THREAD = 'New task';
export const NOTEBOOK = 'Notebook';
export const PROJECT_MENU = 'Project menu';
export const PROJECT_SETTINGS = 'Project settings';
export const SETTINGS_SECTIONS = 'Project settings sections';
export const SETTINGS_GENERAL = 'General';
export const SETTINGS_INSTRUCTIONS = 'Instructions';
export const SETTINGS_PLACEMENT = 'Placement';
export const SETTINGS_LIMITS = 'Threads and limits';
export const SETTINGS_ENVIRONMENT = 'Environment';
export const SETTINGS_ROUTINES = 'Routines';
export const SETTINGS_NOTIFICATIONS = 'Notifications';
export const SETTINGS_USAGE = 'Usage';
export const PROJECT_STATUS = 'Status';
export const PROJECT_STATUS_LABELS = { active: 'Active', paused: 'Paused', archived: 'Archived' } as const;
export const PROJECT_PAUSED_BANNER = 'This project is paused. Nothing new starts until you resume it.';
export const PROJECT_ARCHIVED_BANNER = 'This project is archived. Nothing runs and it is hidden from the sidebar.';
export const RESUME_PROJECT = 'Resume';
export const UNARCHIVE_PROJECT = 'Unarchive';
export const archivedProjects = (count: number) => `Archived (${count})`;
export const FRESH_COORDINATOR_SETTINGS = 'Fresh coordinator session';
export const PROJECT_INSTRUCTIONS = 'Project instructions';
export const THREAD_MODELS = 'Models threads may use';
export const ALL_ENABLED_MODELS = 'All enabled models';
export const LOWEST_EFFORT = 'Lowest effort for threads';
export const NO_MINIMUM = 'No minimum';
export const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' } as const;
export const PLACEMENT_GUIDANCE = 'Guidance for Jev';
export const START_MODE = 'When the coordinator plans work';
export const START_RIGHT_AWAY = 'Start threads right away';
export const PROPOSE_FIRST = 'Propose threads and wait for me';
export const NEW_THREADS_PER_DAY = 'New threads per day';
export const COMPACT_AT_PERCENT = 'Compact at percent';
export const CHECKPOINT_LARGE = 'Checkpoint large cold thread sessions';
export const CHECKPOINT_MINIMUM = 'Checkpoint minimum context tokens';
export const FIX_CHECKS_AUTOMATICALLY = 'Fix failing checks automatically';
export const FIX_CONFLICTS_AUTOMATICALLY = 'Resolve conflicts automatically';
export const FIX_COMMENTS_AUTOMATICALLY = 'Address review comments automatically';
export const AUTOMATIC_FIX_LIMIT = 'Automatic fixes per pull request';
export const AUTO_MERGE = 'Merge automatically after checks';
export const REQUIRED_CHECKS = 'Required checks';
export const RISKY_AREAS = 'Risky areas';
export const ALLOW_MAIN = 'Allow work directly on main';
export const COPY_UNTRACKED = 'Copy these untracked files into new worktrees';
export const COPY_UNTRACKED_HELP = 'One path per line, relative to the project folder, for example .env.local. Missing files are skipped. Jevellan never commits them.';
export const ENV_VARIABLES = 'Variables';
export const ENV_SECRETS = 'Secrets';
export const ENV_NAME = 'Name';
export const ENV_VALUE = 'Value';
export const ADD_VARIABLE = 'Add variable';
export const ADD_SECRET = 'Add secret';
export const REMOVE_ENV = 'Remove';
export const SECRET_NOT_SET = 'Not set';
export const SECRET_HELP = 'Variables and secrets reach the setup command, threads, verification and jobs. Secret values stay in the hub vault and are redacted from transcripts.';
export const secretSavedAt = (date: string) => `Saved · updated ${date}`;
export const variableName = (index: number) => `Variable ${index + 1} name`;
export const variableValue = (index: number) => `Variable ${index + 1} value`;
export const secretName = (index: number) => `Secret ${index + 1} name`;
export const secretValue = (index: number) => `Secret ${index + 1} value`;
export const removeVariable = (index: number) => `Remove variable ${index + 1}`;
export const removeSecret = (index: number) => `Remove secret ${index + 1}`;
export const RIGGING_NONE = 'No rigging items apply to this project.';
export const projectRigging = (names: string) => `Rigging for this project: ${names}`;
export const EDIT_RIGGING = 'Edit in Settings → Rigging';
export const NIGHTLY_WINDOW = 'Nightly window';
export const NIGHTLY_TIME = 'Time';
export const NIGHTLY_TIMEZONE = 'Time zone';
export const REFILL_ENABLED = 'Refill goals automatically';
export const REFILL_INTERVAL = 'Minutes between refills';
export const ROUTINES_EDIT_HELP = 'Goals, daily items and jobs are edited in the Routines tab.';
export const PROJECT_NOTIFICATIONS = 'Notifications for this project';
export const NOTIFICATION_LEVELS = { everything: ['Everything', 'Also each time a thread finishes a turn'], standard: ['Standard', 'Coordinator replies, questions for you and failures'], 'needs-you': ['Only what needs me', 'Questions for you and failures'], off: ['Off', ''] } as const;
export const NOTIFICATION_DEVICE_HELP = 'Turn on notifications for this device in Settings → Notifications.';
export const USAGE_EMPTY = 'No usage in this range.';
export const USAGE_RANGES = { today: 'Today', '7d': '7 days', '30d': '30 days' } as const;
export const USAGE_TOTALS = { inputTokens: 'Tokens in', outputTokens: 'Tokens out', cacheReadTokens: 'Cache read', cacheWriteTokens: 'Cache written', costUsd: 'Cost' } as const;
export const USAGE_TABLES = { byThread: 'By thread', byModel: 'By model', byAccount: 'By account', byKind: 'By kind' } as const;
export const USAGE_KINDS = { coordinator: 'Coordinator', thread: 'Threads', verification: 'Verification', review: 'Review', memory: 'Memory' } as const;
export const USAGE_COLUMNS = { byThread: 'Thread', byModel: 'Model', byAccount: 'Account', byKind: 'Kind', models: 'Models', turns: 'Turns', tokens: 'Tokens', cost: 'Cost' } as const;
export const usageUnknownCost = (n: number) => `${n} turns without a reported cost`;
export const usageBadge = (tokens: number, cost: number) => `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tokens · $${cost.toFixed(2)}`;
export const PLACEMENT_CONSTRAINTS = 'Project placement constraints';
export const PLACEMENT_REASON = 'Placement reason';
export const ESCALATION_HISTORY = 'Escalation history';
export const SESSION_NOTICES = 'Session notices';
export const RETAINED_SESSION_ACCOUNT = 'Kept the eligible account of the current session.';
export const APPLY_EKOA_SETUP = 'Apply Ekoa Code setup';
export const deviceLimit = (name: string) => `Limit on ${name}`;
export const deviceDefaultLimit = (limit: number) => `Default: ${limit}`;
export const FRESH_COORDINATOR = 'Fresh session';
export const MOVE_COORDINATOR = 'Move coordinator here';
/** Move coordinator here while its request runs. */
export const MOVING_COORDINATOR = 'Moving…';
/** Shown after Fresh coordinator session, which changes nothing visible until the next turn (D77). */
export const FRESH_STARTED = 'The next coordinator turn starts a fresh session.';
export const RECONNECTING = 'Reconnecting…';

// 12.2 Sections, their empty lines and the phone view below 840 px
export const WAITING_FOR_YOU = 'Waiting for you';
export const RUNNING = 'Running';
export const PULL_REQUESTS = 'Pull requests';
export const CONCLUDED = 'Concluded';
export const NOTHING_WAITING = 'Nothing waiting.';
export const NO_THREADS_RUNNING = 'No threads running.';
export const NO_OPEN_PULL_REQUESTS = 'No open pull requests.';
export const NOTHING_CONCLUDED = 'Nothing concluded in the last 14 days.';
export const TAB_LABELS = { chat: 'Chat', queue: 'Queue', waiting: 'Waiting', threads: 'Threads', 'pull-requests': 'Pull requests', terminal: 'Terminal' } as const;
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
  checkoutCompleted: (name: string) => sentence(`${name} completed in your checkout`),
  noChanges: (name: string) => sentence(`${name} concluded without changes`),
  testsFailed: (name: string, attempts: number) => `Tests failed ${attempts === 1 ? 'once' : `${attempts} times`} in ${name}`,
  interruptedRestart: (name: string) => sentence(`${name} was interrupted by a restart`),
  interruptedTimeout: (name: string) => sentence(`${name} timed out`),
  interruptedFailed: (name: string) => sentence(`${name} failed`),
  interruptedStopped: (name: string) => sentence(`${name} was stopped`),
  ownerStopped: (name: string) => `You stopped ${name}`,
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
export const CHECKOUT_COMPLETED = 'Completed';
export const MANUAL_MAIN_HELP = 'Main edits your existing project files. Commits and pushes stay with you.';
export const STOP_KEEPS_CHECKOUT = 'Your edits stay in the project checkout. Git is left to you.';
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
export const TASK = 'Brief';
export const PLACEMENT = 'Placement';
export const ISOLATION = 'Isolation';
export const AUTOMATIC = 'Automatic';
export const MODEL = 'Model';
export const EFFORT = 'Effort';
export const DEVICE = 'Device';
export const START_THREAD = 'Add to queue';
export const STARTING = 'Starting…';
/** Placement phase gates (D88), the same sentences placement refuses with (D221). */
export const MAIN_NOT_AVAILABLE = 'Main isolation is not available yet.';
export const REMOTE_NOT_AVAILABLE = 'Threads run only on this device for now.';
/** A device no thread of the project can run on, as its Device option reads (D281). */
export const deviceUnavailable = (name: string, reason: string): string => `${name}: ${reason}`;

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
/** The takeover line's words before the command; the page shows the command itself as code, with its copy button. */
export const takeOverLead = (device: string): string => `Take over in a terminal on ${device}:`;
/** `command` is the thread view's `attachCommand` (`jevellan thread attach {threadId}`), never retyped here. */
export const takeOverLine = (device: string, command: string): string => `${takeOverLead(device)} ${command}`;
export const COPY_COMMAND = 'Copy command';
export const COMMAND_COPIED = 'Command copied.';
/** Neither the clipboard nor the selection copy worked (D304): the command shows whole and selected, with this under it (D305). */
export const COMMAND_SELECTED = 'The browser blocked copying, so the command is selected for you to copy.';
export const FROM_NEXT_TURN = 'From the next turn';
export const RESTART_WITH_CHOICES = 'Restart with these choices';
export const APPLY = 'Apply';
export const JUMP_TO_LATEST = 'Jump to latest';
/** The label of a Jevellan turn prompt in a thread transcript (D56). */
export const PROMPT = 'Prompt';
/** Prompts longer than this collapse in thread transcripts (D56). */
export const PROMPT_COLLAPSE_CHARACTERS = 1200;
export const STOP_THREAD_TITLE = 'Stop this thread?';
export const STOP_THREAD_BODY = 'The current turn ends and the thread takes no more work.';
export const STOP_KEEPS_WORKTREE = 'Its worktree and branch stay until you discard them.';
/** A main thread's stop (D29): its unpublished commits move to a saved ref so the project checkout is a clean main again. */
export const STOP_SAVES_MAIN_COMMITS = 'Commits it has not published are saved under refs/jevellan/discard, and the project checkout returns to main.';
/** Discard of a worktree thread that failed before it had a branch. */
export const DISCARD_NO_BRANCH = 'Remove the worktree?';
export const DISCARD_BODY = 'Uncommitted work and commits that were not pushed are lost.';
/** The toast after Discard; the server appends the same words to the state reason. */
export const WORKTREE_DISCARDED = 'Worktree discarded.';
export const MORE_TURNS_ALLOWED = 'The thread can take 10 more turns.';
/** The composer of a concluded thread; the server refuses messages to it with the same sentence (D81). */
export const THREAD_ENDED = 'This thread has ended. Start a new thread for new work.';
export const THREAD_CONTINUE = 'Continue here. Jev will classify your message and choose how to run the follow-up.';
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

// 12.3 Override modal (D255): what each choice does, the note, and what happens after Apply.
export const OVERRIDE_MODES = 'When the choices apply';
/** Restart of a main thread: there is no worktree; its unpublished commits are saved as on Stop (D29). */
export const OVERRIDE_NOTE = 'Note (optional)';
export const OVERRIDE_NOTE_PLACEHOLDER = 'Why this change? The coordinator and later placements read it.';
export const APPLYING = 'Applying…';
/** An effort the chosen model does not offer runs as its nearest offered effort (the server maps it the same way). */
export const effortRunsAs = (effort: string, runsAs: string): string => `${effort} (runs as ${runsAs})`;
export const OVERRIDE_APPLIED = 'The next turn uses your choices.';
export const THREAD_RESTARTED = 'The thread restarted with your choices.';

// 12.3 Why panel: the placement record (brief 5.8) field by field (D255).
export const WHY_TITLE = 'Why this placement';
export const WHY_PLACEMENT = 'Placement';
export const PLACEMENT_SOURCES = { jev: 'Jev', fixed: 'fixed', fallback: 'without Jev' } as const;
/** How one field was decided: Jev's answer, a fixed field, the only option left, the fallback rule, or a later change by the owner. */
export const FIELD_SOURCES = { jev: 'Jev', fixed: 'fixed', only: 'only option', fallback: 'fallback rule', changed: 'changed by you' } as const;
export const fixedFields = (fields: string): string => `Fixed: ${fields}`;
export const FIXED_NONE = 'Fixed: none';
export const ACCOUNT = 'Account';
export const PROBABILITY = 'probability';
/** After `{requested} → {effective}` when the model does not offer the requested effort. */
export const NEAREST_EFFORT = '(nearest effort this model supports)';
export const CHOSEN = 'chosen';
export const JEV = 'Jev';
export const jevCallLine = (returnedModel: string, tokens: number, latencyMs: number): string => `Placement · ${returnedModel} · ${tokens} tokens · ${latencyMs} ms`;
export const NO_JEV_CALL = 'No Jev call was needed for this placement.';
export const NO_JEV_ANSWER = 'No Jev answer was used for this placement.';
/** Before the decision time, which reads like the project chat's timestamps (`Oct 4, 20:33:12`). */
export const PLACED = 'Placed';

// 12.4 Settings, Git
export const GITHUB_TOKEN = 'GitHub token';
export const savedUpdated = (date: string): string => `Saved · updated ${date}`;
export const NOT_SET = 'Not set';
export const REPLACE = 'Replace';
export const REMOVE = 'Remove';
export const GITHUB_TOKEN_HELP = 'Used only to open, read and merge pull requests for Jevellan threads. A fine-grained token with Pull requests read and write, Contents read and write, Checks read and Commit statuses read on your repositories is enough.';
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

// Live cards and owner-controlled settings changes.
export const LOADING_TASK_CARD = 'Loading task…';
export const PROPOSED_CARD = 'Proposed';
export const QUEUED_CARD = 'Queued';
export const HELD_CARD = 'Held';
export const START_CARD = 'Start';
export const DISMISS_CARD = 'Dismiss';
export const SENT_MESSAGE_CARD = 'Sent a message';
export const DISMISSED_CHAT = 'Dismissed from the chat.';
export const startAllCards = (count: number) => `Start all (${count})`;
export const cardPlacement = (model: string, effort: string, account: string, device: string) => `${model} · ${effort} · ${account} · ${device}`;
export const queueCardPosition = (position: number) => `#${position} in queue`;
export const CARD_CHECKS = { passing: 'Checks pass', failing: 'Checks fail', pending: 'Checks pending', none: 'No checks' } as const;
export const UNDO_SETTING = 'Undo';
export const CHANGED_AGAIN = 'Changed again since.';
export const SETTINGS_CHANGED_EVENT = 'Project settings changed';
export const threadResolved = (title: string) => `Resolved "${title}"`;
export const automaticFixEvent = (number: number, outcome: string) => `Pull request #${number}: automatic fix ${outcome}`;
export const OVERVIEW = 'Overview';
export const ROUTINES = 'Routines';
export const BOARD_LABELS = { waiting: 'Waiting for you', review: 'Ready for review', working: 'Working', landing: 'Landing', landed: 'Landed, waiting for deploy', idle: 'Idle', resolved: 'Resolved' } as const;
export const BOARD_EMPTY = { waiting: 'Nothing needs you.', review: 'No pull requests waiting for review.', working: 'Nothing running.', landing: 'Nothing landing.', landed: 'Nothing waiting for deploy.', idle: 'No idle threads.', resolved: 'Nothing resolved in the last 14 days.' } as const;
export const LANDING_LABELS = { verifying: 'Verifying', merging: 'Merging', held: 'Held for the nightly window' } as const;
export const IN_TERMINAL = 'In a terminal';
export const FIX_CHECKS = 'Fix checks';
export const RESOLVE_CONFLICTS = 'Resolve conflicts';
export const addressComments = (n: number) => `Address comments (${n})`;
export const PUBLISH = 'Publish';
export const PUBLISH_HELP = 'Run the tests, push the branch and open a pull request.';
export const RESOLVE = 'Resolve';
export const REOPEN = 'Reopen';
export const RESOLVE_COMMITS_CONFIRM = 'This thread has commits that are not in a pull request. Resolve it anyway? The branch and worktree stay.';
export const SHOW_OLDER = 'Show older';
export const BASE_BRANCH = 'the base branch';
export const MERGE_HELD = 'Merges are held while the nightly window runs.';
export const PROPOSED_TASKS = 'Proposed tasks';

export const fixTurnLabel = (fix: import('@jevellan/core/client').ThreadFix) => fix.by === 'owner' ? 'Requested by you'
  : fix.kind === 'checks' ? 'Automatic fix: failing checks' : fix.kind === 'conflicts' ? 'Automatic fix: conflicts' : 'Automatic fix: review comments';

export const NOTIFICATIONS_TITLE = 'Notifications';
export const NOTIFICATIONS_ON = 'On for this device.';
export const NOTIFICATIONS_OFF = 'Off for this device.';
export const NOTIFICATIONS_ENABLE = 'Turn on for this device';
export const NOTIFICATIONS_DISABLE = 'Turn off for this device';
export const NOTIFICATIONS_TEST = 'Send a test notification';
export const NOTIFICATIONS_DEVICES = 'Devices with notifications';
export const NOTIFICATIONS_IPHONE = 'On iPhone, add Jevellan to the Home Screen from Safari first, then turn notifications on from the installed app.';
export const NOTIFICATIONS_HTTPS_MISSING = 'Notifications need an HTTPS address. Reinstall with --https to use them.';
export const notificationsHttps = (url: string) => `Notifications need Jevellan's HTTPS address. Open ${url} to turn them on.`;
export const NOTIFICATIONS_UNSUPPORTED = 'This browser does not support push notifications.';
export const NOTIFICATIONS_REFUSED = 'Notifications are blocked for this device. Allow them in the browser settings, then try again.';
export const NOTIFICATIONS_WORKER_WAIT = 'The app is still starting. Reload and try again.';
export const NOTIFICATIONS_KEYS_MISSING = 'This browser did not provide notification keys. Try turning notifications on again.';
export const NOTIFICATIONS_TEST_SENT = 'Test notification queued.';
export const NOTIFICATIONS_EMPTY = 'No devices have notifications turned on.';
export const notificationAdded = (date: string) => `Added ${date}`;
export const notificationBrowserLabel = (agent: string) => `${agent.includes('Edg/') ? 'Edge' : agent.includes('Firefox/') ? 'Firefox' : agent.includes('Chrome/') ? 'Chrome' : agent.includes('Safari/') ? 'Safari' : 'Browser'} on ${/iPhone|iPad/u.test(agent) ? 'iPhone or iPad' : /Mac/u.test(agent) ? 'macOS' : /Windows/u.test(agent) ? 'Windows' : /Linux/u.test(agent) ? 'Linux' : 'this device'}`;

export const LIBRARY = 'Library';
export const ATTACH_FILES = 'Attach files';
export const ATTACHMENT_LIMIT = 'Attach up to 10 files per message.';
export const LIBRARY_TOO_LARGE = 'Files up to 50 MB.';
export const LIBRARY_UPLOAD_FAILED = 'The file could not be uploaded.';
export const removeAttachment = (name: string) => `Remove ${name}`;
export const LIBRARY_UPLOAD = 'Upload';
export const LIBRARY_FILTERS = { all: 'All', owner: 'Uploads', thread: 'From threads' };
export const LIBRARY_OPEN = 'Open';
export const LIBRARY_DOWNLOAD = 'Download';
export const LIBRARY_DELETE = 'Delete';
export const LIBRARY_PREVIOUS = 'Previous image';
export const LIBRARY_NEXT = 'Next image';
export const LIBRARY_FROM_YOU = 'From you';
export const libraryFromThread = (title: string) => `From "${title}"`;
export const openLibraryFile = (name: string) => `Open ${name}`;
export const deleteLibraryFile = (name: string) => `Delete ${name} from the library?`;
export const LIBRARY_EMPTY = 'Nothing in the library yet. Attach files to a message or upload them here.';
export const RIGGING_PROJECTS = 'Projects';
export const RIGGING_ALL_PROJECTS = 'All projects';

export const libraryFileSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;

// Compatible endpoints
export const ENDPOINT = {
  type: 'Compatible endpoint', baseUrl: 'Base URL', placeholder: 'https://api.example.com/anthropic', token: 'Auth token', billing: 'Billing',
  subscription: 'Plan or subscription', metered: 'Pay per use', free: 'Free (local)', paid: 'When Jevellan may use it',
  help: "Any server that speaks the Anthropic Messages API: Z.ai's GLM endpoint, DeepSeek, or a local server or proxy in front of a local model.",
  models: 'Models', modelId: 'Model id', label: 'Label', efforts: 'Efforts', description: 'When to use it (Jev reads this)', addModel: 'Add model', removeModel: 'Remove model',
  background: 'Background model', backgroundHelp: "Used for Claude Code's small background calls. Defaults to the first model.", keyRefused: 'Key refused',
} as const;
export { modelNotServed } from '@jevellan/core/client';

export const SUGGEST_SETUP = 'Suggest setup';
export const SUGGESTED_SETUP = 'Suggested setup';
export const APPLY_SETUP = 'Apply setup';
export const SETUP_NOT_NOW = 'Not now';
export const SETUP_DISMISSED = 'Setup dismissed.';
export const SETUP_FILL_VALUES = 'Fill in their values in Project settings → Environment.';
export const SETUP_LABELS = { testCommand: 'Test command', setupCommand: 'Worktree setup command', instructions: 'Project instructions', copyFiles: 'Copy into new worktrees', variables: 'Variables to fill in', secrets: 'Secrets to fill in' };
export const setupGoalLabel = (value: string) => `Goal: ${value.split('\n')[0]}`;
export const setupApplied = (count: number) => `Setup applied: ${count} changes.`;
export const SETUP_REQUESTED_EVENT = 'Setup recommendations requested';
