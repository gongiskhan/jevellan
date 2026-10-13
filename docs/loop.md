<!-- Owner coordinator/memory/terminal brief, 2026-10-12, takes precedence over amendment 2 where it conflicts. Implementation evidence stays separate. -->
# Goals, tasks and the daily loop

Projects connects a coordinator, coding threads, pull requests and the owner's decisions. Its loop keeps useful work moving between owner messages: goals explain what matters, a visible task queue holds the work, nightly items run recurring review and checks before a gated deploy.

This document describes the intended complete product. Implementation and live evidence are tracked separately in the roadmap and acceptance report.

Release 0.2.1 supersedes the prepared 0.2.0 for activation. The installed 0.1.0 remains available for installer rollback. Source and simulated verification do not activate the new hub: hidden migration input, isolated sign-ins, project/Ekoa Settings credentials and live device enrollment remain prerequisite owner actions. The closing activation handoff is in `docs/acceptance/loop-activation.md`.

## Coordinator, memory and terminal extension

The 12 October brief defines release 0.3.0. P0–P6 are pushed, including persistent sessions, questions/GitHub, shared memory, owner commands, terminals and the real-scenario harness. Closing verification and platform delivery are in progress. The phase table in PLAN.md and numbered acceptance decisions distinguish simulated, live and blocked evidence. Amendment 2 activation continues independently; 0.2.1 remains installed on the imported Pro hub until the verified update, with rollback retained.

The coordinator keeps its session across days, including compactions, rather than rotating after 40 turns. All Projects sessions compact at a configurable 70% default, then receive fresh project context without losing their native session. The panel exposes context use, compactions and Fresh session. Open questions share oldest-first numbers across cards and prompts, and the coordinator can record and distribute several answers from one owner chat message. A scoped read-only GitHub tool covers runs, jobs/logs, any repository pull request and recent commits, with a 60-second cache and the existing request budget.

New projects use one hub-hosted memory store shared by Claude and Codex, coordinators, threads and Conversations. Existing projects keep their mode until the owner switches. Durable knowledge belongs in memory; coordinator plans and pending questions belong in its notebook; Project now is computed live. Secret-redacted incremental transcript capture feeds a same-day inbox and nightly consolidation. The dream runs independently of ordered nightly items, protects owner notes, computes its counts from the notes diff, maintains Project brief and offers Undo.

Coding threads have equivalent unattended access on both runtimes: Claude bypassPermissions and Codex danger-full-access with approval never. The safety hook remains and protects other registered checkouts and owner-configured paths. A refused or owner-reserved action is an exact owner command with Copy and Run in Terminal. Execution returns its command, exit status and output to the requesting session automatically.

The owner terminal opens in project checkouts, thread worktrees or a device home, including member devices through the mesh. It supports phone keys and dictation, reconnectable scrollback, shell command records, plain-text copy and Send to… . Coordinator and threads can read project terminals but never type into them. See docs/projects.md and docs/memory.md for the target details. Live A/B/C/D scenarios, source checks and physical owner acceptance remain separate.

## The hub and devices

The MacBook Pro is the hub and primary working device. Supported encrypted hub export and import preserve accounts, the vault, configuration, Rigging, projects, notebooks, history and project work. Export requires a stopped daemon; import validates the manifest and activates atomically with rollback. The destination has its own device identity. Codex subscription authentication is not transferred: imported accounts need sign-in through Settings.

A freshly installed daemon can generate background records, so a running installation does not necessarily remain a fresh import destination. The owner recovery helper retains the entire existing Pro home, prepares only its identity and installation artifacts without starting the daemon, and restores that backup if import fails. The product continues refusing populated destinations. The [2026-10-12 recovery evidence](acceptance/hub-import-recovery-2026-10-12.md) records the completed Mini export, matching archive checksums and pending Pro retry separately.

The Mac mini keeps serving its existing apps at their existing URLs, from their original files. It becomes an apps-only member and keeps the former pilot data as a recoverable backup. It cannot run coordinators, threads or jobs, and is never eligible for Ekoa Code. The former hub copy is fenced from starting as authority accidentally.

