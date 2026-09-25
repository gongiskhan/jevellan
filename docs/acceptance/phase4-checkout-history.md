# Recorded checkout history

**Live:** local Git, HTTP, SQLite, isolated homes and owned test processes. **Simulated:** provider responses, native-agent journals and coordination delays. These checks do not establish successful live Jev classification or cross-machine acceptance. Phase 4 remains in progress.

A quiet outside session and a clean working tree do not prove that every commit belongs to Jevellan's work. The service now reconstructs the expected HEAD from the work's immutable base and its versioned checkpoint, integration, undo, context and settlement records. An unexplained commit blocks another writing step, publication or discard while preserving the checkout and its ownership. A commit introduced during publication coordination is checked again immediately before pushing.

Context operations without a stretch number use their existing recorded before/after commits. A validated published undo can preserve unrelated newer commits; its recorded result establishes the next boundary. An applied discard whose final result was lost can recover only when the clean checkout is at the original base and that conversation's exact saved discard ref still points to the recorded prior HEAD. Recovery does not reset the checkout twice.

The check is separate from the in-progress integration guard: a tracked rebase may temporarily change HEAD before its integration receipt is written. Its completed receipt is recovered and checked before publication. This adds no new stored document, routing heuristic or native-home mutation.

## Verification

- Four regression cases initially failed against the prior implementation in **17.82 seconds**, reproducing accidental inclusion or removal of an outside commit during writing, publication, discard and a pre-launch Retry after activity became quiet.
- The first compile found an optional context narrowing error; an explicit context-presence check corrected it. Typecheck and lint then passed.
- The initial broader integration run passed nine selected cases and failed one restored-history fixture. The new launch check correctly prevents creating an unexplained gap through a new writing step, so the older undo regression now restores versioned historical events directly. Explicit `undefined` fields in that fixture were rejected by durable JSON validation; deleting those absent fields fixed the fixture.
- The final focused run passed **12 scenarios in three files in 58.91 seconds**, with 115 unrelated cases excluded by the name filter. It covers outside commits at writing/publication/discard, pre-launch Retry after the journal is quiet, commits introduced during ordinary and reverted publication coordination, legacy unexplained history, completed-discard recovery and context checkpoint/review recovery. Final typecheck and lint passed.
- The expanded full backend suite completed in **953.20 seconds**: **680 passed, two failed and one missing-key live test skipped**, across 50 files. The queued-composer fixture exceeded its one-second startup polling budget; it now awaits the actual runtime-start signal. The older external-policy fixture still expected review to be unavailable, although the connected activity flow now deliberately supports acknowledgement without Git mutation. It now verifies stale-review refusal followed by acknowledgement, preserving exact refs, the working state, the remote tip and file contents. No product code was changed for these two corrections.
- Both corrected fixtures passed in **8.82 seconds**, with 111 unrelated cases excluded by the name filter. Typecheck, lint and production build passed. This focused correction does not turn the preceding full run into a clean full-suite result.
- The complete subsequent browser matrix passed **68 workflows in 7.5 minutes**, across desktop/phone and light/dark layouts. That run used the saved recorded-history build; owner routing was being added separately in source and is not covered by this browser result.
- Full-history/worktree secret scanning and whitespace checks passed. Work remains on main and BRIEF.md remains ignored. No unchanged commit-approval or GitHub-authentication retry was attempted.

## Remaining work

Automatic continuation at a disconnected hub boundary, periodic configuration/APM synchronization, remote provider-login UI, device/header UI, network listeners and complete two-daemon J8/J11 remain implementation work. Owner routing followed in [a separate checkpoint](phase4-owner-routing.md). Successful Jev classification, Claude live/vision, commit approval and GitHub publication retain their separately recorded blockers. The existing private preview returned HTTP 200 during this checkpoint; its recorded pages have not been replaced with these changes.
