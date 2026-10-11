# Goals, tasks and the daily loop

Projects connects a coordinator, coding threads, pull requests and the owner's decisions. Its loop keeps useful work moving between owner messages: goals explain what matters, a visible task queue holds the work, daily items track recurring checks and a nightly window catches up on the day's unfinished daily work.

This document describes the intended complete product. Implementation and live evidence are tracked separately in the roadmap and acceptance report.

## The hub and devices

The MacBook Pro is the hub and primary working device. Supported encrypted hub export and import preserve accounts, the vault, configuration, Rigging, projects, notebooks, history and project work. Export requires a stopped daemon; import validates the manifest and activates atomically with rollback. The destination has its own device identity. Codex subscription authentication is not transferred: imported accounts need sign-in through Settings.

The Mac mini keeps serving its existing apps at their existing URLs, from their original files. It becomes an apps-only member and keeps the former pilot data as a recoverable backup. It cannot run coordinators, threads or jobs, and is never eligible for Ekoa Code. The former hub copy is fenced from starting as authority accidentally.

dev-madrid is a working member with dedicated project clones. Placement considers only allowed, available devices. Device facts include cores, load, memory, free disk and active work. Owner-editable tags describe requirements such as `mac`, `linux`, `residential`, `datacenter` and `browser-automation`. Tasks' required tags are a hard eligibility filter. Devices refuse new work below 20 GB free disk or above a five-minute load of twice their core count. Per-device limits also apply. Settings shows worktree disk use and offers confirmed cleanup of orphaned worktrees older than seven days.

## Sessions and instructions

Claude threads and coordinators run through the Claude Agent SDK; Codex threads run through the Codex SDK. Each uses an isolated account home. The runtime reads the owner's supported native instructions, skills, prompts, agents, commands, styles, plugins, hooks and MCP configuration on its device. A change applies on the next turn, including resumed sessions.

Jevellan retains control of authentication, account and model selection, sandboxing and permissions. Its safety hook runs first and its denials cannot be overridden by native hooks. Native homes are never modified or linked into an isolated home. Native MCP secrets are supplied ephemerally, redacted and excluded from saved configuration, hub documents and evidence. Jevellan's reserved server and hook names take precedence; Settings explains clashes and unsupported items.

Codex receives root `AGENTS.md` as project instructions. If that entry is absent, it receives root `CLAUDE.md`. The selected filename is displayed accurately in the prompt. Existing invalid or unreadable instructions are errors, not permission to select another file. Instruction files must resolve inside the project and satisfy the existing file and size checks. If neither file exists, no root instructions are injected. An internal `AGENTS.md` symlink to `CLAUDE.md` remains supported.

Settings → Runtimes has **Use my own {runtime} setup**, enabled by default, with the included paths and excluded items with reasons. Sessions use short task instructions: report progress, completion, blockers or owner decisions through the bridge; commit with the machine identity; run surgical tests. Jevellan performs publication and project checks.

## Goals

A goal describes a continuing purpose with a name, motivation, health description, autonomy, state and caps. Only the owner creates, changes, pauses, reactivates or completes goals. The coordinator reads them to choose useful work. Goals never finish automatically.

**Propose tasks** puts coordinator refill and finding tasks into Draft for approval. **Queue tasks automatically** puts them into Queued. Paused and done goals produce no refill events, and their queued tasks wait. Defaults are three refills per project day and two open pull requests per goal. A goal admits at most one active session task, and stops admitting further work when its open-pull-request cap is reached.

Refill becomes eligible when an active goal has no draft, queued or active work, is below its pull-request cap and has not reached its daily refill cap. The existing sweep asks an idle, available coordinator at most once per configured interval, default 30 minutes, outside the nightly window. The coordinator reads the motivation, health, notebook, recent work and results, then proposes at most one worthwhile task for each listed goal. It may create nothing.

## One task queue

Every new piece of project work is a task: a session or a deterministic job. A session task has a title, complete brief, type, optional goal, source, state, rank, urgency, dependencies, device needs and optional fixed placement choices. Types are feature, fix, finding, refactor, docs, analysis, review and ops. States are Draft, Queued, Active, In review, Done, Failed and Cancelled.

