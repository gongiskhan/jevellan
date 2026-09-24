# Jevellan build and acceptance report

Last updated: 2026-09-24. Build in progress. This report does not claim Gonçalo's acceptance.

## Current state

- Committed: local phase 0 and phase 1 checkpoints on main; public push is blocked below. Phase 1 is in progress.
- Built: the workspace compiles with TypeScript and Vite. Phase 1 adds versioned schemas, isolated homes, SQLite configuration revisions, AES-256-GCM secrets, account eligibility/ranking, runtime workers and factories, login drivers, provider probes, APM Rigging delivery, environment filtering and redaction. The HTTP backend now supports passphrase sessions, account and login operations, model discovery, configuration history/import/export, secret summaries and Rigging edits.
- Installed: no Jevellan service or application installed.
- Running: no persistent Jevellan daemon.
- Tested: typecheck and lint pass; Vitest passes 131 tests in 14 files; Playwright passes 4 skeleton checks (desktop/phone, light/dark) using a disposable data home. Live Codex production-adapter text/tools/usage, continuation, interruption, per-launch Safety, concurrent scoped bridges and explicit token refresh passed. Native read-only command denial, isolated Basic Memory configuration, actual APM skill delivery and owned process-group cleanup passed. HTTP tests cover authenticated settings, secret masking, stale revision rejection, simulated provider login and actual APM delivery. See [runtime evidence](phase1-runtime.md). These checks do not establish completed product journeys.
- Accepted by Gonçalo: not requested or claimed.

## Phase progress

| Phase | State | Evidence and remaining work |
| --- | --- | --- |
| 0 Orientation and skeleton | Local checks complete; external checks blocked | Skeleton, reference map, SDK selection and capability limits recorded. Public creation/push and Claude live checks blocked. Phase 0's partial Codex prefix rules were replaced by the tested phase 1 hook. |
| 1 Core and runtimes | In progress | Backend foundations, adapters and account/configuration/Rigging APIs implemented. Full contract matrix and Settings UI still required. |
| 2 Conversations and memory | Planned | Durable work, verification/publication, memory bridge and UI. |
| 3 Decisions | Planned | Real Jev wire client, questions, resolution, corrections and manual fallback. |
| 4 Mesh | Planned | Hub API, device login, owner proxying, switch tokens and external sessions. |
| 5 Installation | Planned | Versioned copies, services, update/rollback, doctor, uninstall and first run. |
| 6 Improver | Planned | Routing suggestions, saved cases, memory care and context suggestions. |
| 7 Hardening | Planned | Complete browser matrix, journeys, crucial review and final full verification. |

## Blockers and attempts

| ID | Blocked check | Reason and attempts | Work that can continue |
| --- | --- | --- | --- |
| ENV-JEV | Live Jev smoke, routing evaluation and Jev-dependent journeys | JEVELLAN_TEST_JEV_KEY is absent at preflight and build start. Only presence was checked; no value was logged. | Real request builder and deterministic fixtures; manual mode. |
| ENV-CLAUDE | Live Claude transport, Claude acceptance and SDK vision checks | JEVELLAN_TEST_CLAUDE_TOKEN is absent at preflight and build start. Native Claude credentials must not be used. | Transport implementation, protocol fixtures and explicit skipped live cases. |
| GH-AUTH | Public repository creation and pushes | GitHub user API returned HTTP 401 at preflight. The build-start API probe and a separate stored-authentication probe also failed; neither GH_TOKEN nor GITHUB_TOKEN is overriding the stored login. No repository or visibility was changed. | Commit locally on main; retry only when authentication state changes. |
| BASELINE-DRIFT | Exact comparison to the preflight Garrison status | HEAD is still fa5c9277e2bc4e873699c925c0047186ef90f03f. Before any build operation, status changed from up-to-date to behind origin/main by one commit. Existing modified and untracked paths match. The original baseline is preserved at ~/.jevellan-build/garrison-baseline.txt; a separate build-start snapshot is ~/.jevellan-build/garrison-build-start-2026-09-24.txt. Restoring the remote-tracking ref would modify Garrison and is forbidden. | Compare against both snapshots and report any further drift without changing Garrison. |
| DEVICE | Live second-device journeys | JEVELLAN_TEST_SECOND_DEVICE is unset. Tailscale is running. No remote device was selected or modified. | J8/J11 may use an explicitly simulated second daemon, as the specification allows. |

The prepared Codex test home was moved, never copied, to `~/.jevellan-build/live-home/homes/codex/acc_test`. Its login worked in the live SDK checks. No credential value or native session identifier appears in the evidence. Claude's native AGENTS.md behavior remains unproven because its dedicated test credential is absent.

## Decisions taken during the build

