# Projects

Projects is the area of Jevellan where one coordinator per project plans the work and threads carry it out. The owner talks with the coordinator; the coordinator splits requests into threads, routes follow-ups to the thread already doing that work, keeps a project notebook and brings back only the questions that need the owner. Each thread is a full Claude Code or Codex session that carries one task end to end, on any device and eligible account, in its own worktree or directly on main.

Projects sits next to the existing conversations, which keep working exactly as before. It reuses their pieces: the runtime adapters, isolated account homes and account ranking, Jev, the scoped bridge, project memory, the device mesh and the native transcript readers. The specification is `BRIEF-projects.md` (local and untracked, like `BRIEF.md`); where the build chose differently, the choice is a numbered decision in the [acceptance report](acceptance/REPORT.md).

The 0.3.0 coordinator/memory/terminal source phases are pushed; current Pro activation is healthy on corrective 0.3.3, with both members on 0.3.2. Closing tests, packaged installation and blocked real-provider acceptance have separate evidence in [the extension report](acceptance/coordinator-memory-terminal.md), [the live Pro checkpoint](acceptance/pro-hub-030-live-2026-10-13.md) and [the ordered handoff](acceptance/loop-activation.md). Native Codex takeover revalidates root AGENTS.md/CLAUDE.md on each resume; capture outages never keep a thread attached after handback.

The browser-driven activation found an imported conversation replay issue that also blocks checkout registration in Project Settings. The 0.3.1 repair uses the existing ledger's versioned ownership control, tied to the matching import source and destination. It preserves requests, work, timestamps and historical entries. This is a recovery repair; Projects placement and Mini exclusions stay in force. [Evidence and remaining activation](acceptance/hub-history-rebinding-2026-10-13.md) are separate from real-provider acceptance.

Prior live-scenario preparation (decisions 782–783): the harness now supports explicit project-only credentials across fresh logical sandbox resets through the existing owner API, with no default-token save. Real GitHub preflight access passes after correcting the repository root's trailing slash. Twenty-one affected backend cases, typecheck/lint/build pass. Dedicated test entries are available on Madrid; their validity is not inferred. The requested Sol menu choice is currently disabled and accelerated B/C need an uninstalled real-provider profile. Formal A–D and the subsequent cache/journal clocks remain unstarted. See docs/acceptance/prior-scenarios-preparation-2026-10-13.md.

Prior live-scenario readiness, decisions 784–786: 7.7 GB of owned reproducible build material is removed after process/digest checks, retaining all cold backups, installed versions, final 0.3.3 artifacts, failed candidates and evidence. Pro now passes the unchanged disk guard. Fresh uninstalled Pro/Madrid profiles run the actual existing releases with real Claude/Codex Ready on both, protected owner paths and project-only GitHub scope; production stays unchanged. Normal A/B compaction remains 70%, with the test-only thirty-minute nightly cutoff. The catalog lacks Sol 6.1: Claude gating only requires a normal eligible Codex thread model, while the specified non-gating Sol coordinator remains blocked. This preflight correction fails before its regression fix; all 22 affected cases/typecheck/lint pass. Final Claude preflight has no gaps; formal execution follows. No cache/journal code or new build/live clock has started.

First real A1 failed under the unchanged assertion: the old coordinator system rule serializes independent worktree tasks solely for a shared changelog. Decision 787 replaces that blanket rule with real-result dependencies and parallel independent worktrees, preserving shared-Main sequencing. Thirty-two affected backend cases/build/typecheck/lint pass. The failed receipt is retained; only the owned test Pro runtime receives a verified development guidance overlay, with immutable releases/production unchanged. Rerun A from the start within the original 04:15:59 UTC deadline on 14 October. New cache/journal build/live clocks remain unstarted.

## Queued cache and journal extension

The owner's 13 October brief is planned after the existing real A–D scenarios finish. No cache checkpoint or journal behavior is delivered by this intake. The ledger remains the source of truth. The requested hub journal is a code-built folder of thread, day and night Markdown files plus INDEX.md, mirrored read-only to members and read with ordinary file tools. Cache measurement uses existing usage events; it introduces no keep-warm traffic. Warm and small cold sessions keep their native session; enabled large cold coordinator/thread sessions restart from notebook/open state/index or task/thread journal, preserving pending delivery and earlier transcripts. Reviews, verification and memory sessions are measured but do not restart. Checkpoints default off until L2/L3 pass; memory, dream, Conversations and merge gate are outside this extension. See PLAN.md and docs/acceptance/cache-journal-2026-10-13.md for the unmet prerequisite, clocks and owner-approved 0.3.4 target.

## Concepts

| Term | Meaning |
| --- | --- |
| Project work | The Projects state of one registered project: its work settings, coordinator, threads, decision items, notebook, mail, reservations and placement overrides. |
| Coordinator | A long-lived, read-only runtime session per project. It talks with the owner, starts and messages threads, keeps the notebook and asks the owner questions. It never edits code and cannot merge. |
| Thread | One task carried end to end by a full runtime session with write permissions, from its first turn to a pull request, a publication to main, or a stop. |
| Turn | One worker run of a coordinator or thread session. The next turn resumes the same native session; nothing stays running between turns. |
| Isolation | Where a thread works: `worktree` (its own git worktree and branch, ending in a pull request) or `main` (the device's project checkout, publishing to main). |
| Placement | The choice of isolation, model (and so runtime), effort and device for a new thread. Jev makes it with question set p-v1; code chooses the account. |
| Report | What a thread says at the end of every turn through `jevellan_thread_report`: `progress`, `done`, `needs-decision` or `blocked`, with a summary, an optional question and options, tests run and changed files. |
| Decision item | A question for the owner, shown under **Waiting for you**. Normally only the coordinator creates one (`jevellan_ask_user`). |
| Notebook | The coordinator's durable memory on the hub: the owner's standing instructions, decisions, the current plan and open questions. The owner can read and edit it from the project page. |
| Mail | Messages between main-isolation threads and the coordinator, stored on the hub. |
| Reservation | An advisory claim by a main-isolation thread on repository paths it is about to change. |

Responsibilities are split three ways, and there is no heuristic routing anywhere:

- The coordinator decides what work exists: splitting, routing a message to an existing or new thread, what to tell threads and when to ask the owner.
- Jev decides each new thread's placement: isolation, model, effort and device. See [decisions](decisions.md#placement-p-v1).
- Code decides the account with the existing `rankAccounts` rule and enforces every resource limit, permission and guard.

Agents never push and never open pull requests. Jevellan verifies, pushes and opens the pull request after a thread reports `done`. The owner merges, from the Pull requests list or on GitHub.

## The coordinator

The coordinator is assigned to the device that receives the project's first coordinator message or first owner-created thread. Its runtime, model and effort are a project setting, not a Jev decision: Project settings choose a menu model or `Automatic: first available` (the first enabled menu entry whose runtime has an eligible account on the coordinator's device), and an effort mapped to that model. The account is the first eligible entry from `rankAccounts` on that device.

