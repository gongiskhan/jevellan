# Reference map

Garrison is read-only at ~/dev/garrison. Reference HEAD: fa5c9277e2bc4e873699c925c0047186ef90f03f. There are no runtime imports from Garrison.

## Sources and destinations

The table distinguishes inspected contracts from pending implementation reads. A listed source does not imply its behavior has already been implemented.

| Source | Behavior to port | Destination | Reading state / deliberately dropped |
| --- | --- | --- | --- |
| AGENTS.md, docs/CONVERSATIONS.md | Three-layer conversation persistence; one active writer; context continuity | packages/conversations | Read; drop board lifecycle and routing ladders. |
| docs/stretch-runtime-contract.md, docs/RUNTIME_DEGRADATIONS.md | Observable execution, fresh sessions, explicit capability limits | packages/runtime-contract, runtimes/* | Read; replace legacy advisory-only read actions with proven runtime controls. |
| docs/validation/2026-09-09-conversation-operability.md | All recorded failures below | tests/integration and tests/e2e | Read completely; no self-redeploy recovery behavior is ported. |
| docs/INSTANCES.md, src/lib/instance-profile.ts | Separate homes, services and ports; installed copies | packages/cli | Read; default port 9771 does not overlap the documented map. |
| docs/METADATA.md, docs/CAPABILITY_CONTRACT.md | APM manifest and explicit setup/verification contracts | packages/core | Read; no capability catalog or provider tenancy. |
| docs/decisions/2026-09-03-shells-and-mesh-sessions.md | Session row shape, freshness and deduplication | packages/mesh | Reading in progress; terminal attach/input, tunnel operation and native hook installation are excluded. |
| packages/claude-pty/src/conversation-store.mjs | Immutable handoffs, blob spill, ledger rolling and active-writer guard | packages/conversations | Implementation read pending. |
| fittings/seed/http-gateway/scripts/lib/stretch.mjs | Brief, handoff validation, timeout and steering | packages/conversations | Implementation read pending; no legacy routing policy. |
| packages/talk/ | Streaming timeline, tool display, badges and file click-through | apps/web | Implementation read pending; no boards, voice, shells or route selectors. |
| src/lib/accounts.ts, account-env.ts, account-login.ts, paymaster.ts, account-balance.ts | Isolated account credentials, UI login, probes and usage | packages/accounts, runtimes/* | Implementation read pending. |
| src/lib/runtime-homes.ts | Separate runtime homes | packages/core | Implementation read pending; no native-home migration or linking. |
| src/lib/runtime-selection.ts; fittings/seed/codex-runtime/lib/codex-adapter.mjs; Agent SDK adapter | Runtime launch and event normalization | runtimes/* | Entry points located; detailed reads and spikes pending. |
| src/lib/runner.ts, runtime-apm.ts, apm-exec.ts | APM install, lock and unchanged-configuration fingerprint | packages/core | Entry points located; detailed reads pending. |
| src/lib/primitive-state.ts, quarters.ts, reconcile.ts; Quarters components | Owned, loose and parked state; autosave | packages/core, apps/web | Pending; do not port native config access. |
| src/lib/mesh/, packages/talk/src/mesh-sessions.mjs | Heartbeat, index aggregation and owner routing | packages/mesh | Pending. |
| fittings/seed/remote-shell-runtime/lib/session-index.mjs and listers/ | Native session metadata, dedupe and freshness | packages/mesh | Pending; no native hooks, terminal control or transcript export. |
| Garrison device-switcher components | Device list and navigation | apps/web | Pending; use one-time target-bound switch tokens. |
| fittings/seed/kanban-loop/lib/dispatch-lease.mjs | Lease acquisition and renewal | packages/core | Pending; no board scheduling. |
| packages/improver/src/ | Proposal and outcome persistence | packages/decisions | Pending; no automatic routing edits. |
| Install/uninstall scripts | Service registration and scoped removal | packages/cli | Pending; Jevellan names and manifest only. |
| fittings/seed/basic-memory/scripts/setup.sh and capture-session.py | Dependency installation and capture hooks | packages/memory | Located; pending. Shared/global memory, recall hooks and native-home writes are excluded. |
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

The latest locally known remote commit is dac53419d7d07029c63af8dd4f8258d07669c0df, titled "fix: restart the node when its app stops listening". Read its watchdog change without checking it out. The lesson for Jevellan is that UI liveness must not terminate running stretches.