1. Use port 9771 by default. Garrison's documented ports are 8777, 5777, the 80xx range, 9512 and profile offsets of 10000/20000. The installer will choose the next free port without killing any listener.
2. Use TypeScript project references for the npm workspaces. Each package compiles to its own dist directory; the web application uses Vite and React.
3. Pin TypeScript to 5.9.3. The first dependency resolution failed because the current TypeScript 7.0.2 exceeds typescript-eslint's supported range. Do not bypass peer-dependency validation.
4. Treat Garrison instructions as reference-project context, not authorization to operate its services, native homes, shared memory or checkout. Jevellan's specification overrides those instructions.
5. Preserve the preflight baseline and record the already-changed build-start status separately. Never rewrite history or the original evidence to manufacture a match.
6. Retain the Codex SDK. Points 1–4 of the transport spike passed. The dedicated Jevellan MCP bridge uses per-launch `env_vars` and `default_tools_approval_mode = "approve"`; its own token scopes enforce permissions. The initial `auto` setting prevented unattended tool calls, so it was replaced and the concurrent test rerun successfully. Tokens are never configuration arguments.
7. Run SDK execution inside a separate owned worker process group. The SDK itself does not expose enough process ownership information for complete descendant cleanup. The local cleanup test proves the wrapper primitive; full adapter cleanup remains a contract-test requirement.
8. Pin Basic Memory to the installed and probed 0.22.1. Its configuration override and project-constrained resolver were tested using an isolated temporary configuration directory.
9. Claude read-only launches deny all shell tools as well as editing tools through PreToolUse. Read tools and scoped bridge calls remain available. This avoids pretending a prompt or bypass-mode allowlist enforces read-only access. Live confirmation remains blocked.
10. The phase 0 Codex rule parser passed 19 exact forms but missed four common variations; its live model made no tool call. Phase 1 uses the current hook interface for the shared command guard, as recorded below. Arbitrary programs and unsupported native tool paths remain outside its coverage.
11. Use Node's built-in SQLite API, with WAL and immediate transactions for revision checks. This avoids a native add-on dependency. Node 22.13 (or 23.4) is the minimum unflagged version, so package engines and the executable check those versions. The test machine has Node 22.22. SQLite remains experimental in Node 22; its warning is retained. See the [Node version history](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html).
12. Keep seed models disabled until runtime discovery confirms exact model ids and supported efforts. The seed descriptions are the brief's editable defaults, not claims about a discovered model's current pricing or capability.
13. Preserve encrypted data when the key is lost: refuse to initialize a replacement key for a populated vault. Authentication tags bind each encrypted secret to its id. Browser-facing summaries contain only saved state and a masked suffix.
14. Set HOME as well as the runtime-specific home variable to the isolated account home for agent processes. This also confines secondary CLI caches and prevents ordinary home-directory discovery from reaching the user's native setup.
15. Stage APM output under Jevellan before delivering it to account homes. Check ownership hashes before replacing or parking files; preserve loose and externally edited files. A matching fingerprint is insufficient if an owned file disappeared. Keep staging packages available because generated hooks can reference them.
16. Use node-pty and a headless terminal for UI-driven login. Terminal cells preserve cursor-rendered separators and soft-wrapped tokens; stripping ANSI text does not. Tokens go directly to the encrypted vault callback. The installation prepare step repairs node-pty 1.1.0's missing macOS helper executable bit in this installation only.
17. Current Codex supports PreToolUse hooks. Its [documented automation flag](https://learn.chatgpt.com/docs/hooks) enables the per-launch hook without persisting a trust record for each stretch. A small CLI shim adds that flag while retaining SDK execution and sandbox controls. Project-local configuration is marked untrusted; Jevellan's account Rigging and per-launch hook are the controlled sources. The native live hook probe and a reordered git-push denial passed. This replaces reliance on prefix rules for the ordinary command forms and permits the integration-only rebase exception in the hook.
18. Implement the UI passphrase prerequisite with the first Settings APIs. Scrypt uses a random salt; device-bound signed sessions last seven days and logout revokes the session. Cookies are HttpOnly and SameSite=Strict. HTTPS/Tailscale listener integration remains phase 4 work. Browser test servers always use disposable data homes.
19. Credential replacement creates a new encrypted secret reference and invalidates outstanding probes. A late authentication failure for the previous credential cannot overwrite readiness for the replacement. An unavailable usage query preserves previously confirmed authentication while marking usage unknown. Codex API keys are checked against the provider; ChatGPT probes request an explicit native token refresh, as described in the [app-server authentication contract](https://learn.chatgpt.com/docs/app-server).
20. Local and package Rigging selections are revisioned hub documents. APM delivery combines these selections with the configuration's APM dependencies. Safety is a locked built-in row whose hook is supplied at launch; it cannot be disabled or edited. Full loose-item discovery and the Project memory item remain later Rigging work.

## Definition of done audit

| Section 20 item | State | Required authoritative evidence |
| --- | --- | --- |
| 1 Typecheck, unit/integration/contract and browser suites | Incomplete | Passing commands with live and skipped portions distinguished. |
| 2 J1–J13 acceptance evidence | Incomplete; live credential blockers above | docs/acceptance/J1.md through J13.md, receipts, screenshots and redacted records. |
| 3 Fresh install, uninstall and purge | Incomplete | Packed-tarball test in a temporary HOME and fake service-manager evidence. |
| 4 No repository/log/ledger/fixture/screenshot secrets | Incomplete | Scanner regression tests and final repository plus evidence scan. |
| 5 Garrison and native Basic Memory preserved | Original status comparison blocked by pre-existing drift | Read-only HEAD/status comparison and isolated-home test evidence. |
| 6 Public repository; no other visibility changes | Blocked by GH-AUTH | Before/after owner visibility lists outside the repository. |
| 7 Main committed and pushed without attribution | Incomplete; pushes blocked by GH-AUTH | Commit history, branch and remote verification. |
| 8 Honest final acceptance report | In progress | This report completed, with build/install/run/test/acceptance separated. |
| 9 Every operability regression covered | Incomplete | Regression mapping in reference-map.md and behavior test results. |

## Acceptance journeys

J1–J13 have not run. Their implementation remains planned. No simulated journey is claimed as live and no unimplemented feature is classified as an environmental blocker.

## Next work

Build the Settings UI against the tested APIs and finish phase 1's contract matrix. Keep live provider evidence, actual local tooling and simulated fixtures separate.
