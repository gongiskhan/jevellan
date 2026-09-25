# Phase 1 runtime checkpoint

Evidence recorded on 2026-09-24. These are component checks, not completed acceptance journeys.

| Check | Evidence | Result |
| --- | --- | --- |
| Codex model discovery and account readiness | Live, dedicated account home | Five exact model ids returned with supported efforts; authentication ready. No identity or credential values saved. |
| Codex explicit token refresh | Live, dedicated account home | Native `account/read` with `refreshToken: true` returned Ready and an identity. Only readiness and presence booleans were printed. |
| Codex production adapter text, tools, usage and continuation | Live | Completed; native session retained; the continuation remembered the earlier word; process group gone after termination. |
| Codex production adapter interruption | Live | A running fixture with a child and grandchild interrupted in 120 ms; both descendants were gone before continuation. The same session retained its context and the worker group was gone after termination. |
| Codex per-launch Safety | Live runtime, inert git executable | `git -C <fixture> push` returned the Safety reason. The push-specific marker was absent; the process group was gone. |
| Codex concurrent scoped bridges | Live production adapter, fixture MCP | Passed: two projects using one account returned only their own scoped memory marker. Both turns completed with text, tool and usage events; both process groups were gone after termination. |
| Claude production adapter event normalization, interrupt and resume | Simulated provider CLI, real SDK and owned processes | Passed. This proves transport wiring, not authentication or native permission enforcement. |
| Claude live model/permission checks | Not run | Dedicated Claude test token is missing. Native credentials were not used. |
| Login capture and usage probing | Simulated terminal CLIs and HTTP responses | Twenty-two tests cover wrapped and partial tokens, cursor controls, direct vault capture, device-code fallback, callback scope, usage windows, provider API-key checks and native token refresh outcomes. |
| Rigging skill delivery | Installed APM 0.10.0, local packages | Actual APM deployments to isolated Claude and Codex staging folders reached the account homes. Native-home sentinels remained unchanged. |
| Rigging ownership | Simulated APM and temporary homes | Loose files preserved; missing owned files restored; disabled files parked; local modifications and path aliases refused. |
| Settings account and login HTTP flows | Real local HTTP server and encrypted SQLite vault; simulated provider | Account addition and UI code submission reached Ready. Responses exposed only saved-secret summaries; editing metadata preserved the original credential. |
| Configuration and Rigging HTTP flows | Real local HTTP server and installed APM | Import preview changed no stored revision; apply used compare-and-swap and stale saves returned 409. A submitted local skill reached the isolated account home and was parked when disabled. |

Repeat live adapter checks after building:

```sh
node scripts/spikes/codex-adapter.mjs --root "$HOME/.jevellan-build/live-home" --account acc_test --mode smoke
node scripts/spikes/codex-adapter.mjs --root "$HOME/.jevellan-build/live-home" --account acc_test --mode interrupt
node scripts/spikes/codex-adapter.mjs --root "$HOME/.jevellan-build/live-home" --account acc_test --mode safety
node scripts/spikes/codex-adapter.mjs --root "$HOME/.jevellan-build/live-home" --account acc_test --mode isolation
```

The commands print only normalized outcomes, event kinds and boolean checks. The isolation bridge is a fixture; actual Basic Memory integration remains phase 2 work. `tests/runtime-adapters.test.ts` uses deterministic CLI fixtures and must never be labelled live provider evidence.

The first Safety probe marker was too broad: Codex's startup git inspection triggered it. The corrected fixture records only calls containing `push`; ordinary startup reads use the system git executable. The corrected probe passed.

Native MCP events include nullable error and result fields that differ from the SDK's declared types. Two isolation attempts exposed that validation mismatch. The schema and fixture regression were corrected; the next live production-adapter check passed. The full seven-part matrix now passes for both production adapters using the real SDKs and simulated provider CLIs in tests/runtime-contracts.test.ts. It checks interruption, events/usage, continuation, concurrent scoped MCP, read-only policy wiring, Safety denials and descendant termination. Claude native enforcement and authentication remain unproven without its dedicated token.


Additional component evidence:

- **Live Codex project context:** the initial probe did not receive AGENTS.md under an untrusted project layer. Explicit first-turn context delivery fixed it. The rerun returned the marker, did not execute the project-local hook, and left no owned process group.
- **Installed native controls, no model:** scripts/spikes/codex-native-controls.mjs confirmed exact trust for a path containing dots, disabled project configuration, successful read and writable positive controls, and denied shell/Node writes in the read-only sandbox. The probe must run outside an enclosing sandbox that would also deny the positive controls.
- **Live Codex termination:** a fixture launched a child and grandchild in groups beyond the original worker group. The initial group-only cleanup left them alive. Ancestry tracking and start-identity checks fixed the defect; the rerun confirmed both fixture processes gone before its own cleanup. The enhanced interruption check also passed before same-session continuation.
- **Account shutdown:** outstanding credential-replaced probes and model discovery are drained before closing storage; late results cannot write readiness after shutdown.

Repeat the added live checks with --mode project and --mode terminate using the same explicit isolated home above. Contract fixtures perform harmless commands; simulated command denial is not a substitute for native permission evidence.