dev-madrid is a working member with dedicated project clones. Placement considers only allowed, available devices. Device facts include cores, load, memory, free disk and active work. Owner-editable tags describe requirements such as `mac`, `linux`, `residential`, `datacenter` and `browser-automation`. Tasks' required tags are a hard eligibility filter. Devices refuse new work below 20 GB free disk or above a five-minute load of twice their core count. Per-device limits also apply. Settings shows worktree disk use and offers confirmed cleanup of orphaned worktrees older than seven days.

Heartbeat facts inform placement; each receiving worker checks fresh local resources before preparation. Fixed devices and owner overrides obey the same hard tags and apps-only exclusions. Settings defaults old documents to no per-device overrides and preserves existing overrides on ordinary settings saves. Placement records retain device facts for Why. Tags are owner-only, persist through heartbeats and cannot change apps-only policy.

Worktree usage counts allocated bytes inside Jevellan's home, without following symlinks. Cleanup confirms an explicit fingerprinted selection older than seven days, then rechecks ownership, process receipts, live process working directories and registered checkouts under the daemon's maintenance lock. It removes only those trees and their own Git registrations. Active work, uncertain process state or a changed tree refuses removal. `lsof` is needed for the live process check; an unavailable check blocks cleanup.

## Sessions and instructions

Claude threads and coordinators run through the Claude Agent SDK; Codex threads run through the Codex SDK. Each uses an isolated account home. The runtime reads the owner's supported native instructions, skills, prompts, agents, commands, styles, plugins, hooks and MCP configuration on its device. A change applies on the next turn, including resumed sessions.

Jevellan retains control of authentication, account and model selection, sandboxing and permissions. Its safety hook runs first and its denials cannot be overridden by native hooks. Native homes are never modified or linked into an isolated home. Native MCP secrets are supplied ephemerally, redacted and excluded from saved configuration, hub documents and evidence. Jevellan's reserved server and hook names take precedence; Settings explains clashes and unsupported items.

Codex receives root `AGENTS.md` as project instructions. If that entry is absent, it receives root `CLAUDE.md`. The selected filename is displayed accurately in the prompt. Existing invalid or unreadable instructions are errors, not permission to select another file. Instruction files must resolve inside the project and satisfy the existing file and size checks. If neither file exists, no root instructions are injected. An internal `AGENTS.md` symlink to `CLAUDE.md` remains supported.

The native terminal takeover uses the same root-file validation on every resume. Its Codex fallback setting names CLAUDE.md, and its initial instruction names the selected file and asks the session to read its current contents before acting; file contents stay out of command arguments. An invalid file refuses launch and hands the thread back. A failed memory capture also hands back, retaining the journal and unadvanced capture cursor for retry.

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

## Merge routing and owner decisions

Amendment 1 replaces per-pull-request coordinator review. The coordinator keeps read-only `jevellan_pr_diff` and has no merge tool. Project Settings offers **Merge automatically after checks**, default off, and risky areas text limited to 2,000 characters. The owner's Merge button remains available, subject to the nightly hold.

Passing checks and no conflicts trigger Jev question set m-v1. Configured requiredChecks must all exist and pass on the current head; without configured names, absent checks count only after a five-minute grace from first observing that head. Its versioned merge-route-state-v1 packet contains task title, type and goal, last summary, changed paths and line counts, total size, risky areas and the newest eight owner correction sentences. Routes are merge, test-then-merge and ask-owner; a failed request or invalid packet falls back to ask-owner. A merge-route-v1 receipt and Why drawer preserve the actual choice and evidence. With automatic merge off, the row says **Jev would: merge / test then merge / ask you** and supports corrections, without merging or starting verification.

Merge squash-merges only the checked head and waits out the hold. Stopped or failed authors and undelivered coordinator messages prevent automatic merging. Test-then-merge uses a fresh worktree of that head, the other provider or an eligible different model on the same provider, effort medium, and exactly one verification report. It checks nearby tests rather than reviewing code. Dirty worktrees, new commits, failed reports or changed heads prevent merging. Only an explicit failed report counts toward the three-failure cap and reaches the original thread for its next turn. Restart, timeout, setup failure or a moved head retries once, then asks the owner with the reason. An author that cannot receive failures asks the owner once, with those failures attached.

