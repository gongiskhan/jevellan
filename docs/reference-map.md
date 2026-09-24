# Reference map

Garrison is read-only at ~/dev/garrison. Reference HEAD: fa5c9277e2bc4e873699c925c0047186ef90f03f. There are no runtime imports from Garrison.

## Sources and destinations

Phase 0 inspected the contracts and relevant entry points below. Later phases return to matching implementation and tests when porting each behavior. A listed source does not imply the behavior is already implemented.

| Source | Behavior to port | Destination | Reading state / deliberately dropped |
| --- | --- | --- | --- |
| AGENTS.md, docs/CONVERSATIONS.md | Three-layer conversation persistence; one active writer; context continuity | packages/conversations | Read; drop board lifecycle and routing ladders. |
| docs/stretch-runtime-contract.md, docs/RUNTIME_DEGRADATIONS.md | Observable execution, fresh sessions, explicit capability limits | packages/runtime-contract, runtimes/* | Read; replace legacy advisory-only read actions with proven runtime controls. |
| docs/validation/2026-09-09-conversation-operability.md | All recorded failures below | tests/integration and tests/e2e | Read completely; no self-redeploy recovery behavior is ported. |
| docs/INSTANCES.md, src/lib/instance-profile.ts | Separate homes, services and ports; installed copies | packages/cli | Read; default port 9771 does not overlap the documented map. |
| docs/METADATA.md, docs/CAPABILITY_CONTRACT.md | APM manifest and explicit setup/verification contracts | packages/core | Read; no capability catalog or provider tenancy. |
| docs/decisions/2026-09-03-shells-and-mesh-sessions.md | Session row shape, freshness and deduplication | packages/mesh | Session row/status contract inspected; terminal attach/input, tunnel operation and native hook installation excluded. |
| packages/claude-pty/src/conversation-store.mjs | Immutable handoffs, blob spill, ledger rolling and active-writer guard | packages/conversations | Ledger, summary, handoff, spill and writer sections inspected; use strict immutable writes and full hashes. |
| fittings/seed/http-gateway/scripts/lib/stretch.mjs | Brief, handoff validation, timeout and steering | packages/conversations | Brief and handoff sections inspected; no legacy routing policy. |
| packages/talk/ | Streaming timeline, tool display, badges and file click-through | apps/web | live-event-stream.mjs and ui/conversation-transport.ts inspected: atomic replay/follow, relative URLs, explicit send/cancel errors. No boards, voice, shells or route selectors. |
| src/lib/accounts.ts, account-env.ts, account-login.ts, paymaster.ts, account-balance.ts | Isolated account credentials, UI login, probes and usage | packages/accounts, runtimes/* | Account, environment, terminal login and usage-probe behavior inspected; never link or migrate native credentials. |
| src/lib/claude-home.ts; tests/garrison-home.test.ts | Separate runtime homes | packages/core | Ancestor resolution and alias refusal inspected; no credential symlinks, native-home migration or shared settings. |
| src/lib/runtime-selection.ts; fittings/seed/codex-runtime/lib/codex-adapter.mjs; Agent SDK adapter | Runtime launch and event normalization | runtimes/* | Environment/launch assembly and SDK client inspected; SDK spikes recorded in runtimes.md. No ambient credentials or shared launch tokens. |
| src/lib/runner.ts, runtime-apm.ts, apm-exec.ts, up-fingerprint.ts | APM install, lock and unchanged-configuration fingerprint | packages/core | APM execution, lock reconciliation, fingerprint and home-existence checks inspected; no full composition engine. |
| src/lib/primitive-state.ts, quarters.ts, reconcile.ts; Quarters components | Owned, loose and parked state; autosave | packages/core, apps/web | Classifier, actions, reconciliation, MarkdownEditor.tsx and StateBadge.tsx inspected. Retain disabled items and drift; use safe preview rendering. No native config access. |
| src/lib/mesh/, packages/talk/src/mesh-sessions.mjs | Heartbeat, index aggregation and owner routing | packages/mesh | self-snapshot.ts, staleness.ts, peer-proxy.ts and mesh-sessions.mjs inspected: independent probes, stale cache and stream connection timeout. Use member-token auth. |
| fittings/seed/remote-shell-runtime/lib/session-index.mjs and listers/ | Native session metadata, dedupe and freshness | packages/mesh | Index and Claude/Codex/Cursor lister entry points inspected: journal metadata, cwd matching and status evidence. No native hooks, CLI probes, terminal control or transcript export. |
| Garrison device-switcher components | Device list and navigation | apps/web | NodeSwitcher.tsx and node-switch.ts inspected; use one-time target-bound switch tokens. |
| fittings/seed/kanban-loop/lib/dispatch-lease.mjs | Lease acquisition and renewal | packages/core | Heartbeat expiry, terminal state and invalid timestamp handling inspected; no board scheduling. |
| packages/improver/src/ | Proposal and outcome persistence | packages/decisions | store.mjs inspected: revision checks and proposal persistence; no automatic routing edits or fixed machine names. |
| Install/uninstall scripts | Service registration and scoped removal | packages/cli | scripts/install-node.sh service section and remote-shell-runtime/scripts/uninstall-hooks.mjs owned-removal logic inspected; Jevellan names and manifest only. |
| fittings/seed/basic-memory/scripts/setup.sh and capture-session.py | Dependency installation and capture hooks | packages/memory | Install/project sections and capture-session.py inspected. Shared/global memory, recall hooks and native-home writes excluded; no direct upstream MCP for agents. |
| Ekoa branch jev | Verified Jev request builder | packages/decisions | Optional branch absent; use the public API contract. |

## Operability regression obligations

| Recorded failure | Required Jevellan regression | State |
| --- | --- | --- |
| Initial request never became the objective | The request remains verbatim across plan, pause, continuation and completion | Pending |
| Remaining work and evidence omitted from subsequent briefs | Handoffs retain blockers, failed approaches, evidence pointers and plan contents in future briefs | Pending |
| Project scope degraded to a wrong directory | Invalid or absent checkout rejects launch, with no fallback | Pending |
| Triage edited files and killed its host | Read-only runtime contract and Safety command-denial tests | Pending |
| Work invoked a redeploy under its own gateway | Service-control denials, installed-copy isolation and UI-failure independence | Pending |
| Formatting repair lost context or rewrote native output as code | Bounded same-session repair, partial-output retention and no implicit file write | Pending |
| Missing completion evidence became success | Daemon-owned verification tied to the exact final commit; failed tests keep work open | Pending |
| Budget exhaustion hid outstanding work | Guard stops preserve work, constraints and counters | Pending |
| Pauses lost obligations; later fresh requests inherited old ones | Same work through pauses, fresh work only after closure | Pending |
| Interrupted work could double-launch | Persisted process identity, termination before release and explicit restart waiting state | Pending |
| Tool header overflow and expansion drift | Desktop/mobile collapsed tools, aligned header/body and persistent manual expansion | Pending |

The latest locally known remote commit is dac53419d7d07029c63af8dd4f8258d07669c0df, titled "fix: restart the node when its app stops listening". Its watchdog change was read with git show without checking it out or fetching. The lesson for Jevellan is that UI liveness must not terminate running stretches.

Implementation tests located and inspected: tests/conversation-operability.test.ts (request continuity, repair output, verification and hosted-process guard) and tests/garrison-home.test.ts (alias refusal and private permissions). Native-credential linking tests are deliberately not ported. The rest of each behavior's tests are read when that behavior is implemented.

Phase 1 additionally read `src/lib/account-login.ts`, `scripts/account-login-pty.mjs`, `scripts/lib/account-login-output.mjs` and `tests/account-login-output.test.ts`. The terminal-output cases were adapted in `tests/login.test.ts`: wrapped tokens, cursor controls, incomplete output, verification URLs and direct secret capture. `src/lib/paymaster.ts` and `tests/paymaster.test.ts` informed usage-window parsing and the distinction between authentication failures and unavailable usage. `src/lib/global-composition.ts`, runtime APM helpers and `tests/global-composition.integration.test.ts` informed `tests/rigging.test.ts`: preservation of loose files, missing owned-file restoration, disabled-file parking and refusal to overwrite drift. Jevellan stages APM output and applies its own ownership records; it does not import the composition engine.
