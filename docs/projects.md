# Projects

Projects is the area of Jevellan where one coordinator per project plans the work and threads carry it out. The owner talks with the coordinator; the coordinator splits requests into threads, routes follow-ups to the thread already doing that work, keeps a project notebook and brings back only the questions that need the owner. Each thread is a full Claude Code or Codex session that carries one task end to end, on any device and eligible account, in its own worktree or directly on main.

Projects sits next to the existing conversations, which keep working exactly as before. It reuses their pieces: the runtime adapters, isolated account homes and account ranking, Jev, the scoped bridge, project memory, the device mesh and the native transcript readers. The specification is `BRIEF-projects.md` (local and untracked, like `BRIEF.md`); where the build chose differently, the choice is a numbered decision in the [acceptance report](acceptance/REPORT.md).

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

A session rotates to a fresh native session at 40 turns, when the coordinator's model or effort changes, when its account is no longer eligible (the chat says which account it moved to) and when the owner presses **Fresh coordinator session**. Later turns resume the session and send only the event block. The final assistant text of a turn becomes one chat reply, and each tool call one compact chat line.

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

Code first computes the candidates: online devices with a path for the project that the project allows, below their running limit, and for main isolation a free checkout on main; and enabled menu models whose runtime can run threads and has an eligible account on at least one candidate device. Excluded models and devices keep their reasons. Jev then answers placement Call A (isolation when both are allowed, model, effort) and placement Call B (device when more than one qualifies), each sent only when it has questions, with a redacted `placement-state-v1` packet. The most probable option wins, the effort is mapped to the model's supported efforts and the account is the best-ranked eligible one on the chosen device. When the running limits leave no candidate, the thread is placed ignoring them and queued.

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

Main isolation is offered only when the project's Git policy is Work on main; a Leave git to me project explains why it is unavailable. Placement puts a main thread only on a device whose checkout is on main by its latest heartbeat and is free: no held checkout claim (a conversation or another main thread) and no main thread of the project there that has not ended. At most one main thread works in a device checkout at a time; parallel main work goes to different devices and coordinates through mail and reservations.

Preparation claims the checkout through the same checkout ownership conversations use, so a conversation on it is refused with `{project} on {device} is in use by "{thread}".` until the thread publishes, concludes or stops, and brings the checkout to clean, current main. A checkout with foreign changes fails the thread with a sentence asking the owner to commit, stash or publish them. Stopping a main thread saves its unpublished commits at `refs/jevellan/discard/{threadId}/1` before the checkout returns to main.

The claimed checkout is still the owner's. While the owner has it on a branch of their own (an unfinished rebase onto main counts as main), nothing of the thread runs or writes there: its next turn waits with `This project must be on main before Jevellan can change git. This thread continues once the checkout is back on main.` (its messages stay queued and the sweeps start the turn once main is back), a `done` report publishes nothing and commits none of the files there, and Stop ends the thread but keeps the claim without committing, aborting or resetting anything, as it does while another agent is active in the checkout. Such a Stop remembers where local main was (and, with another agent active on main, the files in the checkout). Once the checkout is back on main and free, the Stop finishes only if main is still there and the checkout holds nothing new: no uncommitted files, or exactly the files it saw. Otherwise the owner has worked there since, so the claim is given back with nothing committed, saved or reset, and the ledger says `The checkout changed after the Stop, so Jevellan gave it back as it is: nothing was committed, saved or reset, and any of the thread's commits still on main stay there.` Until the owner publishes or removes those commits and files, a later main thread or conversation on that checkout asks them to commit, stash or publish them first.

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

A main thread's `done` report commits leftovers in the owned checkout and runs the same three-attempt verification. Under the publication lease of the checkout's remote, Jevellan fetches main and rebases onto `origin/main`. A conflict aborts the rebase and sends the thread the main-conflict prompt naming the conflicting files; a rebase that brought upstream commits is verified again; then `HEAD` is pushed to main. A busy lease is tried again three times, 20 seconds apart. Success ends the thread `done` with the published commit, releases the checkout and the reservations and tells the coordinator `Published to main as {short sha}.` Stop pressed during a publication ends it before the push, also while the lease is awaited and without a test command. Messages that waited during a publication that concluded the thread are named in a thread notice, `The thread concluded before these messages reached it: ...`, and leave the queue.

## Terminal takeover

`jevellan thread attach {threadId}` hands a thread at rest to the owner's terminal, on the device that owns the thread; elsewhere it prints `This thread runs on {device}. Run the command there.` and exits 1. The command authenticates to the local daemon with the installation control file, as `jevellan doctor` does, at `POST /api/local/threads/:tid/attach`. The daemon refuses a working thread (`The thread is working. Wait for the turn to end or stop it.`), an ended or already attached thread and a thread without a native session. Otherwise the thread becomes `attached`, and the daemon returns the working directory, runtime, native session, model, effort and an environment of only the account home and authentication variables.

The command then starts `claude --resume {session} --model {model}` (with `--effort` when the installed CLI lists it, and `--settings '{"cleanupPeriodDays":36500}'`, which keeps the account home's transcripts past the CLI's 30-day retention) or `codex resume {session} -m {model} -c model_reasoning_effort="{effort}"` in the thread's directory, with inherited terminal input and output. Secrets never travel in arguments. On exit, including after Ctrl-C or a forwarded SIGTERM or SIGHUP, it calls `POST /api/local/threads/:tid/detach`. The daemon adopts the newest native session in that account home whose directory is the thread's and that changed after the attach began (covering CLIs that fork the session on resume), sets the thread `idle`, tells the coordinator `[owner worked on thread "{title}" in a terminal]` and starts the next turn from the messages that waited. When Jevellan cannot be reached at exit, `jevellan thread detach {threadId}` hands the thread back later.

While a thread is attached, the owner's messages wait and the coordinator's are refused. Stop, Restart, Discard and a turn-limit **Stop the thread** answer are refused too, for the owner and the coordinator's `jevellan_thread_stop` alike, with `This thread is attached in a terminal: exit that terminal session first, or run jevellan thread detach {threadId}.`, before anything changes (the question stays open); the thread page shows Stop and the Restart choice disabled with that sentence. The thread's account is held for turns on its device, read from the attached state itself, so a restart keeps the hold and detach (also `jevellan thread detach` after a terminal that ended without it) releases it. Another thread whose model has another eligible account there runs on it in a fresh session; otherwise its turn waits at rest with `Waiting for account {label}, which is in use in a terminal. This thread continues when the terminal session ends.`, keeping its messages or the turn it was about to take, and starts after detach. A coordinator in that position is `Unavailable` with `Account {label} is in use in a terminal. The coordinator continues when the terminal session ends.`, without counting a failed turn. Conversations do not take part in this hold. The thread page shows `Take over in a terminal on {device}: jevellan thread attach {threadId}` with a copy button under the composer of every thread that has not concluded. There is no browser terminal.

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
| Coordinator session | rotates after 40 turns |
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