Ask-owner creates **Merge #{n} {title}?** with Merge, Send back with a note and Close. Ekoa mirrors this item. The coordinator receives automatic merge, verification and owner-decision events. Owner corrections **Should have asked me** and **Didn't need asking** feed later routing. Thread instructions end: **Don't review your own work beyond normal care. Tests run after you, and a nightly review covers everything that merges.**

Send back delivers the note once and waits for a new head; it does not re-ask about the returned head. Corrections also appear on recently merged pull requests for seven days and on the task page. The gate uses cached results from the existing 60-second PR poll and indexes receipts by thread. Waiting owner decisions, merged/closed PRs and finished threads add no gate refresh requests. Below 20% of a token's GitHub request allowance, polling slows to five minutes and the project shows a notice. The simulated five-PR hour is required to stay below 1,000 requests. Active coordinator-review tools, settings and hub operations are retired; historical versioned review documents remain readable.

## Daily items, jobs and project days

A daily item names recurring work, its goal and order, and targets either a job or a session task. **Run now** puts it in the queue. The UI labels these items Nightly while retaining the daily schema names. A daytime Run now is an extra run and never suppresses the night.

A project day runs from one configured nightly boundary to the next in its time zone, or midnight to midnight when the window is disabled. Work started by a window belongs to the day that window closes, even when it completes after the boundary. This membership is stored so restarts and daylight-saving transitions cannot change the accounting.

Jobs run no models. Command jobs create a fresh private-ref worktree of the selected base commit, run project setup, execute the command with a minimal environment and timeout, and remove the worktree afterwards. The owner's registered checkout remains unchanged. Runs store the exact commit, device, times, conclusion, summary and a redacted log tail limited to 8,000 characters.

GitHub workflow jobs either watch the newest eligible base-branch run or dispatch and follow their own run. Polling is every 60 seconds. A watch with no run before its timeout reports that no workflow started today. Failed-job names and readable failed-step logs explain failures. A workflow whose scheduling gate passed but whose test suite was skipped does not satisfy a test daily.

A gated job runs only on the exact commit where its prerequisite passed during the project day. Without that pass it is skipped with an explanation. A workflow with a commit input dispatches its base branch and carries the passing SHA in that input. A workflow without such an input may use a temporary pinned ref; a gated dispatch without either is refused. The actual returned run identity is recorded. Deploy executes only the exact passing commit through a supported workflow input or repository dispatch. The owner may also authorize a daytime deploy.

## The nightly window

Every configured night opens and runs every enabled item in order, even after successful daytime runs. It persists task plans and its closing project day, serializes its window work and holds other merges. Ordinary queued tasks keep starting under normal placement, limits and resource guards. Threads may continue and publish.

Review since last is a read-only high-effort session using the other provider from the provider responsible for most of the day's changes. Creation and first enable seed the review baseline from current main, preserving an explicitly owner-selected baseline. **Review from commit** lets the owner change it. It reviews commits reaching main since lastReviewedCommit, including direct pushes, writes project-review-report-v1, and advances the watermark to the reviewed head. Git output streams into a file capped at 8 MB with a ten-minute generation timeout. Past the cap, the input contains each commit's message and file stats and directs the session to read remaining patches with git in its private worktree. If even that summary exceeds the cap, the review fails with a reason requesting a smaller owner-selected range. A failed review records its reason and the night carries on. **Last night's review** appears on the project page and reaches the coordinator. The coordinator creates at most one finding fix for the code-review goal, or none.

That fix goes directly into the queue regardless of goal autonomy and still passes the merge gate. Jobs start at the first of: fix merged, no fix chosen, twenty minutes without a coordinator choice after the report, fix waiting for the owner, or the 150-minute cutoff. Once jobs start, unfinished or later fixes continue as ordinary work and merge after the window. Other work stays held. Late windows use their actual opening time for the cutoff and seven-hour deadline and report the delay and observed cause. The window ends when its items finish or seven hours elapse and releases the hold. Its report lists every item's result, failure reason, run link and tested/deployed commit, plus the review summary and fix task/route. Any item failure produces one Ekoa **Jevellan · {project}: night report**. Restart recovery preserves the cutoff, plans, job-phase transition, hold and report identity.

