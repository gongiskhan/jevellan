# Pilot handoff · 25 September 2026

The user requested a short readiness check and a usable pilot, ending the prolonged build. Remaining implementation is deferred for later sessions. This is not section-20 completion or user acceptance.

- **App:** https://goncalos-mac-mini-1.tail31efa.ts.net:9444/
- **Recorded screens and real Codex demonstration:** https://goncalos-mac-mini-1.tail31efa.ts.net:9443/#screens

The passphrase and provider accounts have since been configured by the user. The setup instructions and initial pilot observations below describe the original handoff; see the deployed workflow repair section for current status.

## Start trying it

1. Open the app while connected to Tailscale and choose your passphrase. The browser is already open at that page.
2. The dedicated Codex sign-in and **Jevellan sandbox** project are prepared. Native agent accounts and homes were not used. The sandbox is `/Users/ggomes/dev/jevellan-sandbox`.
3. Add a Jev key in Settings to try automatic decisions. Without it, use **Pick the next step**, select Reply or another action, and Continue. The existing welcome conversation asks for a read-only explanation of `src/sum.ts`.
4. Open **Why** to inspect decisions, and the stretch timeline and handoffs to see work and results. Judge quality still needs a live trial.

## What was checked

| Area | Evidence | Limit |
| --- | --- | --- |
| Conversations and stretches | Earlier **live** Codex answer, implementation, handoff, independent tests and local Git publication; recorded in J1/J2 and the progress report | Manual action/model selection |
| Automatic decision loop | Three focused regression cases passed in 14.23 seconds: implementation decisions, read-only reply closure and stale classification cancellation | Judge responses **simulated** |
| Pilot | Frozen phase-5 copy builds; actual adapters enabled; dedicated Codex readiness probe passed; HTTPS setup page verified in Chrome | Fresh reply **not completed / not rerun**, as explained below |
| Wider application | Earlier full browser matrix: 116 passed; current workspace typecheck passed | No fresh full-suite pass or final acceptance claim |
| Phase-6 backend | 127 application/member API tests passed in three files; separate 30 revision/store/job tests passed | Providers simulated; later small changes and UI not broadly retested; excluded from pilot |
| Judge | Missing Jev test key and no pilot vault key | Successful live classification and result quality **not verified** |

The first fresh pilot reply stopped before starting a stretch: moving the dedicated account omitted its prior Rigging ownership record, so the guard preserved `hooks.json`. The prior record was restored only after its recorded hash matched the moved file exactly. The running daemon's normal synchronization then reported successful delivery. No daemon restart or code change was needed. The initial failed readiness receipt is preserved; the reply has not been rerun after this repair because first-use passphrase setup is left to the user. Its old blocked notice remains visible until the next explicit attempt.

Final handoff checks: the repository secret scan and whitespace check passed. Both Tailscale URLs returned HTTP 200. Garrison HEAD and its latest recorded status still match; the original baseline status differs only by the already documented upstream drift. Main and the 660-file staged checkpoint were preserved.

## Running copy and deferred work

The pilot now runs independently of the checkout from `~/.jevellan-build/pilot-workflow-fix-2026-09-25/app`, preserving isolated state in `~/.jevellan-build/pilot-2026-09-25/home`. The existing dedicated Codex home was moved, not copied, into this home. Process and HTTPS receipts are saved alongside it. Loopback port 9773 is exposed only through the recorded Tailscale HTTPS port 9444; existing Tailscale routes were compared and preserved. This detached process has no persistent OS service, so automatic startup after reboot is not configured.

The pilot uses the staged phase-5 source snapshot. Unfinished phase-6 suggestion UI, memory/context jobs, complete J10/J12 journeys, broader final checks and the final crucial-issues review are deferred. The older full backend run had 973 passes, three test-boundary failures and one missing-key skip; affected cases passed after fixture corrections, but no replacement full-suite pass is claimed.

The user has now explicitly authorized commit and push. The public repository has been created using the authenticated browser, and SSH authenticates as gongiskhan; the expired gh login has not been changed. Automatic approval review previously rejected committing the prepared checkpoint, citing the earlier preflight-only scope; the staged work is preserved and the rejection was not bypassed. Garrison and native homes remain protected. The separate original build goal is paused and must not automatically resume deferred work.

Post-handoff issue: [Claude sign-in recovery](login-recovery-2026-09-25.md) records the login fix and its focused verification. The user approved the restart, and the patched copy is live at the same URL with accounts, passphrase and conversation ledgers preserved.

## Workflow repair deployed — 2026-09-25

See [the workflow repair report](workflow-repair-2026-09-25.md). The independent build fixes Claude tool discovery and an activity metadata timeout, adds real progress feedback, simplifies the conversation UI and allows browsing project folders. Sixteen responsive browser checks passed. The user explicitly authorized redeployment after removing the daemon restriction. After an earlier filesystem-blocked attempt made no service changes, the current approval review allowed activation. Deployment succeeded at 19:50 UTC, preserving all accounts, authentication data, projects and conversation ledgers. The Todo app project is available; its real-account run is in progress with successful Jev classification and Claude execution.
