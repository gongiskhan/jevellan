# Architecture

Jevellan runs a daemon on each device. The daemon serves the React application, owns the conversations and project threads running on that device, and launches the installed runtime adapters. One daemon is the hub: it owns shared configuration and coordinates devices. Members reach shared state through authenticated HTTP; they never open the hub database.

The project uses strict TypeScript, ESM and npm workspaces. The supported Node versions are declared in the root package manifest. Installed applications run from independent versioned copies, so changing this checkout does not change a running installation. See [installation](install.md).

## Package boundaries

| Location | Responsibility |
| --- | --- |
| `apps/daemon` | Application composition, HTTP and SSE, authenticated browser/device routes, project work routes, loopback control routes, static React assets, diagnostics and Settings synchronization. |
| `apps/web` | Conversations, the Projects area, Settings, guided setup, device switching and desktop/phone presentation. |
| `packages/core` | Versioned schemas (project work and bridge tool schemas included), configuration revisions, isolated homes, vault, Git primitives, locks, process control, Rigging materialization and the GitHub REST client. |
| `packages/conversations` | Durable work and stretches, briefs, handoffs, correction/undo, guards, checkpoint verification/publication and context operations, plus the generic JSONL ledger and scoped bridge registry that Projects reuses. |
| `packages/decisions` | Jev transport, the question sets (q-v2 for conversations, p-v1 for thread placement), state packets, action/model/effort resolution, placement candidates and fallback, and memory selection. |
| `packages/accounts` | Eligible account ranking, authentication, probes, model discovery and usage. |
| `packages/memory` | Isolated Basic Memory processes, project registration, explicit synchronization, search and permissioned memory operations. |
| `packages/mesh` | Hub database and shared state (project work collections and the relay included), device membership, authentication, ownership/leases, indexes, presence, native-session sensing and native transcripts from an explicit root. |
| `packages/runtime-contract` | Adapter interfaces for stretches and turns, safety profiles, common runtime helpers, the scripted FakeRuntime and the published contract test runner. |
| `packages/projects` | Project work: the coordinator turn loop, thread runner and lifecycle, placement wiring, worktrees, verification and publication, pull request tracking, decision items, mail, the relay outbox and inbox, terminal attach and restart recovery. |
| `runtimes/claude`, `runtimes/codex` | Built-in SDK adapters for stretches and turns, isolated account authentication and launch-specific permissions/tools. |
| `packages/cli` | Install/join/update/rollback/removal, user-service adapters, private dependencies, diagnostics, `jevellan thread attach` and the MCP bridge. |

The application composition lives in `apps/daemon/src/application.ts`, which wires `ProjectWork` next to the conversation service. Hub and member implementations satisfy the same shared-state and coordination interfaces; the conversation service does not substitute a local writable copy when the hub is unavailable.

## A conversation step

1. An authenticated request opens work on the selected project and device. The owner records the request before preparing a stretch. Client request identifiers reconcile a lost creation reply without creating another conversation.
2. Guards inspect the work, checkout ownership, outside activity, budgets and allowed actions. Jev decides the meaning of the request and the appropriate action, model and effort within those limits. A missing or failed Jev connection offers explicit manual choices. See [decisions](decisions.md).
3. Account eligibility and runtime capabilities restrict which models can run. The chosen account supplies an isolated runtime home. The owner builds a bounded brief and gives the stretch a scoped bridge token.
4. The adapter streams text and tools through the owner into the ledger and SSE. Bridge tools expose only that stretch's conversation, project, permissions and memory scope. A structured handoff records the outcome; a permitted repair continues the same native session.
5. After confirmed process completion, the owner checks the resulting files. Main-policy work checkpoints owned changes. Jevellan runs the configured verification command itself before publication; a provider's test claim is evidence, not a substitute for that check.
6. Publication requires a clean checkpoint and a hub lease for the remote. Upstream changes are integrated through the recorded Git path and verified as required. Repository-memory-only changes have an explicit exemption from code tests. The owner then prepares the next decision or closes the work.

`packages/conversations/src/service.ts` connects these operations. Dedicated modules implement guards, execution, checkpoints, publication, corrections, recovery and context changes. Decisions belong in `packages/decisions`; guards belong in `packages/conversations`. There is no heuristic model routing.

## Project work

`packages/projects` runs one `ProjectWork` per daemon beside the conversation service. It reuses the runtime adapters, account ranking and usage accounting, Jev, the bridge registry and project memory, but not the conversation service itself. Behavior, limits and prompts are described in [projects](projects.md).

