# Scoped GitHub activation, 13 October 2026

Evidence: **live**. Decision 767 supersedes the pending approval in decision 764.

The owner approved the exact prepared GitHub classic token grant: repo and workflow, expiring 12 November 2026, stored for the Jevellan live sandbox and Ekoa projects. GitHub generation and both Jevellan Settings saves complete. The default credential remains unset. The token is held only in the encrypted vault; temporary UI/clipboard copies are cleared. Screenshots of the saved entries stay in the private owner-helper folder, without token values.

At 09:37 UTC, a read-only preflight opens the hub database read-only, decrypts only each approved scoped envelope in memory and uses the actual Jevellan GitHub client. No token is printed, placed in command arguments or saved in plaintext. The sanitized receipt is `/Users/ggomes/.jevellan-build/loop-owner-2026-10-11/github-scoped-check-2026-10-13.json`.

| Repository | Observed result |
| --- | --- |
| gongiskhan/jevellan-live-sandbox | Seven successful reads: main commit, PR list, Checks, statuses, workflow runs, jobs and NIGHTLY_SCHEDULER. Main is 61fc71a; zero open PRs; baseline has no checks. Scheduler remains jevellan. |
| gongiskhan/ekoa-code | Seven successful reads plus the expected scheduler-variable 404: main commit, PR list, PR208, Checks, statuses, workflow runs and jobs. Main is 82e7fb4; PR208 head 187ed029 is open/unmerged with result passing. NIGHTLY_SCHEDULER remains unset, so watch mode stays. |

The client tracks a 5,000-request limit with 4,871 remaining at the end. These fifteen reads prove the listed read capabilities. Workflow dispatch, PR creation/merging and live coordinator bridge calls remain **not run**; they are not inferred from token scopes. No Ekoa CI, variable, branch, PR merge or automatic-merge setting changes.

Member enrollment/sign-in, retained Ekoa checkout work, Ekoa MCP authentication, dedicated live-test credentials and formal provider scenarios remain **blocked**. The ten-hour scenario clock has not started. The current harness expects a shared token when resetting to a fresh logical project; preserve the approved project-only scope and resolve that harness compatibility before running scenarios, rather than populate the default credential. No additional review or repeat full suite runs for this operational checkpoint. Owner acceptance is not claimed.

Opening Add a device unexpectedly creates an invitation immediately rather than a preparatory form. Close the panel and expire only that just-created, unconsumed invitation with an optimistic revision check. Live readback confirms it is expired, unconsumed and the registry still contains only the Pro. No persistent member token is issued. Member connection still needs its separate action-time confirmation. No join code is copied into evidence.
