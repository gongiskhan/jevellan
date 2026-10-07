# Codex subscription usage — 2026-10-07

The Runtimes page could authenticate a Codex subscription but showed both usage windows as unknown. The subscription probe read `account/read` and never requested usage. It now also reads `account/rateLimits/read` from the same isolated Codex app-server process. The existing account service persists the result and the existing Runtimes page displays it. No owner acceptance is claimed.

## Behavior

The reply is validated with zod. The explicit `codex` bucket takes precedence over the legacy single bucket; a bucket explicitly belonging to another limit is not displayed as Codex usage. Windows are matched by their duration: 300 minutes for five hours, 10,080 minutes for a week. Primary can be weekly, so position does not imply duration. Missing or unrelated windows stay unknown; zero remains zero. Missing resets remain absent, and utilization above 100 is capped at 100. Invalid or unavailable quota data keeps a successful authentication check ready and returns a bounded message without provider error details. API-key account checks are unchanged.

Source contract: [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server), `account/rateLimits/read`, `usedPercent`, `windowDurationMins`, `resetsAt` and `rateLimitsByLimitId`. Decision 605 in [REPORT.md](REPORT.md).

## Verification

- **Simulated:** the 16 new native-protocol regression cases use a temporary fake executable and isolated homes. Before the fix, ten failed and six passed. After the fix all 16 passed. The focused account regression command passed **92 tests in five files**, with no failures or skips: `npm test -- tests/codex-usage.test.ts tests/login.test.ts tests/account-service.test.ts tests/accounts.test.ts tests/mesh-accounts.test.ts --maxWorkers=1`.
- **Simulated:** `npm run test:e2e` selected the new Codex usage journey in desktop light and phone dark, one worker, installed Chrome: **2 of 2 passed in 32.6 seconds**, no skips or flakes. The fixture account response supplies a weekly window, first 0% then 37%, and no five-hour window. Assertions cover both percentages, the reset, the observation timestamp, unknown five-hour usage and page width. It verifies the display independently of the native-protocol tests; it is not a live provider browser test.
- **Passed:** `npm run build`, `npm run typecheck`, `npm run lint` and the frozen release's `npm ci` prepare build. Final secret scanning covers history and the working tree before push.
- Earlier browser harness attempts did not exercise the journey: an anchored selector selected no tests; default Chromium was not installed; the temporary configuration initially started its servers from the wrong directory. The successful run uses installed Chrome and sets the fixture server directory explicitly. No assertion or product configuration was weakened. Private failed and successful logs remain outside the checkout.
- **Not run:** a newly authenticated browser session on the live pilot, a new automated vision check, runtime model turns or Projects work. The available Chrome session required sign-in and the in-app browser was unavailable to the automation tool. Existing historical vision evidence was preserved.

## Live deployment

The existing pilot now runs the fix from `/Users/ggomes/.jevellan-build/pilot-codex-usage-2026-10-07/app/`, a frozen archive of `7f9204f` with the three code/test changes overlaid and hashed in a versioned private source record. The source checkout is not the running installation. The launcher keeps the same data home, loopback port 9773 and tailnet origin. It performs one normal account check for each enabled Codex subscription after application startup, so the usage is immediately refreshed without a model turn or a new login.

The idle dry run initially refused because the daemon had child processes. Inspection identified persistent Basic Memory MCP servers owned by the daemon; the switch permits those idle servers, which normal application shutdown closes, while still refusing other child processes, admitted lifecycle work or Projects state. The successful dry run confirmed ownership and held the exclusive lifecycle gate. Activation held maintenance through SIGTERM and the old daemon's exit; no forced stop was used.

At 10:52:29 UTC the old daemon was stopped; it exited at 10:52:29.911. The new daemon started at 10:52:29.932. At 10:52:36.507, local and tailnet health both returned 200 and the persisted account status freshly reported **ready**, source **probe**, a weekly percentage and reset, and no five-hour window. The live Codex bucket reports only the weekly window. This check used Jevellan's existing isolated account authentication, never the user's native provider credentials. No raw quota reply, identity, token or session identifier was copied into this report.

Preservation passed: all **185** hashed conversation, login-request, vault-key and configuration files were identical; encrypted vault rows, configuration revisions and requests, registered projects and account definitions were identical. Account identity and status can be updated by the normal check. Old hashed browser assets were retained in the new release for already-open tabs. The existing Tailscale route was unchanged. The previous release remains untouched and available for rollback; private versioned snapshots and activation events stay beside the new release.

The single end crucial-issues review traced provider parsing through account persistence, eligibility and the Runtimes display, checked failure behavior and deployment preservation, and found no crucial issue. No second review was needed.
