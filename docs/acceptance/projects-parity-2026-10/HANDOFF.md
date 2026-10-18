# Projects parity handoff

## Owner steps

1. No owner command or sign-in will clear the current build failures. Release 0.5.0 remains held; the existing installations have not been upgraded.
2. The optional compatible-endpoint credential requested in phase 8 is still absent. LP8 can remain blocked. If you provide it in a later run, enter it in Settings, never in chat.
3. After a verified release is installed, the physical iPhone notification check is yours: add Jevellan to the Home Screen from Safari, turn notifications on in the installed app and check a test notification. That acceptance has not been claimed.

## Current result

P0–P9 are pushed with their affected backend and four-layout browser evidence. P10 documentation, cleanup and reproduced closing regressions are implemented. The final full runs have failures; focused reruns are kept separate. Source is still version 0.4.1. There is no published or installed 0.5.0 release, and its three-hour live clock has not started.

The current build deadline is 2026-10-18T04:59:21Z. This handoff is being completed within that clock; the closing source commit is `7763e0c254ae7ad064f1ad5993abcd9595415c8e`. Test work stopped at04:33:56Z to retain closing/push time.

## Release blockers

- The final backend attempt records2,334 passed and17 failed before interruption; its remaining count is unknown. It contains Conversation timeouts and old snapshot/fixture failures. Updated snapshots and request synchronization have focused passing reruns; that is not a clean full-suite result.
- LJ5 still fails in the concurrent four-layout run. Captures show correct earlier fix merges and exact-commit suite/deploy gates, but later stages miss their unchanged waits.
- The full browser matrix records212 passed,29 failed,2 interrupted and133 not run of376, exposing legacy Conversation, mesh and memory-care failures. Preserve those assertions and investigate them individually.
- Dedicated vision is not run without its documented test credential. Direct screenshot inspection is separate evidence.
- Pro's unchanged installed 0.3.6 hub becomes unresponsive. A maintenance-gated restart briefly passes health, then later loopback and HTTPS requests time out again. Sustained readiness is unconfirmed. No new release caused this observation.

## Continue here

1. Use the final full-run failure list and receipts under phase-10/. Reproduce each remaining case, fix actual defects, and retain the existing assertions and deadlines. Run the full backend and browser suites again after fixes.
2. One closing serious-issues pass has run; see phase-10/closing-review.md. Do not add an interim review phase.
3. Only after the release gates pass, bump source and workspace versions to 0.5.0, rebuild both archives, run their actual CLI/native-PTY probes and scan normally before publishing. The retained private candidates are unpublished probes with incomplete final documentation.
4. Take a fresh full cold Pro snapshot immediately before activation. Preserve the exact service and command. The earlier APFS rollback is retained privately but predates the restored service's later activity.
5. Update only Pro and its actual members. Madrid's separate 0.4.1 hub and default CLI are outside this run. Its Pro member needs `install --name member` adoption of its legacy home before managed updates. Preserve its exact old unit/home and the independent hub fingerprints. Mini remains apps-only; keep its app files and original URLs. Those app URLs already returned errors before any update in this run.
6. Ensure all participating devices are on 0.5.0 before using the new features. Start the live clock at actual activation and run LP1–LP9 only in the sandbox, restoring every changed setting. Never use ekoa-code for these journeys.

No real sandbox journey, owner acceptance or new test pull request is claimed. The dedicated Madrid sandbox clone is prepared but has not been registered through the owner UI.