1. **Turns.** The coordinator and every thread run through `RuntimeAdapter.startTurn` with a `turn-input-v1` document: one worker process per turn, the native session resumed by the next turn, permissions and safety profile set on every turn (the coordinator read-only, threads write). `WorkerRun` serves the `start-turn` worker command with the same environment, process-group and redaction rules as stretches. See [runtimes](runtimes.md#turns).
2. **Coordinator.** Events queue in the owner-local `coordinator.json` and are delivered one turn at a time on the coordinator's device. Each turn gets a bridge token for the `coordinator` scope; the chat is the coordinator ledger, served as SSE with event name `project`.
3. **Threads.** Every start is placed on the coordinator's device (`@jevellan/decisions` placement, accounts by `rankAccounts`) and prepared on the chosen device. One `ThreadRunner` per local thread chains its steps: preparation of a worktree or the main checkout, turns with a `thread`-scope bridge token, reports, verification and publication, the turn limit, stop, discard and attach. `PullRequestTracker` follows open pull requests through `GitHubClient`.
4. **Indexes.** The thread's owner publishes a slim `project-thread-index-v1` to the hub on every state change, ordered by its ledger event id; project lists and pages on any device read the hub. Coordinator state is published the same way as `project-coordinator-status-v1`.
5. **Relay.** Thread starts, commands to threads and coordinator events that cross devices travel as hub envelopes. The sender keeps a durable outbox and the target polls, deduplicates and acknowledges, so delivery is ordered and survives hub outages. Browser requests for a thread or coordinator on another device use the owner proxy instead. See [device mesh](mesh.md#projects-across-devices).

Project ledgers use the generic JSONL ledger extracted from the conversation ledger with their own `project-ledger-event-v1` schema, so conversation replay is unchanged. They record lifecycle events only; a thread's transcript is read from its native session file through `nativeTranscriptAt`. Daemon restart never resumes a coordinator or thread turn: interrupted threads become idle and the coordinator is told.

## Authority and persistence

The hub stores shared configuration revisions, accounts, project bindings, Rigging, device records, slim conversation/correction indexes, coordination records and project work state in `JEVELLAN_HOME/hub/jevellan.db`. Project work uses the namespaces `project-work-settings`, `project-coordinators`, `project-coordinator-status`, `project-threads`, `project-thread-cursors`, `project-decisions`, `project-notebooks`, `project-placement-overrides`, `project-mail`, `project-reservations` and `project-envelopes`. Secrets are encrypted in its vault; `hub/secret.key` is private local key material. Settings responses expose secret summaries rather than credential readback. The materialized `apm.yml` is derived from the authoritative configuration revision.

The conversation owner stores its complete history under `conversations/{id}/`: numbered append-only ledger segments, immutable handoffs, blobs and rebuildable projections. Ledger events are flushed before acknowledgement. Startup checks the writer lock and replays history; it does not resume a model automatically. Incomplete final records are preserved, while malformed complete records or broken sequence numbers fail explicitly.

Project work is stored on the device that holds it, under `projects/{projectId}/`: the coordinator's device keeps `coordinator.json` with its event queue, the coordinator ledger and start receipts; each thread's device keeps `threads/{threadId}/thread.json` and its lifecycle ledger; a sending device keeps its relay outbox there too. Owner-local sidecars keep process identity and the last pushed commit. Native session identifiers stay in these files and never reach hub indexes, API responses or evidence.

Shared indexes contain enough information to find the owner and display conversation lists. Full briefs, decision details and runtime history remain on the owner. Requests from another device are routed to that owner, including its live event stream. See [mesh](mesh.md).

Configuration and shared document writes compare expected revisions. Idempotent request receipts recover a lost reply without replaying a different write. Hub waits preserve an admitted operation's recorded boundary, recheck authority and local state when connectivity returns, and stop on cancellation or daemon shutdown. They do not grant permission to overwrite intervening changes.

## Files, processes and installation

`Homes` canonicalizes paths and refuses overlap with native agent or Basic Memory homes. Runtime account files live under `homes/{runtime}/{account}`. Thread worktrees live under `worktrees/{projectId}/{threadId}`, outside every checkout. Per-launch bridge and permission configuration stays scoped to the launch. Environment filtering and redaction keep the host's unrelated authentication out of those processes and their persisted output.

Project paths refer to real checkouts. Main-policy work coordinates checkpoints and publication; external-policy work preserves the user's Git control. Checkout claims survive a daemon exit until work is explicitly reconciled. Publication leases are separate and renewed while needed. Native-session sensing is read-only and reports activity metadata without publishing transcripts or native session identifiers.

Memory and instruction files are part of the project rules, not global user configuration. Repository memory travels through Git; device memory remains excluded. Context replacements require a reviewed, current file fingerprint and checkout ownership. See [memory](memory.md).

The installation lifecycle gate separates admitted application work from maintenance. Update waits for running conversations before switching its recorded service to the prepared version. Uninstall refuses active work. Agents do not control the daemon lifecycle. Removal follows installation ownership receipts and preserves unrelated files and services.

Runtime permissions differ. Read-only enforcement, command denials and post-stretch Git checks are documented separately in [runtimes](runtimes.md); these controls are not described as a general sandbox.

## Evidence and remaining work

The [acceptance report](acceptance/REPORT.md) distinguishes built, installed, running, tested and accepted states. Tests use disposable homes and checkouts, with live versus simulated providers labelled separately. Successful live Jev classification and live Claude checks require dedicated credentials. The improver is built and served from Settings → Improver; its live run is still pending. Projects evidence is simulated: turns, Jev placement answers, GitHub and the second device are simulated, while Git, HTTP, the hub and process groups are real. The report records what is live, simulated and not run for each part.

### Entering main for foreground work

For a project configured to Work on main, conversation admission and instruction setup may move a clean, owned checkout from a named branch to main. Jevellan records a versioned branch-change intent before the move and a receipt afterwards. The conversation and context UI show a prominent notice naming the previous branch, and new-conversation setup reports the move too. The original branch is retained; switching to an existing main does not merge the feature branch into it.

A missing local main is created from origin/main, even for a single-branch clone. When neither main exists, Jevellan can create main locally and on origin from the current branch’s published history. A create-only remote lease prevents replacing a concurrently created main. Dirty files, unpublished commits, detached HEAD, pending Git operations and divergent local main remain blockers. Background maintenance does not opt in to branch switching, and Leave git to me never mutates Git. Fetching main uses an explicit ref without rewriting the repository’s remote or fetch settings.