## Placement and corrections

The coordinator determines the work, its goal, type and needs. Jev selects placement among candidates validated by code. Placement includes the task type, requirements and goal motivation, cut to 600 characters, plus resource facts and tags. Corrections identify the task type; packets carry the newest eight same-type overrides followed by the newest four of other types. Why explains the choices and exclusions and lists the corrections actually shown to Jev. A queued task snapshots context together with its first dispatch brief; resumed turns keep that task identity.

The suggested effort guide defaults to high, uses extra high or the highest supported effort below max for features, architecture and broad changes, uses medium for small fixes and mechanical work, and never selects low for a thread. Models and efforts come from account discovery, including Opus 5.5 and GPT-6.1 Sol when offered by the runtime.

## The interface and Ekoa link

Desktop Projects shows coordinator chat on the left and Waiting for you, Queue, Running, Pull requests, Concluded, Goals and Nightly on the right. Phone tabs are Chat, Waiting, Queue, Threads and Pull requests, with Goals and Nightly in Queue's menu. Queue supports Order and Goals grouping, drag ordering and long press on phones. Rows show goal, type, state, Now, dependencies, needs and active placement. Drafts appear in both Queue and Waiting for you, counted in the waiting badge.

Goal cards expose motivation, health, state, autonomy, caps and counts. Nightly rows expose status, Run now, editing and enablement; jobs are edited there. Settings exposes window time and time zone, refill interval, main isolation, automatic merge, risky areas and rules for every thread. The project page shows a merge-hold banner and the last window's result.

Settings → Ekoa stores an MCP URL, an encrypted vault token and enablement, with Test connection and required-tool discovery. The mirror is one way: each owner decision, each ask-owner merge decision, and one aggregated proposed-task item per project appears under the Jevellan label. Items link back to Jevellan, update in place and complete when resolved. Durable mappings and retry backoff prevent duplication and never block Projects. Jevellan touches only the items it created. Unsupported token authentication or missing tools are visible blockers.

## Ekoa Code's first loop

Ekoa Code uses dedicated clones, initially on the Pro and later on dev-madrid. Owner development checkouts remain separate. All work uses worktrees with `npm ci` setup, fast repository-derived PR checks, the merge gate and the brief's Ekoa thread rules. Threads do not touch production, deployment, evaluation definitions, token-spending tests or WhatsApp. Owner-authorized nightly workflow jobs perform the programme, expensive suite and exact-commit deploy.

The six initial goals preserve the specification's motivations and health descriptions. Hardening through automated tests and Hardening through code review are active; Legal analysis quality, Integrations and automations, API and MCP, and Security are paused. All propose tasks, with caps of three refills and two open pull requests.

The activation preset opens the window at 01:00 Europe/Lisbon, refills every 30 minutes, starts with autoMerge off and requires the result check. The owner turns automatic merge on separately. Risky areas are: Tenancy and cross-user data access; the Cofre and credentials; the LLM egress module and the Judge; database migrations and stored data shapes; deploy, CI and infrastructure files; billing; evals/.

Dispatch order is Review since last; Legal programme; Full suite with expensive tests; Deploy gated on Full suite; Security disabled and parked. In watch mode, the existing chain orders Legal, Deploy and Full suite after Review. Ekoa PR 208 preserves the 02:00 Lisbon GitHub chain and adds the reversible NIGHTLY_SCHEDULER switch, exact dispatch inputs and the 07:00 missing-night alert. It always asks the owner. Merging changes nothing while the variable is unset or github. After two clean watch nights, the owner may set jevellan; setting github restores the chain from the next night. The token requires Contents, Pull requests and Actions read/write; Checks, Commit statuses and Variables read.

Initial thread limits remain eight per project and six on the Pro; after dev-madrid joins they become twelve per project, six on the Pro and eight on dev-madrid. The mini remains excluded.

## Delivery and evidence

The design extends the existing coordinator, runner, queue sweep, publication and mesh. Stored and received documents use versioned Zod schemas. Each implementation phase carries regression tests, browser journeys in desktop and phone, light and dark, automated vision where its dedicated credentials are available, and live checks with explicit evidence labels. Missing credentials block a live check rather than producing a pass. The owner's acceptance is separate from implementation, automated verification and deployment.