The owner can add, edit, approve, reject, cancel and reorder tasks, or mark them **Now**. Owner ordering is preserved from coordinator edits. Coordinator-created owner requests must come from an owner message in the current turn; only those may be urgent. Existing queued threads migrate to tasks in their previous order without creating another thread. Active task state follows its current thread, including terminal outcomes and cancellation reasons.

The dispatcher uses the existing five-second sweep on the coordinator's device. It filters paused goals, unmet dependencies, goal caps, device eligibility and the nightly window; then orders Now tasks first, followed by rank and creation time. Dependencies are satisfied by Done or Cancelled predecessors. Asks have no goal and share project limits. Capacity and resource refusals stop the sweep; other start refusals fail the task and notify the coordinator. Jobs do not consume thread capacity, but only one job per project runs at a time.

Threads start through the existing runner and relay. Their task text includes the brief, goal motivation, type and project thread rules. Follow-ups to active work go to its thread rather than creating a duplicate task.

## Review and owner decisions

With coordinator review enabled, a pull request with passing checks or no checks is offered to the coordinator for review. The coordinator reads the diff and either approves the head commit or requests changes from the thread. Approval is invalidated when the head changes. Pull requests show Waiting for the coordinator's review, Reviewed by the coordinator or Changes requested by the coordinator, with the note in details.

The owner may merge before coordinator approval when no nightly hold is active. The coordinator has no merge tool. The implementation run may merge only its own authorized sandbox test pull requests; Ekoa merges belong to the owner.

## Daily items, jobs and project days

A daily item names recurring work, its goal and order, and targets either a job or a session task. **Run now** puts it in the queue. A Done task satisfies that daily item for its project day; failures, timeouts, cancellations and skipped gates do not.

A project day runs from one configured nightly boundary to the next in its time zone, or midnight to midnight when the window is disabled. Work started by a window belongs to the day that window closes, even when it completes after the boundary. This membership is stored so restarts and daylight-saving transitions cannot change the accounting.

Jobs run no models. Command jobs create a fresh private-ref worktree of the selected base commit, run project setup, execute the command with a minimal environment and timeout, and remove the worktree afterwards. The owner's registered checkout remains unchanged. Runs store the exact commit, device, times, conclusion, summary and a redacted log tail limited to 8,000 characters.

GitHub workflow jobs either watch the newest eligible base-branch run or dispatch and follow their own run. Polling is every 60 seconds. A watch with no run before its timeout reports that no workflow started today. Failed-job names and readable failed-step logs explain failures. A workflow whose scheduling gate passed but whose test suite was skipped does not satisfy a test daily.

A gated job runs only on the exact commit where its prerequisite passed during the project day. Without that pass it is skipped with an explanation. GitHub dispatch accepts a branch or tag, so a gated dispatch uses a dedicated ref pinned to that commit and records the dispatched run identity. Deployments and production builds are not introduced into Ekoa's Jevellan loop.

## The nightly window

At the configured boundary, the window opens only when an enabled daily item lacks a Done task in the closing project day. It persists one task per pending daily, placed ahead of normal work in daily order, and holds merges. Existing threads continue working and may publish.

During the window the dispatcher starts only its daily tasks, one at a time. Merge is refused in both the UI and external MCP with `Merges are held while the nightly window runs.` The window finishes when all its tasks end or six hours pass. It releases the hold and publishes one outcome line per daily. A daily already completed through Run now is not repeated. The window, tasks and merge hold recover together after restart.

## Placement and corrections

The coordinator determines the work, its goal, type and needs. Jev selects placement among candidates validated by code. Placement includes the task type, requirements and goal motivation, cut to 600 characters, plus resource facts and tags. Corrections identify the task type; packets carry the newest eight same-type overrides followed by the newest four of other types. Why explains the choices and exclusions and lists the corrections actually shown to Jev. A queued task snapshots context together with its first dispatch brief; resumed turns keep that task identity.

The suggested effort guide defaults to high, uses extra high or the highest supported effort below max for features, architecture and broad changes, uses medium for small fixes and mechanical work, and never selects low for a thread. Models and efforts come from account discovery, including Opus 5.5 and GPT-6.1 Sol when offered by the runtime.

## The interface and Ekoa link