Everything the coordinator learns arrives as an event: an owner message, a thread report, a publication, a verification failure, an interruption, an answered question, a pull request change, mail, an owner message sent directly to a thread, or a placement override. Events are written to the owner-local queue in `coordinator.json` before they are acknowledged. When the coordinator is idle and lives on this device, a turn starts within a second. It runs one turn at a time; events that arrive during a turn wait and are delivered together in the next one, and the loop continues until the queue is empty.

Each turn is a read-only runtime turn in the project checkout of the coordinator's device, with a 20-minute timeout. Its prompts, kept verbatim in `packages/projects/src/copy.ts`, are:

- A system append that tells the coordinator it does not write code, delegates every task to threads with a complete task description, routes follow-ups to the thread already doing that work, sequences threads that would change the same files, leaves placement to Jevellan unless the owner asked for a specific choice, decides what follows from the owner's instructions, the notebook or the code, asks the owner only when the decision is theirs, and keeps the notebook current.
- For a fresh session, a context block first: the notebook, the active threads (state, isolation, runtime, model, effort, device, pull request and last report), the open questions and the recent exchange with the owner (at most 8,000 characters).
- Then the event block: `Events since your last turn:` and one line per event, such as `[owner 14:05] ...`, `[thread "Fix login" (thread_...) reported done] ...` or `[owner answered] "Which database?" → Postgres`.

The coordinator no longer rotates at 40 turns. A fresh native session is needed only when model, runtime, effort or account changes, the account becomes ineligible, the session is missing, the coordinator moves devices or the owner presses **Fresh session**. Compaction retains the session and refreshes the next prompt. Ordinary later turns resume the session with the event block; the first turn after compaction adds fresh notebook, thread, question and memory context. The final assistant text of a turn becomes one chat reply, and each tool call one compact chat line.

The coordinator's bridge tools are `jevellan_threads_list`, `jevellan_thread_start`, `jevellan_thread_message` (optionally interrupting the running turn), `jevellan_thread_read` (the last reports and optionally the last 8,000 characters of assistant text), `jevellan_thread_stop`, `jevellan_ask_user`, `jevellan_withdraw_question`, `jevellan_notebook_read`, `jevellan_notebook_write` (revision-checked, at most 64 KiB), `jevellan_pr_status`, `jevellan_mail_send` and the read-only `memory_search` and `memory_read`. A tool error is a short sentence the model can act on, for example a refused start with its reasons.

A failed turn keeps its events at the front of the queue and is retried once after 30 seconds. After two failures in a row the coordinator rests idle, the chat says `The coordinator failed twice: {error}. Send a message to try again.`, and the owner-question fallback below stays active until a turn succeeds. Without a model or an eligible account on its device the coordinator is `Unavailable` with the reason. **Stop** interrupts the running turn; undelivered events stay queued.

### Questions for the owner

Thread reports always go to the coordinator, and normally only the coordinator asks the owner. When the coordinator cannot run (no model or eligible account, two failed turns in a row, or its device has left the mesh, is revoked or has been silent for 10 minutes), a thread's `needs-decision` report becomes a decision item directly, and the answer goes to that thread as an owner message. The coordinator later reads the report with a note that the owner was asked directly, so the owner is never asked twice. A thread that reaches its turn limit also asks directly, with the options `Allow 10 more turns` and `Stop the thread`. Answering a thread's own question shows `Sent to "{title}".` instead of `Sent to the coordinator.` (decision 448).

## Threads

A thread starts from `jevellan_thread_start` or from **New thread** on the project page. An owner-created thread follows the same path, and the coordinator learns of it as `[owner started thread "{title}" ({id})] ...`. Fields given explicitly (isolation, model, effort, device) are fixed and placement leaves them alone. Every start runs on the coordinator's device: limits are checked, the thread is placed, and it is prepared on the chosen device, locally or through the [relay](#across-devices).

Thread states:

| State | Meaning |
| --- | --- |
| `queued` | Placed while a running limit is reached; started first in, first out when a slot frees. |
| `preparing` | Creating the worktree and running the setup command, or claiming and preparing the main checkout. |
| `running` | A turn is running. |
| `idle` | At rest after a `progress` or `blocked` report, a restart, a failed step or a publication that could not finish; a message starts the next turn. |
| `publishing` | Committing leftovers, verifying, pushing and opening or updating the pull request, or publishing to main. |
| `in-review` | The pull request is open; Jevellan follows its checks and mergeability. |
| `waiting-for-you` | After a `needs-decision` report or at the turn limit, until a message or an answer arrives. |
| `attached` | Taken over in a terminal with `jevellan thread attach`. |
| `done` | Merged, published to main or concluded without changes. |
| `stopped` | Stopped by the owner or the coordinator, restarted with other choices, or its pull request was closed. |
| `failed` | Preparation failed, for example the setup command or a main checkout with foreign changes; the thread has ended. |

Each turn gets a bridge token valid only while that turn runs, starts through the runtime's `startTurn` with the stored native session when there is one, and feeds usage and rate limits into account accounting as conversation steps do. The thread prompts, also in `copy.ts`, give the workspace and its isolation, require the agent to do the whole task and run the relevant tests, commit with the machine's git identity and no attribution, never push or open pull requests, ask through a `needs-decision` report with 2 to 4 options, and end every turn with exactly one `jevellan_thread_report`. The first turn's prompt is `Task: {title}` and the task; later turns send the queued messages, each prefixed with `From the coordinator:` or `From the owner:` when there are several.

Every thread has `jevellan_thread_report` and the read-only `memory_search` and `memory_read` for the project's repository memory on its device. Threads add memory notes as files in their own changes, so a worktree thread's notes are published through its pull request. Main threads also get the mail and reservation tools.

At the end of a turn:

- A report is stored and shown as a report card on the thread page. A second, different report in the same turn is refused; an identical one is accepted as a retry (decision 255).
- A turn that completes without a report gets a synthesized `progress` report from the end of its final message, and a failed or timed-out turn a synthesized `blocked` report with the error; the coordinator reads that Jevellan wrote it.
- `progress` and `blocked` leave the thread `idle` and deliver queued messages as the next turn, else send the report to the coordinator. `needs-decision` leaves it `waiting-for-you`. `done` starts publication.

Owner messages on the thread page go to the thread exactly like coordinator messages, and the coordinator receives a copy. **Interrupt current turn** (or `interrupt: true` from the coordinator) interrupts the running turn and starts the next one with the message. **Stop** terminates the turn's process group and releases reservations and checkout ownership; the worktree and branch stay until **Discard** removes them. Stop, Restart and Discard wait while the thread is attached in a terminal (see [terminal takeover](#terminal-takeover)). **Override** and **Why** are described under placement.

## Placement

