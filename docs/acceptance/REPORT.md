# Jevellan build and acceptance report

Last updated: 2026-09-24. Build in progress. This report does not claim Gonçalo's acceptance.

## Current state

- Committed: the phase 0 checkpoint is ready for its first local commit; public push is blocked below.
- Built: the workspace compiles with TypeScript and Vite.
- Installed: no Jevellan service or application installed.
- Running: no persistent Jevellan daemon.
- Tested: typecheck and lint pass; Vitest passes 8 tests in 3 files; Playwright passes 4 skeleton checks (desktop/phone, light/dark). Live Codex SDK text/tools/usage, continuation, interruption and concurrent bridge isolation passed. Native read-only command denial, isolated Basic Memory configuration and owned process-group cleanup passed. These checks do not establish completed product journeys.
- Accepted by Gonçalo: not requested or claimed.

## Phase progress

| Phase | State | Evidence and remaining work |
| --- | --- | --- |
| 0 Orientation and skeleton | In progress | Skeleton checks pass. Codex SDK retained after live checks; Safety spike and remaining reference reads continue. Public creation/push and Claude live checks are blocked. |
| 1 Core and runtimes | Planned | Schemas, accounts, vault, configuration, Rigging and runtime contract tests. |
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

Finish phase 0 reference mapping and Safety transport checks. The verified skeleton is ready for a local checkpoint. Then implement phase 1 without treating unavailable live checks as passes.