Desktop Projects shows coordinator chat on the left and Waiting for you, Queue, Running, Pull requests, Concluded, Goals and Daily on the right. Phone tabs are Chat, Waiting, Queue, Threads and Pull requests, with Goals and Daily in Queue's menu. Queue supports Order and Goals grouping, drag ordering and long press on phones. Rows show goal, type, state, Now, dependencies, needs and active placement. Drafts appear in both Queue and Waiting for you, counted in the waiting badge.

Goal cards expose motivation, health, state, autonomy, caps and counts. Daily rows expose status, Run now, editing and enablement; jobs are edited there. Settings exposes window time and time zone, refill interval, main isolation, coordinator review and rules for every thread. The project page shows a merge-hold banner and the last window's result.

Settings → Ekoa stores an MCP URL, an encrypted vault token and enablement, with Test connection and required-tool discovery. The mirror is one way: each owner decision, each reviewed ready pull request, and one aggregated proposed-task item per project appears under the Jevellan label. Items link back to Jevellan, update in place and complete when resolved. Durable mappings and retry backoff prevent duplication and never block Projects. Jevellan touches only the items it created. Unsupported token authentication or missing tools are visible blockers.

## Ekoa Code's first loop

Ekoa Code uses dedicated clones, initially on the Pro and later on dev-madrid. Owner development checkouts remain separate. All work uses worktrees with `npm ci` setup, fast repository-derived PR checks, coordinator review and the brief's Ekoa thread rules. Production, deployment, evaluation definitions, token-spending tests and WhatsApp messages are excluded from this run.

The six initial goals preserve the specification's motivations and health descriptions. Hardening through automated tests and Hardening through code review are active; Legal analysis quality, Integrations and automations, API and MCP, and Security are paused. All propose tasks, with caps of three refills and two open pull requests.

Nightly tests watches the existing all-tests workflow with a 300-minute timeout and order 1. Code review is a read-only review of changes merged in the last 24 hours, order 2. The nightly window opens at 02:00 Europe/Lisbon; refill is every 30 minutes. Initial thread limits are eight per project and six on the Pro; after dev-madrid joins they become twelve per project, six on the Pro and eight on dev-madrid. The mini remains excluded.

## Delivery and evidence

The design extends the existing coordinator, runner, queue sweep, publication and mesh. Stored and received documents use versioned Zod schemas. Each implementation phase carries regression tests, browser journeys in desktop and phone, light and dark, automated vision where its dedicated credentials are available, and live checks with explicit evidence labels. Missing credentials block a live check rather than producing a pass. The owner's acceptance is separate from implementation, automated verification and deployment.

Replacing GitHub Actions, deploying Ekoa from Jevellan, automatic production merges, local models, Ekoa-to-Jevellan task intake, push notifications beyond the Ekoa mirror and remote branch cleanup are outside this delivery.

## Daily implementation interfaces

Owner endpoints use `/api/projects/{id}/jobs`, `/job-runs` and `/dailies`, with revisioned edits and idempotent `/run` requests. External MCP uses `jevellan_project_jobs_list`, `jevellan_project_job_create`, `jevellan_project_job_update`, `jevellan_project_job_run`, `jevellan_project_job_runs` and equivalent `project_daily`/`project_dailies_list` operations. Existing conversation job names retain their behavior. Coordinator tools are `jevellan_jobs_list`, `jevellan_job_run`, `jevellan_job_runs` and `jevellan_daily_list`; no definition editing or merge tool is provided.

The daily view contains the current project day, definitions, tasks, receipts, latest window and fresh merge hold. Window receipts additionally persist the closing day and complete task plans. Job receipts persist the run specification, setup command, actual workflow ID, gate receipt and dispatch ref, preserving execution identity across restarts. Optional exact required job/step names make test completion verifiable. GitHub dispatch requests return_run_details under API 2026-03-10; gated dispatch uses a dedicated pinned ref rather than a raw SHA.


Ekoa mirroring is implemented behind owner Settings and a capability-tested token connection. Durable create intents use read-back recovery and ownership markers; missing recovery tools or unsupported authentication remain visible blockers. Implementation evidence is in the acceptance report. Amendment 1 changes the merge items after this checkpoint.