Code first computes the candidates: online devices with a path for the project that the project allows, below their running limit, and for main isolation a free checkout on main; and enabled menu models whose runtime can run threads and has an eligible account on at least one candidate device. Excluded models and devices keep their reasons. Jev then answers placement Call A (isolation when both are allowed, model, effort) and placement Call B (device when more than one qualifies), each sent only when it has questions, with a redacted `placement-state-v2` packet. The most probable option wins, the effort is mapped to the model's supported efforts and the account is the best-ranked eligible one on the chosen device. When the running limits leave no candidate, the thread is placed ignoring them and queued.

Placement never waits for the owner. When Jev fails (no key, authentication, timeout, an unusable answer or a packet too large), a deterministic fallback places the thread: the project's default isolation when allowed (else `worktree`), the first eligible menu model, `medium` effort mapped, and the coordinator's device when it can run the model, else the device with the fewest running threads. The record says `fallback` with the error, and the thread page shows `Placed without Jev: {reason}`. With no candidate at all the start is refused with every reason, for example `No device can run any enabled model: Mac mini: Codex needs login.`

**Why** on the thread page shows the saved placement record: source, fixed fields, each question's probabilities, the mapped effort, eligible and excluded models and devices with reasons, the account and the Jev calls. **Override** corrects it afterwards:

- *From the next turn* changes the model (same runtime only) and the effort of the next launch.
- *Restart with these choices* changes any field. It is allowed when the thread has no open pull request and has not published to main. It stops the thread, removes its worktree and starts a new thread with the same title and task, linked as `Restarted as {newId}.`