Local models, Ekoa-to-Jevellan task intake, push notifications beyond the Ekoa mirror and remote branch cleanup are outside this delivery.

## Daily implementation interfaces

Owner endpoints use `/api/projects/{id}/jobs`, `/job-runs` and `/dailies`, with revisioned edits and idempotent `/run` requests. External MCP uses `jevellan_project_jobs_list`, `jevellan_project_job_create`, `jevellan_project_job_update`, `jevellan_project_job_run`, `jevellan_project_job_runs` and equivalent `project_daily`/`project_dailies_list` operations. Existing conversation job names retain their behavior. Coordinator tools are `jevellan_jobs_list`, `jevellan_job_run`, `jevellan_job_runs` and `jevellan_daily_list`; no definition editing or merge tool is provided.

The daily view contains the current project day, definitions, tasks, receipts, latest window and fresh merge hold. Window receipts additionally persist the closing day and complete task plans. Job receipts persist the run specification, setup command, actual workflow ID, gate receipt and dispatch ref, preserving execution identity across restarts. Optional exact required job/step names make test completion verifiable. GitHub dispatch requests return_run_details under API 2026-03-10. Commit-input dispatches bind the exact SHA in the run-name and required successful jobs/steps, allowing main to move. Optional pinned refs are deleted at completion and aged refs are cleaned at window open. New ref names carry their creation time; legacy refs use their durable run receipt. A legacy orphan with neither source of age is left alone rather than guessing its age from an unrelated commit date.


Ekoa mirroring is implemented behind owner Settings and a capability-tested token connection. Durable create intents use read-back recovery and ownership markers; missing recovery tools or unsupported authentication remain visible blockers. Implementation evidence is in the acceptance report. Amendment 1 replaces reviewed pull requests with ask-owner merge items and adds failed night reports.

Amendment A2 implementation checkpoint: opt-in merge routing, verification, owner decisions and ask-owner Ekoa mirrors are implemented. The changed four-layout journeys and backend/API regressions pass, with 16 live vision checks and no blocking findings. Actual owner-account merges remain blocked on setup. Amendment A3/A4 are implemented as recorded below; this specification is not an activation or owner-acceptance claim.

Amendment A3 is implemented. Review reports and their commit watermark share a durable task receipt; ordered review sequences handle equal timestamps. Every enabled Nightly definition runs independently of daytime success and coding-goal refill eligibility. LJ5/LJ6 passed eight four-layout journeys, including a fix before cutoff, a fix continuing after cutoff, and a failed suite that skips deploy and mirrors one night report. All 24 live vision judgments have zero blockers. Backend/storage/runtime checks passed 197 cases, plus 17 publication/client regressions. See acceptance decision 653 for provider attribution and first-review choices; actual provider and GitHub runs still await owner setup.


Ekoa Code setup is an owner action in Project settings, using an account-discovered Claude Opus 5.5 entry with high effort. It installs the exact six goals and five Nightly definitions once, with a durable setup receipt and stable create IDs. Later owner edits are preserved. Register the dedicated clone, require a project token in Settings → Projects and save that token in Settings → Git before work starts. Fast checks are `npm run build --workspace shared && npm run typecheck && npm run lint`; they avoid production and expensive test runs.

