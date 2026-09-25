# Architecture

Jevellan runs a daemon on each device. The daemon serves the React application, owns conversations running on that device, and launches the installed runtime adapters. One daemon is the hub: it owns shared configuration and coordinates devices. Members reach shared state through authenticated HTTP; they never open the hub database.

The project uses strict TypeScript, ESM and npm workspaces. The supported Node versions are declared in the root package manifest. Installed applications run from independent versioned copies, so changing this checkout does not change a running installation. See [installation](install.md).

## Package boundaries

| Location | Responsibility |
| --- | --- |
| `apps/daemon` | Application composition, HTTP and SSE, authenticated browser/device routes, static React assets, diagnostics and Settings synchronization. |
| `apps/web` | Conversations, Settings, guided setup, device switching and desktop/phone presentation. |
| `packages/core` | Versioned schemas, configuration revisions, isolated homes, vault, Git primitives, locks, process control and Rigging materialization. |
| `packages/conversations` | Durable work and stretches, briefs, handoffs, correction/undo, guards, checkpoint verification/publication and context operations. |
| `packages/decisions` | Jev transport, the question set, state packets, action/model/effort resolution and memory selection. |
| `packages/accounts` | Eligible account ranking, authentication, probes, model discovery and usage. |
| `packages/memory` | Isolated Basic Memory processes, project registration, explicit synchronization, search and permissioned memory operations. |
| `packages/mesh` | Hub database and shared state, device membership, authentication, ownership/leases, indexes, presence and native-session sensing. |
| `packages/runtime-contract` | Adapter interfaces, common runtime helpers and the published contract test runner. |
| `runtimes/claude`, `runtimes/codex` | Built-in SDK adapters, isolated account authentication and launch-specific permissions/tools. |
| `packages/cli` | Install/join/update/rollback/removal, user-service adapters, private dependencies, diagnostics and the MCP bridge. |

The application composition lives in `apps/daemon/src/application.ts`. Hub and member implementations satisfy the same shared-state and coordination interfaces; the conversation service does not substitute a local writable copy when the hub is unavailable.

## A conversation step

1. An authenticated request opens work on the selected project and device. The owner records the request before preparing a stretch. Client request identifiers reconcile a lost creation reply without creating another conversation.
2. Guards inspect the work, checkout ownership, outside activity, budgets and allowed actions. Jev decides the meaning of the request and the appropriate action, model and effort within those limits. A missing or failed Jev connection offers explicit manual choices. See [decisions](decisions.md).
3. Account eligibility and runtime capabilities restrict which models can run. The chosen account supplies an isolated runtime home. The owner builds a bounded brief and gives the stretch a scoped bridge token.
4. The adapter streams text and tools through the owner into the ledger and SSE. Bridge tools expose only that stretch's conversation, project, permissions and memory scope. A structured handoff records the outcome; a permitted repair continues the same native session.
5. After confirmed process completion, the owner checks the resulting files. Main-policy work checkpoints owned changes. Jevellan runs the configured verification command itself before publication; a provider's test claim is evidence, not a substitute for that check.
6. Publication requires a clean checkpoint and a hub lease for the remote. Upstream changes are integrated through the recorded Git path and verified as required. Repository-memory-only changes have an explicit exemption from code tests. The owner then prepares the next decision or closes the work.

`packages/conversations/src/service.ts` connects these operations. Dedicated modules implement guards, execution, checkpoints, publication, corrections, recovery and context changes. Decisions belong in `packages/decisions`; guards belong in `packages/conversations`. There is no heuristic model routing.

## Authority and persistence

The hub stores shared configuration revisions, accounts, project bindings, Rigging, device records, slim conversation/correction indexes and coordination records in `JEVELLAN_HOME/hub/jevellan.db`. Secrets are encrypted in its vault; `hub/secret.key` is private local key material. Settings responses expose secret summaries rather than credential readback. The materialized `apm.yml` is derived from the authoritative configuration revision.

The conversation owner stores its complete history under `conversations/{id}/`: numbered append-only ledger segments, immutable handoffs, blobs and rebuildable projections. Ledger events are flushed before acknowledgement. Startup checks the writer lock and replays history; it does not resume a model automatically. Incomplete final records are preserved, while malformed complete records or broken sequence numbers fail explicitly.

Shared indexes contain enough information to find the owner and display conversation lists. Full briefs, decision details and runtime history remain on the owner. Requests from another device are routed to that owner, including its live event stream. See [mesh](mesh.md).

Configuration and shared document writes compare expected revisions. Idempotent request receipts recover a lost reply without replaying a different write. Hub waits preserve an admitted operation's recorded boundary, recheck authority and local state when connectivity returns, and stop on cancellation or daemon shutdown. They do not grant permission to overwrite intervening changes.

## Files, processes and installation

`Homes` canonicalizes paths and refuses overlap with native agent or Basic Memory homes. Runtime account files live under `homes/{runtime}/{account}`. Per-launch bridge and permission configuration stays scoped to the launch. Environment filtering and redaction keep the host's unrelated authentication out of those processes and their persisted output.

Project paths refer to real checkouts. Main-policy work coordinates checkpoints and publication; external-policy work preserves the user's Git control. Checkout claims survive a daemon exit until work is explicitly reconciled. Publication leases are separate and renewed while needed. Native-session sensing is read-only and reports activity metadata without publishing transcripts or native session identifiers.

Memory and instruction files are part of the project rules, not global user configuration. Repository memory travels through Git; device memory remains excluded. Context replacements require a reviewed, current file fingerprint and checkout ownership. See [memory](memory.md).

The installation lifecycle gate separates admitted application work from maintenance. Update waits for running conversations before switching its recorded service to the prepared version. Uninstall refuses active work. Agents do not control the daemon lifecycle. Removal follows installation ownership receipts and preserves unrelated files and services.

Runtime permissions differ. Read-only enforcement, command denials and post-stretch Git checks are documented separately in [runtimes](runtimes.md); these controls are not described as a general sandbox.

## Evidence and remaining work

The [acceptance report](acceptance/REPORT.md) distinguishes built, installed, running, tested and accepted states. Tests use disposable homes and checkouts, with live versus simulated providers labelled separately. Successful live Jev classification and live Claude checks require dedicated credentials. The improver is still to be implemented; this document describes the current conversation, mesh and installation architecture without claiming that remaining phase is complete.