Each override is stored on the hub, summarized to the coordinator and given to later placements as a sentence such as `effort changed from medium to high for 'Fix login' (next-turn)`. The question set, packet and resolution are documented in [decisions](decisions.md#placement-p-v1).

## Isolation

### Worktree

Worktree isolation is the default for every project and is allowed under both Git policies, because it never touches the owner's checkout working tree. Preparation runs in the project checkout of the thread's device:

- The base branch is `origin/HEAD` without the `origin/` prefix, else `main`. The base is fetched into a private ref, `refs/jevellan/threads/{threadId}/base`, without rewriting the repository's remote-tracking refs or tags (decisions 250 and 346). A project without a remote starts from its local base branch, and its branch stays local.
- The worktree is created at `<JEVELLAN_HOME>/worktrees/{projectId}/{threadId}` on a new branch `jv/{slug of the title}-{last 6 characters of the thread id}`, and the base commit is recorded.
- The project's setup command, when set (for example `npm ci`), runs in the new worktree before the first turn, with a 15-minute timeout. A failure ends the thread `failed` with `Worktree setup failed: {first line}`.

Repository memory notes and instruction files are present because they are in git; the project's instruction-link rules apply read-only, and nothing is written to the owner's checkout. A merged or closed pull request, **Discard**, and `done` without changes remove the worktree with `git worktree remove --force` and delete the local branch. Remote branches are never deleted.

### Main

Main isolation is offered under both Git policies. With Leave git to me it edits the registered checkout, including untracked files, while the owner keeps commits, branches and pushes. Jev receives the policy and the distinction between the existing checkout and a worktree containing committed files when choosing isolation. Placement puts a main thread only on a device whose checkout is on main by its latest heartbeat and is free: no held checkout claim (a conversation or another main thread) and no main thread of the project there that has not ended. At most one main thread works in a device checkout at a time; parallel main work goes to different devices and coordinates through mail and reservations.

Preparation claims the checkout through the same checkout ownership conversations use, so a conversation on it is refused with `{project} on {device} is in use by "{thread}".` until the thread publishes, concludes or stops. Under Work on main, preparation brings the checkout to clean, current main; foreign changes fail preparation, and Stop saves unpublished commits at `refs/jevellan/discard/{threadId}/1` before returning the checkout to main. Under Leave git to me, preparation reads HEAD without cleaning, staging or fetching. Existing staged and untracked files remain available. Stop and Restart preserve the files and git state and release the claim once the native process has ended, including when the owner has changed branches.

The claimed checkout is still the owner's. The following automatic settlement behavior applies to Work on main; a thread started with Leave git to me, or whose current project policy leaves git to the owner, only releases its claim without changing git. While the owner has it on a branch of their own (an unfinished rebase onto main counts as main), nothing of the thread runs or writes there: its next turn waits with `This project must be on main before Jevellan can change git. This thread continues once the checkout is back on main.` (its messages stay queued and the sweeps start the turn once main is back), a `done` report publishes nothing and commits none of the files there, and Stop ends the thread but keeps the claim without committing, aborting or resetting anything, as it does while another agent is active in the checkout. Such a Stop remembers where local main was (and, with another agent active on main, the files in the checkout). Once the checkout is back on main and free, the Stop finishes only if main is still there and the checkout holds nothing new: no uncommitted files, or exactly the files it saw. Otherwise the owner has worked there since, so the claim is given back with nothing committed, saved or reset, and the ledger says `The checkout changed after the Stop, so Jevellan gave it back as it is: nothing was committed, saved or reset, and any of the thread's commits still on main stay there.` Until the owner publishes or removes those commits and files, a later main thread or conversation on that checkout asks them to commit, stash or publish them first.

When a main thread ends but its claim cannot be settled at that moment (the hub cannot be reached for the release, the agent left the checkout on another branch, or the end of the thread's process could not be confirmed), the claim stays with the thread and its ledger says why once. Every sweep, every five seconds on the thread's device, settles it again: a recorded process must be confirmed gone first, a release takes the claim for the current daemon first, and a stop settlement waits while the checkout is off main or another agent works in it, and after such a wait changes git only while the checkout is as the Stop saw it (above), so nothing is committed or reset under the owner repairing it. Meanwhile the thread page shows `The project checkout stays held by this thread: {reason} Jevellan tries again until it is released.`; once released the ledger says `The project checkout was given back.`, and a stop that saved commits names the ref in its reason.

## Mail and reservations

Main threads get four extra tools. `jevellan_reserve` reserves repository files, or directories ending in `/`, for up to 120 minutes (60 by default). Two paths overlap when they are equal or one is a directory prefix of the other; there is no glob matching and paths are compared as given. A conflicting request is answered with each holder's title, overlapping paths and expiry. `jevellan_release` ends a reservation; publishing or stopping releases the thread's reservations. Reservations are advisory: they inform agents and placement, they do not block file writes.

`jevellan_mail_send` sends to another thread, to `all` or to `coordinator`, whose mail arrives as a coordinator event. `jevellan_mail_inbox` returns unread mail addressed to the thread or to `all` and marks it read. The coordinator can mail main threads too. Mail and reservations live on the hub; mail older than 14 days is deleted once every recipient has read it or ended, and reservations released or expired more than a day ago are deleted.

## Pull requests and publication

After a `done` report a worktree thread is published:

1. Leftover changes are committed as `{title}: {first line of the summary, cut to 72 characters}` with the machine's git identity and no trailers. No commits since the base: the thread is `done` with `Concluded without changes.`
2. Jevellan runs the project's test command in the worktree with `/bin/sh -c`, a 30-minute timeout and redacted output. A failure sends the thread the verification-failure prompt (attempt n of 3); the third failure leaves it `idle` with `Tests failed three times.` and tells the coordinator. A project without a test command records that the tests were not run.
3. The branch is pushed with the device's Git settings, with `--force-with-lease` against the last pushed commit after the first push. Without a remote the thread rests with `This project has no remote; the branch stays local.`
4. With a GitHub remote and a GitHub token, Jevellan finds the open pull request for the branch or creates one against the base branch. Its body is the last report's summary, the test result, the thread title and the placement, with no links to Jevellan and no attribution. Without a token the thread rests with `Branch pushed. Add a GitHub token in Settings → Git to open pull requests.`, and with another host with `The remote is not on GitHub.`; the Pull requests list then shows the branch and that reason.

An `in-review` thread's device polls GitHub every 60 seconds, and on demand through `POST /api/projects/:id/threads/:tid/pr/refresh` and `jevellan_pr_status`; polling covers every local thread whose pull request is open, whatever its state (decision 299). Checks are failing when any check run concluded failure, cancelled, timed out or action required, or any status is failure or error; pending when any is queued or in progress; none when there are none; else passing. The coordinator hears of transitions only: checks failing or passing once per head commit, conflicts, merged and closed. A merged pull request ends the thread `done`; a closed one `stopped`; both remove the worktree.

**Merge** in the Pull requests list asks for confirmation (`Squash and merge #{n}?`), then squash-merges at the current head commit. It is disabled with a reason on conflicts or failing checks and allowed while checks are pending. GitHub's error text is shown when it refuses. The coordinator has no merge tool.

### The GitHub token

Settings → Git has a **GitHub token** card. The token is stored in the encrypted hub vault as secret `github`; browsers and `GET`/`PUT /hub/secrets/github` only see a summary (`Saved · updated {date}` or `Not set`), and members fetch it through an authenticated hub operation. It is used only to open, read and merge pull requests for threads. A fine-grained token with Pull requests read and write, Contents read and write (the merge needs it), Checks read and Commit statuses read on the project repositories is enough (REPORT decision 579). Pushes use git and the device's own Git settings, not this token.

`GitHubClient` (`packages/core/src/github.ts`) calls the REST API with `fetch`: bearer authentication, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, no redirects followed and a 15-second timeout. Owner and repository come from `https://github.com/{owner}/{repo}` and `git@github.com:{owner}/{repo}` remotes. The token is never logged or returned. There is no GitHub SDK dependency and `gh` is not required.

### Main publication

With Leave git to me, a main thread's `done` report runs the project's configured verification without requiring a clean checkout or a remote. It verifies HEAD stayed unchanged, ends as Completed in the project checkout, and releases the claim and reservations. It does not stage, commit, fetch, rebase, push or open a pull request. The captured manual policy stays manual if project settings later change; a current manual policy also prevents automatic settlement of an older thread.

With Work on main, a main thread's `done` report commits leftovers in the owned checkout and runs the same three-attempt verification. Under the publication lease of the checkout's remote, Jevellan fetches main and rebases onto `origin/main`. A conflict aborts the rebase and sends the thread the main-conflict prompt naming the conflicting files; a rebase that brought upstream commits is verified again; then `HEAD` is pushed to main. A busy lease is tried again three times, 20 seconds apart. Success ends the thread `done` with the published commit, releases the checkout and the reservations and tells the coordinator `Published to main as {short sha}.` Stop pressed during a publication ends it before the push, also while the lease is awaited and without a test command. Messages that waited during a publication that concluded the thread are named in a thread notice, `The thread concluded before these messages reached it: ...`, and leave the queue.

## Terminal takeover

`jevellan thread attach {threadId}` hands a thread at rest to the owner's terminal, on the device that owns the thread; elsewhere it prints `This thread runs on {device}. Run the command there.` and exits 1. The command authenticates to the local daemon with the installation control file, as `jevellan doctor` does, at `POST /api/local/threads/:tid/attach`. The daemon refuses a working thread (`The thread is working. Wait for the turn to end or stop it.`), an ended or already attached thread and a thread without a native session. Otherwise the thread becomes `attached`, and the daemon returns the working directory, runtime, native session, model, effort and an environment of only the account home and authentication variables.

The command starts the selected native CLI in the thread's isolated account home, preserving the model and effort. Launch settings retain transcripts, apply the project's compaction threshold and safety hook, and expose the scoped memory, GitHub and terminal-read bridge. Codex retains approval never and full access for coding; Claude retains bypassPermissions. Bridge credentials travel only in the environment. On exit, including after Ctrl-C or a forwarded SIGTERM or SIGHUP, it calls `POST /api/local/threads/:tid/detach`. The daemon captures and adopts the newest native session in that account home whose directory is the thread's and that changed after the attach began (covering CLIs that fork the session on resume), expires the takeover grant, sets the thread `idle`, tells the coordinator `[owner worked on thread "{title}" in a terminal]` and starts the next turn from the messages that waited. When Jevellan cannot be reached at exit, `jevellan thread detach {threadId}` hands the thread back later.

While a thread is attached, the owner's messages wait and the coordinator's are refused. Stop, Restart, Discard and a turn-limit **Stop the thread** answer are refused too, for the owner and the coordinator's `jevellan_thread_stop` alike, with `This thread is attached in a terminal: exit that terminal session first, or run jevellan thread detach {threadId}.`, before anything changes (the question stays open); the thread page shows Stop and the Restart choice disabled with that sentence. The thread's account is held for turns on its device, read from the attached state itself, so a restart keeps the hold and detach (also `jevellan thread detach` after a terminal that ended without it) releases it. Another thread whose model has another eligible account there runs on it in a fresh session; otherwise its turn waits at rest with `Waiting for account {label}, which is in use in a terminal. This thread continues when the terminal session ends.`, keeping its messages or the turn it was about to take, and starts after detach. A coordinator in that position is `Unavailable` with `Account {label} is in use in a terminal. The coordinator continues when the terminal session ends.`, without counting a failed turn. Conversations do not take part in this hold. The thread page shows `Take over in a terminal on {device}: jevellan thread attach {threadId}` with a copy button under the composer of every thread that has not concluded. CLI takeover and the owner browser terminal are both available; the terminal actions are described below.

## Limits

| Limit | Value |
| --- | --- |
| Running threads per project (`maxRunningThreads`) | 6 by default, 1 to 20 |
| Running threads per project per device (`maxRunningPerDevice`) | 4 by default, 1 to 10 |
| Turns per thread (`threadTurnCap`) | 30 by default, 5 to 200; **Allow 10 more turns** adds 10 |
| Coordinator turn timeout | 20 minutes |
| Thread turn timeout | 6 hours |
| Worktree setup command | 15 minutes |
| Test command | 30 minutes, three attempts per publication |
| Coordinator session | Persists until explicit change or missing session |
| Pull request polling | every 60 seconds |
| Notebook | 64 KiB |
| Task and messages | 20,000 characters; title 120 |
| Reservations | 60 minutes by default, at most 120; 1 to 50 paths |
| Concluded threads and answered questions in lists | the last 14 days |

Running limits count live work only: threads `preparing`, `running` or `publishing`, plus starts still being dispatched (decision 244). Idle, waiting, attached, in-review and queued threads hold no slot, so threads nobody stopped never block new work. Queued threads are dispatched first in, first out by the coordinator device's sweep. Project work settings live on the hub and are edited in **Project settings** with a revision check.

## Restart behavior

A daemon restart never resumes a model. Threads that were `running`, `preparing` or `publishing` become `idle` with `Jevellan restarted during this step.`, and the coordinator receives a `thread-interrupted` event; its prompt tells it to resume them with a message when the work is still wanted. A running coordinator turn is dropped; its undelivered events stay queued and the next turn starts normally, also after two failed turns when the owner's message that tries again was waiting or running. Attached threads stay `attached`. Preparation is idempotent, so a thread interrupted while preparing reuses its registered worktree.

## Across devices

Placement can choose any online device that has the project. Thread starts, the coordinator's commands (messages, stops, dispatches, answered questions, overrides) and thread events travel through the hub relay: the sending device keeps a durable outbox under `<home>/projects/{projectId}/outbox/`, puts each message on the hub in order and retries after 10, 20, 40 and then every 60 seconds; the target polls, deduplicates by id and acknowledges. Thread events therefore reach the coordinator in order and once each, also after a hub outage. The specification's two background peer routes do not exist because the relay carries that traffic (decision 488).

Browser requests for a thread run on the thread's device and coordinator requests on the coordinator's device; other devices forward them with the owner's session. Lists and project pages read the hub from any device; transcripts are read and pull requests polled on the thread's device. **Move coordinator here** moves the coordinator to the device the owner is using when its current device has been away for 10 minutes or its coordinator is idle, and this device can run it. The new device starts a fresh session from the hub notebook and indexes; the former device stops any turn, forwards the events it still holds and drops its coordinator state at its next start or assignment check. See [device mesh](mesh.md#projects-across-devices) for routes, ordering and the move rules.

## Where state lives

Owner-local files under `<JEVELLAN_HOME>/projects/{projectId}/`: `coordinator.json` (state and event queue), the coordinator ledger (`ledger/`), `outbox/`, start receipts under `requests/`, and per thread `threads/{threadId}/thread.json` and its lifecycle ledger. Sidecars `coordinator-local.json` and `thread-local.json` keep process identity, the last pushed commit and notification memory. `<JEVELLAN_HOME>/projects/inbox-seen.json` records processed relay messages, and worktrees live under `<JEVELLAN_HOME>/worktrees/`. Native session identifiers stay in these owner-local files and never appear in hub indexes, API responses, evidence or commits.

The hub keeps what every device needs: work settings, coordinator assignment and status, slim thread indexes, decision items, notebooks, placement overrides, mail, reservations and relay envelopes. The coordinator chat is served from its ledger as a resumable SSE stream (`event: project`). A thread's transcript is read from its native session file in its account home, not copied into the ledger.

## Interface

The sidebar has a **Projects** section under **New conversation**, with each project's waiting count and running count. The project page holds the coordinator chat, the coordinator's state and session, **Waiting for you**, **Running**, **Pull requests** and **Concluded**, with **New thread**, **Notebook** and a menu for **Project settings**, **Fresh coordinator session** and **Move coordinator here**. Wide pages show the chat and the lists in two columns; narrower pages and phones use the Chat, Waiting, Threads and Pull requests tabs. The thread page shows the native transcript with report cards, the placement line, Why, Override, Stop, Discard, Allow 10 more turns, a composer with **Interrupt current turn** and the takeover line.

## Recorded deviations from the specification

- Chat event records are written when an event is received, not when a turn delivers it (decision 238).
- Running limits count live work only (decision 244).
- Worktree bases are fetched into a private ref (decision 250, refined by decision 346).
- An identical second report in one turn is accepted as a retry (decision 255).
- Pull request polling covers every local thread whose pull request is open (decision 299).
- Answering a thread's own question says `Sent to "{title}".` (decision 448).
- The relay replaces the two background peer routes (decision 488).
- The attach command adds `--settings '{"cleanupPeriodDays":36500}'` to `claude --resume`, so the CLI's 30-day transcript retention never deletes a thread's session (decision 564).

## Evidence and what is simulated

Projects journeys PJ1 to PJ7 pass with simulated evidence; see [PJ1](acceptance/PJ1.md), [PJ2](acceptance/PJ2.md), [PJ3](acceptance/PJ3.md), [PJ4](acceptance/PJ4.md), [PJ5](acceptance/PJ5.md), [PJ6](acceptance/PJ6.md) and [PJ7](acceptance/PJ7.md).

- **Real:** the daemons and their HTTP routes, SSE and bridge, the hub's SQLite store and relay, checkout ownership and publication leases, Git with local bare origins, worktrees, process groups and signals, the attach command as a process, and the browser.
- **Simulated:** coordinator and thread turns (FakeRuntime scripted turns that call the real bridge, and simulated provider CLIs on PATH for attach), Jev's placement answers (a scripted transport), GitHub (a local fake server behind a GitHub-shaped remote) and the second device (a member daemon on the same machine).
- **Live:** the automated vision checks of the 104 Projects screenshots (PJ3, PJ4b, PJ5 and PJ7 in four layouts), run on 2026-10-06 on dev-madrid, the machine with the dedicated Claude test token, at commit `49106b7` and again at the final commit `6647f91` with the whole browser matrix except installation (356 of 356 screenshots): all ok, 0 blocking findings ([vision records](acceptance/vision/)).
- **Not run:** live Claude and Codex turns, live Jev placement, a real pull request on GitHub and a second physical device.

The live journey [PJ-live](acceptance/PJ-live.md) (`node scripts/spikes/live-journeys.mjs --journey PJ-live`) runs the coordinator, a thread, a real pull request and its merge on a real Codex account, real Jev and a disposable GitHub repository. Without its credentials it writes a blocked receipt and starts nothing, so it is blocked, not passed. The deployment state and the current status of every check are recorded in the [acceptance report](acceptance/REPORT.md). The owner's acceptance is not claimed.

The task queue supplies typed placement context. Corrections prefer the same task type, and Why shows the exact redacted sentences used for that placement. Context remains stable through dispatch recovery and explicit thread restarts.


Settings → Ekoa connects the owner account using its MCP URL and bearer token, kept in the hub vault. Connection testing lists capabilities. Jevellan-created tasks have durable mappings and ownership markers; retrying a lost reply recovers the existing task, never blindly creates another. Decisions and draft aggregates link back to their project.


Ekoa Code has an owner-only setup action in Project settings. Register its dedicated clone with project-scoped GitHub authentication and the documented fast checks, then select the account-discovered Opus 5.5/high entry. A durable receipt installs the exact goals and Nightly definitions once. The workflow handoff PR remains an owner decision even if m-v1 selects merge. See loop.md and acceptance decision 654.

## Coordinator, memory and owner terminal (0.3.0)

P0 records the 12 October brief; subsequent implementation and evidence are in PLAN.md. The coordinator gains no shell or code-edit tools. All Projects sessions use compactAtPercent (50–90, default 70), with runtime threshold support, session-compacted receipts and a refreshed context after compaction. The coordinator panel shows context, last compaction, today's count and Fresh session.

Waiting for you cards and coordinator prompts share one oldest-first numbered list. The coordinator can use jevellan_answer_question only in an owner-message turn, recording owner-chat source and the quoted owner message without echoing a decision-answer event. Panel answers keep the existing event path. It lists every open question when asking or answering status, and distributes each chat answer to its own thread. jevellan_github exposes cached bounded repository reads; threads can read only their own PR and the workflow runs/logs on its head.

Hub memory permits coordinator/thread writes, code-supplied metadata and local note commits; other modes keep existing guards. Read-only review/verification sessions cannot write. Shared recall and Project now reach both providers. Capture, extraction, inbox and independent nightly dream are implemented in P3 and described in docs/memory.md. Member calls relay to the hub's one Basic Memory process, and offline recall states the hub is unavailable. First and post-compaction turns re-read Project brief/relevant notes; Why records their references. Every turn computes Project now from current active and merged indexes. The Memory panel exposes capture, dream mode, inbox, actual changes, owner Apply and Undo. Dreams use separate notes copies, preserve concurrent knowledge and do not delay ordered jobs or merge release. Real provider acceptance is still blocked on owner activation inputs.

Codex coding threads use danger-full-access and approval never, retaining the safety hook and new guards for other project checkouts and protected paths. Owner-required actions are up to five exact ownerCommands on a report/question, with command, reason, device and folder, Copy and Run in Terminal. Shell-language fenced blocks have the same controls. Running opens a terminal once and automatically sends completion/output to the requester; no assumed success.

Terminal opens from the project tab, Devices, Open terminal here and Take over in browser. It runs the daemon user's login shell without changing dotfiles, through node-pty and the existing mesh. Owner-authenticated, one-time session-bound websocket tickets expire after 60 seconds. Eight sessions per device retain 2 MB reconnectable scrollback, close on shell exit/owner close/12-hour inactivity, and support resize/heartbeat. Agents receive read-only terminal list, commands and tail tools, never input access.

The pinned xterm client follows the theme and remembers font size safely. At 600 px or less it fills the screen with sticky Ctrl/Alt and special keys, a Type or dictate a command line, Run, straight-input switch and font controls. Temporary zsh/bash integration sources the owner's existing files and emits OSC 133/7. Unsupported shells and nested SSH mark boundaries approximate. Copy all, Copy last command, Copy last 5 commands and Send to… remove escape codes. Send to… starts the selected coordinator/thread turn. Completion of owner commands returns the exit status and last 8,000 characters automatically, with an idle fallback for unknown status.

Real acceptance is the requested A→B working day/night, C compaction and D terminal matrix in the private sandbox, using real providers, Jev, GitHub and the activated hub. It is blocked on pending owner inputs; its ten-hour clock has not started. Automated vision and physical phone acceptance are separate claims.

## P1 session implementation checkpoint (2026-10-12)

Coordinator sessions now continue beyond forty turns, including after a daemon restart. Model/runtime/effort/account changes, missing native sessions, device moves and Fresh session retain their existing fresh-session rules. Project settings accept compactAtPercent from 50 to 90, default 70, preserving migrated v1/v2 fields and omitted owner settings. Claude uses the per-turn CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Codex uses the discovered model context window and model_auto_compact_token_limit; an unknown window uses the native default and shows a notice. All Projects session kinds receive the setting.

Runtime context and compaction events are separate from billed usage. Versioned ledger receipts preserve reported counts and explicitly mark unavailable counts as null. Coordinator and thread compactions keep the native session and refresh the next task/context prompt. Review, verification and future memory sessions record receipts in the project coordinator ledger. The panel shows context percentage when known, today's compactions, last compaction and Fresh session; the saved threshold is beside coordinator settings. Native account configuration remains unchanged. Shared recall and Project now remain P3 work.

Simulated evidence: 107 focused backend cases pass, covering persistence, restart, compaction, migration, production/test bounds, isolated journal/model reads and byte-identical fixture native homes. Browser/vision verification and real scenario C are recorded separately in acceptance/coordinator-memory-terminal.md; owner inputs still block live provider acceptance.

## P2: numbered answers and GitHub awareness

Open questions use one oldest-first order (created time, then id) in cards, fresh coordinator context and resumed event blocks. Ask/answer tool receipts include the current numbered list, so questions created in the turn have the same numbers the owner sees. Chat answers are allowed only during a turn consuming an owner message, record source owner-chat and quote that turn's owner words. A batch preserves every message rather than attributing an answer to only the last follow-up. Retries complete one answer and its existing Ekoa mirror once. The coordinator distributes each answer explicitly; it gets no redundant decision-answer event. Panel answers retain their normal path. Owner CI-log messages are bounded at 200,000 characters to support the specified compaction scenario.

The read-only jevellan_github tool exposes repository runs, jobs and bounded log tails, pull requests from all authors, changed files/checks and recent commits with merged-pull associations. It resolves the checkout's raw origin and uses the existing project token and request budget. A 60-second per-request cache coalesces concurrent calls, excludes errors and separates token rotations; scope and current head are checked even on cache hits. Threads can read only their own pull request and runs/logs at its current head. Results are versioned, secret-redacted and bounded. Log downloads retain a streaming tail with a 64 MB transfer ceiling and timeout; the returned tail is at most 8,000 characters.

Simulated: 135 relevant backend cases in ten files and six workflow cases pass, with a focused final rerun for batched chat provenance, large owner messages and shared rate accounting. CM2 passes four layouts; the retained eight dedicated live vision judgments have no blocking findings. Typecheck/lint/build pass. Actual GitHub bridge calls through owner Settings remain blocked on the pending token, and no real provider scenario or owner acceptance is claimed. Shared capture/recall remains P3 work.


## P4 permissions and owner commands

Projects coding threads have unattended write permission on either provider: Claude bypassPermissions, Codex danger-full-access with approval never. Worktree turns refresh the registered checkout/protected-path guard even when resumed. Device Settings stores at most 20 absolute protected folders; native file tools/patches and recognized shell/git targets share the symlink-aware guard. Ekoa's dedicated Madrid binding adds the owner's /home/ggomes/dev/ekoa-code checkout. Main isolation and unrelated Conversations keep their existing controls.

Thread reports and questions accept up to five ownerCommands. Each shows the exact command, why, device and folder, with Copy and Run in Terminal. Shell-language fenced blocks use the same buttons in coordinator replies, reports and transcripts. Long text scrolls inside its command box; it never widens the page. P4 delivers these controls; P5 connects them to the owner terminal and a once-only result message. The coordinator keeps its read-only role.

## P5 owner terminals

Project Terminal opens in its checkout on the coordinator's device. Device and folder pickers also offer another device, home or a thread's worktree. Devices exposes home terminals; threads expose Open terminal here and Take over in browser. Open terminal lists persist across navigation. A shell exits only on its own exit, owner close or twelve hours without activity; browser disconnects do not end it. Eight terminals per device retain a two-megabyte scrollback buffer.

The owner API issues a sixty-second one-use ticket bound to the terminal and the existing owner session. The websocket relays over the current authenticated device connection, including resize and heartbeat. The xterm client uses pinned fit, links and Unicode addons, theme colours and a browser-local font setting. The phone controls provide sticky Ctrl/Alt, special keys, font size, Paste and a Type or dictate a command field. Long press opens selectable plain output. Copy all, Copy last command, Copy last 5 commands and Send to… strip terminal escape codes; sending starts the chosen project session's next turn.

Temporary startup files source the owner's shell files without changing them. Zsh uses a login shell. Bash ignores rcfile for login shells, so its interactive rcfile explicitly loads the normal login profiles before adding semantic hooks. Unsupported shells and inner SSH commands have approximate boundaries. OSC command records retain folder, timing, output and exit status. Older bash without bracketed paste receives multiline owner actions as one visible compound command, retaining their final status.

Run in Terminal preserves a durable receipt on its report or question and opens the selected device/folder once per request. Exact completion returns the exit code and last eight thousand characters to the requester using the existing durable message path. Unknown boundaries use ten seconds of output inactivity; quiet commands with exact boundaries keep waiting. An interrupted daemon records an unknown result with its reason. Agents receive only scoped list, command and tail reads; they cannot type into owner terminals. Secrets are redacted before output enters agent context or memory.


## Scenario evidence

The owner API exposes each thread's existing ledger at GET /api/projects/:projectId/threads/:threadId/events with the same authenticated SSE/cursor behavior as coordinator events. It follows device routing, validates project ownership and removes native identities. Prompt/tool records are bounded and show whether they were clipped. Runtime-reported outcome usage and hashed continuity support diagnosis without committing native session IDs. Auxiliary review/verification/memory outcomes use the coordinator ledger; unknown cost is preserved.

The four real scenario flows and their unchanged assertions live in scripts/live. Missing owner sign-ins, joins or scoped Settings inputs stay blocked. Simulated fixture checks and desktop/phone browser layouts remain separate from real provider work and physical-phone acceptance.


Closing shell integration: Jevellan PTYs disable competing WezTerm semantic hooks in their own environment, preserving the owner's startup files. The daemon records its own command boundaries and actual exit codes on Madrid Bash as well as Pro shells. Decision 747 and its failing-before/passing-after regression are recorded in acceptance/REPORT.md. Real owner-device scenarios remain blocked on the previously requested inputs.


0.3.0 is published from closing source 7ceadbf3 and healthy on the Pro's existing user service and HTTPS address. Source gates pass: 2,020 backend tests in 182 files, all 292 unique browser cases through the complete matrix and affected reruns, 582 clear dedicated vision verdicts, typecheck/lint/build and both final platform archives. The six local thread files remain byte-identical; their hub indexes retain existing fields and add report-derived changed paths with one revision/timestamp refresh. A complete cold 0.2.1 restore is retained. The single closing review and permitted second are finished. The Linux asset is staged, but insufficient Madrid disk space, member enrollment and pending owner inputs block real scenarios; no live clock or owner acceptance has started. See acceptance/pro-hub-030-live-2026-10-13.md and the ordered activation handoff.


Live activation checkpoint: the owner delegated browser driving, and the protected hub login is awaiting the existing passphrase/1Password unlock. Both member packages are verified/unpacked with actual 0.3.0 CLI checks. Confirmed abandoned installation builds reclaimed another 7.6 GiB on Madrid, whose Ekoa disk guard still fails. The Mini pilot/apps/fence remain retained; original URL acceptance is pending its apps-only service/join. Current diagnostics require account freshness and Jev model discovery in Settings. No real scenario clock, owner acceptance, source change or additional review started. See acceptance/computer-activation-2026-10-13.md and decisions 752–753.


Live follow-up, 13 October: 0.3.1 is published and healthy on the Pro. Twelve histories and retained account/vault/project data pass preservation, with full cold rollback retained. The separate live sandbox uses hub memory and the requested gate/coordinator configuration; its Pro terminal/copy preflight passes. Fresh Pro/Madrid space is above the unchanged guards. Ekoa binding is held by preserved legacy work pending an owner decision; protected sign-ins, member-access confirmation and scoped credentials remain pending. Formal scenarios and phone acceptance have not started. See [release evidence](acceptance/release-031.md).


Live activation follow-up: the Pro Codex account is signed in as goncalo@ekoa.io and labelled Ekoa Codex, with Ready status and its 90% ceiling retained. GitHub browser confirmation is complete. The Pro sandbox Git check passes using the machine connection preference in Jevellan, without changing native Git configuration. The owner approved the prepared repo + workflow grant. The classic token expires 12 November 2026 and is saved only in the sandbox and Ekoa project vault entries; the default remains unset. Live PR, Checks, commit-status, Actions runs/jobs and Variables access pass using each saved entry. Member access, retained Ekoa work, Ekoa MCP credentials and real scenarios remain pending. Decisions 763–765 and acceptance/pro-codex-auth-2026-10-13.md record the checkpoint.


Decision 766: the real invoices/customers sandbox is published at 61fc71abcf86d4cd14a127bb47ff473fddece17b with sandbox-baseline; loop-pilot-baseline retains the original pilot. Only the sandbox NIGHTLY_SCHEDULER is set to jevellan. Its original Vitest 5 pin requires Node 22 and fails the new actual Node 20 install/run regression before the fix. Pin Vitest 4.1.11; ten affected harness/regression cases pass, including real engine-strict npm installation and generated-app execution on Node 20. The actual app passes lint, three unit tests and eight page cases in phone/desktop light/dark layouts. Dedicated vision credentials are unavailable, so those eight vision checks are blocked. The installed Pro daemon stays 0.3.1; the corrected harness runs from current main. No formal scenario/clock or new review started.


Decision 767 supersedes decision 764's pending grant: the owner approved the prepared thirty-day classic repo + workflow token, and ordinary GitHub UI generation and Jevellan Settings storage complete. Both project entries pass live PR, Checks, commit-status, Actions runs/jobs and Variables reads; the shared default remains unset. Ekoa PR208 remains open with result passing, and its scheduler variable remains unset/watch mode. No Ekoa merge, workflow dispatch, member enrollment or formal scenario starts. Remaining blockers and the unchanged scenario clock are recorded in acceptance/github-scoped-activation-2026-10-13.md.


Decisions 768–769: the owner authorizes Madrid project work and Mini apps-only membership. The Mini is online on 0.3.1 at its retained 9444 HTTPS address, with both original 9600/9601 app URLs returning 200 and all fifty app files byte-identical. The pilot home/fence remain intact. Madrid uses a fresh /home/ggomes/.jevellan-member because the earlier .jevellan directory contains Cursor data; that directory stays untouched. Madrid joins, but its initial user service rejects the old quoted WorkingDirectory. The native regression fails on both ordinary and special-character paths before the fix, then 33 service/file cases pass on Linux. Accept only the exact known legacy unit for repair, retaining changed-file and live-service guards. Prepare corrective 0.3.2 without changing the immutable older releases or adding a review. Remaining activation, sign-in and scenario evidence follow after the patch. See docs/acceptance/member-activation-2026-10-13.md.


## 13 October 2026 — Approved members online

Decision 770 supersedes decisions 768–769's pending member activation: both members are online on published 0.3.2. Madrid uses its isolated member home and retains its existing membership, HTTPS address and 0.3.1 rollback. The Mini remains apps-only; its two original app URLs return 200 and fifty original files are byte-identical. Both authentication-file fingerprints match across the update. The Pro remains healthy on 0.3.1; its latest observed resources fail the normal disk/load guard, so no forced update or guard override occurs. Madrid's protected owner checkout is saved and read back. Real Madrid terminal hostname/pwd/copy/reconnect preflight passes; formal D and physical-phone acceptance remain unclaimed. Its isolated Ekoa Codex sign-in is complete: the normal device flow selects goncalo@ekoa.io, and the hub records Madrid Ready with fresh 2% weekly usage. The five-hour figure remains unknown. The earlier expired challenge needs no owner action. No formal scenario clock or additional review starts. See docs/acceptance/member-activation-2026-10-13.md.


## 13 October 2026 — Close imported reply-only work

Decision 771 supersedes decision 761's pending old-work choice: the owner approves Close this work with Keep them. The live operation exposes an unbound-import checkout-claim deadlock. Repair only receipt-bound completed reply work with no checkout mutations; release its exact legacy claim transactionally on the hub, preserving ordinary member/hash/ownership guards and all original files/history. Eleven encrypted-migration/closure regressions pass after a failing-before case; twenty existing affected checks also pass through the run/rerun. Publish corrective 0.3.3 with rollback before retrying the normal owner control. Production closure and dependent Ekoa bindings remain pending; no scenario clock or new review starts. See docs/acceptance/imported-work-close-2026-10-13.md.


Final simulated verification: the isolated Linux run passes 187/187 affected backend cases in six files. Both existing close journeys pass all eight phone/desktop light/dark cases. Final typecheck/lint/build and two private full-data update/restore fixtures pass. New vision checks are blocked without their dedicated credential. Corrective 0.3.3 source and platform packages precede the normal Pro update/close; live closure remains pending, with rollback retained and no additional review or scenario clock.


## 13 October 2026 — Correct release identity before activation

Decision 772 replaces decision 771's provisional package identity checkpoint. Archive verification catches an advertised CLI version of 0.3.2 despite 0.3.3 manifests, before installation or GitHub release publication. Synchronize the runtime VERSION and add an actual-CLI regression in an isolated home: it fails before repair and passes after it. Preserve the failed private candidates. Only this run's new unpublished v0.3.3 tag is retargeted to the correction, with an expected-old-target lease; earlier published tags/assets and both source commits stay preserved. Rebuild and verify both final packages before publication/activation. This adds one passing check to the earlier 187 affected cases; no additional review or live scenario starts.


## 13 October 2026 — Old work closed and Ekoa clones bound

Decision 773 completes 771–772's live recovery: published 0.3.3 from f02f27b is healthy on the Pro under its retained user service/HTTPS address, with accounts/settings/vault/authentication/identity and 37 original history files preserved. Full cold 0.3.1 restoration and all earlier backups remain. The owner-approved normal Keep control closes the old Ekoa work and releases only its imported claim. Both dedicated clean-main clones are now bound to the existing Ekoa registration, allowing Pro/Madrid and retaining project-only GitHub scope; Mini remains excluded/apps-only. Both final platform assets match published digests, actual CLI/native PTY and 21 files/10 assets. Preset/MCP/provider acceptance remain pending; no formal clock, extra review or owner acceptance is claimed. See docs/acceptance/release-033.md.


## Live Ekoa preset checkpoint, 13 October

Decision 774 replaces decision 773's pending Ekoa preset application. The normal authenticated setup operation configures the existing Ekoa project on the active Pro hub: six goals, two active, all Propose tasks; shadow merging with requiredChecks [result]; the exact thread rules/risky areas; worktree isolation and npm ci; 01:00 Europe/Lisbon Nightly; hub memory, capture and the independent dream. Only Pro and Madrid are allowed, with limits 6/8 and project limit 12. The first review starts at current main 770e76b, not the whole history. The selected existing Opus model is unchanged; only its display label is corrected. The real coordinator completes a refill, reads memory/GitHub commits and proposes two drafts; neither is approved or starts a coding thread. Live Variables read at 14:34 UTC finds NIGHTLY_SCHEDULER unset, so watch mode remains; PR208 is open/unmerged. Ekoa rejects the browser's saved login; the visible login panel awaits the owner's correct existing credential. MCP, provider journeys and phone acceptance remain blocked/unclaimed; no formal scenario clock or additional review starts. See docs/acceptance/ekoa-preset-live-2026-10-13.md.


Activation correction, 13 October (decision 788): Ekoa browser sign-in is complete. Its live MCP metadata requires OAuth authorization-code/PKCE and rotating refresh tokens, while the current Jevellan mirror accepts a manually entered static bearer token. Mirror authentication/capability discovery remains blocked on that unsupported client behavior; there is no further owner password step. The sandbox provider scenarios continue independently under their original ten-hour clock. See [the compatibility evidence](acceptance/ekoa-auth-compatibility-2026-10-13.md).


Decision 789 repairs the next real A finding: a saved project token did not reach isolated thread Git commands, so CSV conflict resolution asked the owner for a routine fetch. Writable thread launches now receive fresh repository-scoped credentials only in their native process environment; registered origins and existing vault scope remain authoritative. Other roles get none, offline local work remains available, and native homes/Git configuration/MCP input configuration stay unchanged. Both header forms are redacted. All 130 affected cases pass through the initial run and corrected-file rerun, with typecheck/lint/build; a real isolated Git read passes. Full A rerun is pending after its current failure is recorded, within the original clock. No cache/journal implementation or new clock starts.


Decision 790 corrects the prior harness reset order. Cancel only unstarted drafts/queued tasks, stop begun work through the normal thread controls, then wait for terminal states before touching sandbox GitHub history. An owner-attached session blocks reset before settings or stop mutations. The regression fails before repair; all 19 affected harness cases in two files, typecheck and lint pass. Assertions, owner messages, prior logical project history and the original live clock are unchanged. Git authentication checkpoint 3ec6a03 is pushed after its mandatory secret scan; owned Pro and Madrid development copies are staged with verified packaged exports, without switching the running profiles or installed production.