[Ekoa workflow handoff #208](https://github.com/gongiskhan/ekoa-code/pull/208) retains the weekly measurement schedule and adds exact-commit dispatch inputs. Each window reads NIGHTLY_SCHEDULER through the Actions variables API once. jevellan selects dispatch; any other value or a failed read selects watch with a recorded reason. Watch order is Legal → Deploy → Full suite; dispatch order is Legal → Full suite → Deploy. Run now takes its own variable snapshot. No PR merge probe controls this choice, and Jevellan never sets the variable. Ekoa uses main with a sha input for tests/deploy and mode=night, dry_run=false for Legal without sha. Deploy carries the same-window passing Full suite SHA. No Ekoa pinned refs or runner-hook reinstall is used. Watch binds to scheduled Legal titles ending " night", then workflow_run descendants after the recorded parent completion, excluding manual, repository_dispatch and "(not in the chain)" runs. Nightly displays "GitHub runs the chain tonight" or "Jevellan runs the night". PR 208 remains an owner merge item.


The earlier 0.2.0 checkpoint covered all 268 unique browser cases across a full run and targeted reruns in desktop/phone and light/dark, including packed installation, update, rollback and removal. Its 494 live vision verdicts were clear and its complete backend run passed 1,861 cases across 168 files. That evidence belongs to the earlier source. Amendment 2 carries new regression and closing checks for 0.2.1, recorded separately in REPORT. The retained 0.1.0 rollback and remaining owner steps are described in [the activation handoff](acceptance/loop-activation.md); migration/sign-in/Settings inputs continue to block live activation.


Native MCP delivery preserves Jevellan's role permissions. Read-only sessions and basic verification receive only their scoped Jevellan bridge; imported native servers are withheld because their external write effects cannot be confined by the repository sandbox. Ordinary write threads retain supported native stdio/HTTP/SSE transports. Native instructions, settings and skills continue to apply in protected roles. Acceptance decision 658 records the closing review finding and regression coverage.


Codex native stdio bridges forward their generated secret-reference variable through the per-server environment allow list. The configuration and arguments contain the reference name only; credential values remain ephemeral in the worker environment. Protected roles continue to withhold imported servers.


Automatic merge routing waits for running, preparing, publishing and attached turns, and checks that state again after verification. A passed verification is retained while publication settles; a new head goes through the gate again. Acceptance decision 659 records the concurrency regressions.


## Amendment 2 — authoritative follow-up

The untracked BRIEF-loop-amendment-2.md in Downloads wins over conflicting earlier design. Decisions 661–690 record its thirty changes. The current specification above incorporates its replaced sections; dated checkpoint evidence retains its source context. Release 0.2.1 replaces the staged 0.2.0 as the activation target. The owner alone enables Ekoa automatic merging and switches the scheduler after PR merge and two clean watch nights.

Live follow-up on 2026-10-12: the owner completed the corrected Pro import, and the published 0.2.1 Mac archive is running under the Pro user service with healthy HTTPS. The full original Pro home is retained; update preservation fingerprints/counts match. The private sandbox fixture passes local checks and its GitHub result job. A separate clean main clone at `/Users/ggomes/jevellan-projects/ekoa-code-runtime` is ready for Ekoa runtime work, leaving the PR 208 author clone separate. PR 208 is refreshed at 187ed029 after main advanced to 3bf0e8e5; all 26 nightly regressions and the CI lane pass. No deploy.yml or installed runner-hook change is introduced. Next inputs are owner UI sign-in/account refresh and scoped Settings credentials, followed by authenticated project binding, joins and the authorized live journeys. Full loop activation, retained Mini URLs, migration rollback and owner acceptance remain unverified. [Live evidence](acceptance/pro-hub-021-live-2026-10-12.md) and [the ordered handoff](acceptance/loop-activation.md) replace earlier pending-import status without repeating completed work.

Amendment 2 Part 1 is pushed as Ekoa 30dffb6c on PR 208. The workflow change is a reversible scheduler switch: main’s GitHub chain is preserved until the owner changes the repository variable. Ekoa dispatch uses main and SHA inputs, with no runner-hook reinstall. Twenty-six simulated nightly regressions and the Ekoa CI lane pass; actual switching/alerts/watch nights remain blocked.

Part 2 is pushed at f916302 and Part 3 at f11b6cd. Part 3's complete affected run passes 214 cases, its final baseline rerun 21 overlapping cases, and its four-layout browsers 20/20 with 68 clear live vision verdicts. Part 4 ships the Ekoa preset in shadow mode with result required. Settings → Devices shows read-only hub power readiness from the AC sleep configuration, refreshed within a minute, and a warning with the owner command when needed. The Pro's observed AC sleep is 0. The [fourteen-day hosted-minute report](acceptance/github-hosted-minutes-2026-10-12.md) records usage by workflow, job and runner without changing CI. Version metadata is 0.2.1. All 272 unique browser cases have passing coverage through the full run and targeted reruns, with 488 clear live vision verdicts and retained images. The final complete backend passes 1,902 cases in 171 files, with no failures/skips. The first final review corrected a serious stale-risk-policy race across verification; the permitted second found no additional serious issue. Current risky areas are checked again before automatic merge. Platform archive inspection and secret scans gate publication; owner-dependent live activation stays blocked.

## P1 session implementation checkpoint (2026-10-12)

Coordinator sessions now continue beyond forty turns, including after a daemon restart. Model/runtime/effort/account changes, missing native sessions, device moves and Fresh session retain their existing fresh-session rules. Project settings accept compactAtPercent from 50 to 90, default 70, preserving migrated v1/v2 fields and omitted owner settings. Claude uses the per-turn CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Codex uses the discovered model context window and model_auto_compact_token_limit; an unknown window uses the native default and shows a notice. All Projects session kinds receive the setting.

Runtime context and compaction events are separate from billed usage. Versioned ledger receipts preserve reported counts and explicitly mark unavailable counts as null. Coordinator and thread compactions keep the native session and refresh the next task/context prompt. Review, verification and future memory sessions record receipts in the project coordinator ledger. The panel shows context percentage when known, today's compactions, last compaction and Fresh session; the saved threshold is beside coordinator settings. Native account configuration remains unchanged. Shared recall and Project now remain P3 work.

Simulated evidence: 107 focused backend cases pass, covering persistence, restart, compaction, migration, production/test bounds, isolated journal/model reads and byte-identical fixture native homes. Browser/vision verification and real scenario C are recorded separately in acceptance/coordinator-memory-terminal.md; owner inputs still block live provider acceptance.

## P2: numbered answers and GitHub awareness

Open questions use one oldest-first order (created time, then id) in cards, fresh coordinator context and resumed event blocks. Ask/answer tool receipts include the current numbered list, so questions created in the turn have the same numbers the owner sees. Chat answers are allowed only during a turn consuming an owner message, record source owner-chat and quote that turn's owner words. A batch preserves every message rather than attributing an answer to only the last follow-up. Retries complete one answer and its existing Ekoa mirror once. The coordinator distributes each answer explicitly; it gets no redundant decision-answer event. Panel answers retain their normal path. Owner CI-log messages are bounded at 200,000 characters to support the specified compaction scenario.

The read-only jevellan_github tool exposes repository runs, jobs and bounded log tails, pull requests from all authors, changed files/checks and recent commits with merged-pull associations. It resolves the checkout's raw origin and uses the existing project token and request budget. A 60-second per-request cache coalesces concurrent calls, excludes errors and separates token rotations; scope and current head are checked even on cache hits. Threads can read only their own pull request and runs/logs at its current head. Results are versioned, secret-redacted and bounded. Log downloads retain a streaming tail with a 64 MB transfer ceiling and timeout; the returned tail is at most 8,000 characters.

Simulated: 135 relevant backend cases in ten files and six workflow cases pass, with a focused final rerun for batched chat provenance, large owner messages and shared rate accounting. CM2 passes four layouts; the retained eight dedicated live vision judgments have no blocking findings. Typecheck/lint/build pass. Actual GitHub bridge calls through owner Settings remain blocked on the pending token, and no real provider scenario or owner acceptance is claimed. Shared capture/recall was next in P3.

## P3: shared hub memory

Hub mode uses one Basic Memory process per project on the hub and a private notes Git repository with local commits only. New projects default to hub; existing projects switch explicitly, importing copies once and retaining the old folder. Member sessions use the existing authenticated mesh. Coordinator and thread writes carry code-supplied provenance; owner notes remain protected. Review and verification sessions read only. Conversations share the hub store.

End-of-turn and native hook capture coalesce complete, secret-redacted transcript byte ranges, including large records split into retryable fragments. Low-effort extraction uses Projects placement/launch services on the hub, at least 4 KB waiting and at most every 30 minutes plus window open. Inbox notes retain the learning runtime/model and reach recall before consolidation. Fresh and post-compaction prompts re-read Project brief and relevant notes; every thread turn computes Project now from current indexes. Why shows recalled references.

The high-effort dream runs independently of ordered Nightly items in a read-only main worktree. A private notes copy combines inbox, memory care candidates, main changes, review and notebook. Nonconflicting concurrent notes are retained; conflicts preserve current notes. One applicable local commit supplies the diff/counts and supports Undo. Suggest only waits for owner Apply. Run now receipts survive restart, and late dream completion updates the night report. The Ekoa preset's memory upgrade preserves earlier owner settings. Detailed tests and evidence are in acceptance/coordinator-memory-terminal.md; live provider scenarios remain blocked on owner inputs.


## P4 owner-command and permission checkpoint

Codex coding threads now use danger-full-access with approval never, including resumed turns; Claude retains bypassPermissions. Read-only capability is checked separately, so a Linux sandbox failure does not exclude coding or change authentication. Each worktree turn loads registered device checkout paths and its protected paths anew. Both hooks guard git/file targets through symlinks, and denials explain ownerCommands. Device Settings edits at most 20 absolute folders through the existing mesh; the Madrid Ekoa binding includes the owner's own checkout.

Reports and owner questions preserve up to five full commands with reason, folder and device. Cards and shell fenced blocks share Copy and Run in Terminal controls. P5 implements execution and automatic result delivery using the existing durable message paths. Simulated P4 coverage is 141 passing cases with a focused protection rerun; browser/vision verification is recorded in the phase acceptance file. The live Madrid session is blocked on pending owner inputs.

## P5 terminal checkpoint

The owner terminal extends the device daemon, authenticated owner API and mesh. Real PTYs retain two-megabyte reconnectable scrollback independently of browser connections, with eight sessions per device and a twelve-hour idle close. Ticketed websocket relay carries input/output, resize and heartbeat. Projects, Devices and threads expose the appropriate folder/device launchers. The pinned xterm phone client provides dictation input, sticky keys, selectable output, copy actions and Send to…; only the owner can type.

Temporary shell integration preserves dotfiles and owner hooks, recording commands and their exit status. Bash loads normal login profiles through an interactive rcfile because its login mode ignores that option. Old Readline paste support is detected; multiline actions keep one final result. Unsupported shells and inner SSH boundaries are labelled approximate. Owner-command receipts persist on cards, and redacted completion reaches the requesting session once, with unknown/interrupted status stated explicitly. Takeover retains scoped read tools and capture until detach. Detailed evidence is in acceptance/coordinator-memory-terminal.md; real Pro/Madrid/phone scenarios remain blocked on the already requested owner inputs.


## Scenario harness and evidence

The A/B/C/D harness is scripts/live/scenarios.mjs. It checks structured owner state and the redacted ledger before checking reply keywords. Turn starts record assembled prompts and explicit clipping; turn ends record reported usage and hashed native continuity. Review, verification and memory usage share the same project ledger. The owner-only thread events endpoint routes to the thread's device and reuses authentication, cursor replay and stream guards.

Scenario resets stop earlier sandbox work and create a fresh logical project while retaining the earlier receipts; B never resets. Receipt files carry live, blocked, simulated or not run labels, timed assertions, sanitized excerpts, routes, run/PR/note identifiers and usage uncertainty. The ten-hour clock starts only with an eligible real scenario and survives harness restarts. Installed production refuses accelerated acceptance thresholds. See acceptance/scenarios/README.md for the private configuration and run commands.


Closing shell integration: Jevellan PTYs disable competing WezTerm semantic hooks in their own environment, preserving the owner's startup files. The daemon records its own command boundaries and actual exit codes on Madrid Bash as well as Pro shells. Decision 747 and its failing-before/passing-after regression are recorded in acceptance/REPORT.md. Real owner-device scenarios remain blocked on the previously requested inputs.


0.3.0 closing source gates pass: 2,020 backend tests in 182 files, all 292 unique browser cases through the complete matrix and affected reruns, 582 clear dedicated vision verdicts, typecheck/lint/build and both platform candidates. The single closing review and permitted second are finished. Source-bound publication and cold full-home Pro activation follow; real scenarios and member enrollment remain blocked, with no live clock or owner acceptance. See acceptance/release-030.md and the ordered activation handoff.
