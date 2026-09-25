# Hub outages during undo and redo

**Live:** local Git, HTTP, SQLite, isolated homes and owned test processes. **Simulated:** providers, additional devices and hub outages. This checkpoint does not claim a real second-machine journey or successful live Jev classification.

An admitted correction can now wait while fetching its project, acquiring or transferring checkout ownership, reconciling Git history, preparing undo, applying its recorded plan, or reading the guards before its requested redo. Each wait belongs to the original work and checks the relevant conversation generation before another attempt. The later guard read uses the generation produced by the recorded undo rather than the earlier request generation.

Preparation and application are separate boundaries. Once a plan is recorded, automatic recovery retains that exact plan and its prepared result. A lost reply after applying it is reconciled by the existing Git result checks; it does not create a new plan, reset unrelated changes or repeat a revert. An explicit manual retry retains its existing ability to reconcile or replan a blocked operation. Published undo continues through the existing publication wait before redo.

A lost ownership-transfer reply is reconciled only between the two recorded works in the same conversation, without releasing the checkout. Outside edits, changed history or a changed recovery ref prevent mutation. Cancellation and restart interrupt the continuation and preserve the saved state. Replaying the same correction reads its result without launching another redo.

## Verification

- The initial reproduction failed in **6.80 seconds** after saving the undo recovery ref: it reported the hub outage but had no waiting continuation.
- The repaired reproduction passed in **9.41 seconds**, returning to the exact work base, preserving the original checkpoint, recording undo once and launching the requested reply once.
- The expanded run passed **14 outage scenarios in 123.52 seconds**, with 53 unrelated cases excluded. It covers lost checkout acquisition and same-conversation transfer replies, interrupted planning, preserved saved refs, lost applied results, the guard read before redo, reset/revert behavior, outside files/history/ref changes, cancellation, restart and duplicate requests. Each successful case launches the requested redo once and retains its exact plan.
- A further generation-invalidation case passed in **7.50 seconds**: a new ordinary message remains in the conversation and prevents the stale undo from changing Git or launching redo. Its first fixture attempted Add note while no stretch was running and was correctly rejected with HTTP 400; the corrected fixture uses the normal message control.
- The existing undo/correction regression selection passed **27 cases in 421.44 seconds**, with 61 unrelated cases excluded. It covers published and unpublished undo, code and memory, native conflict integration, later upstream changes, repeated undo, dirty/outside activity, newer work, external Git policy, lost results and restart deduplication.
- The complete hub-wait and conversation-recovery suites passed **10 tests in 5.33 seconds**. The two separately named manual-retry cases passed in **17.81 seconds**, preserving newer outside commits and allowing explicitly resolved files without repeating a completed redo.
- **Eight browser workflows passed in 1.2 minutes** across desktop/phone in light/dark, covering corrections, explicit retry, reload and undo across works. Phone-light undo-across-works and desktop-dark retry captures were inspected. Providers are simulated; Claude vision remains credential-blocked.
- Typecheck, lint and the production build passed. These are targeted backend checks and affected browser flows, not a clean full expanded-suite run or completed section 20 acceptance.
- Final secret scanning and whitespace checks passed. The checkpoint is staged on main; the recorded commit-approval and GitHub-authentication blockers remain unchanged. The fixed Tailscale preview has not been updated with this checkpoint.

## Remaining work

Earlier context operations and cancellation cleanup still need waits. New UI requests, logins and settings writes, periodic configuration/APM synchronization, remote provider-login UI, device/header UI, network listeners and full two-daemon J8/J11 remain phase 4 work. Installation, the improver and final verification remain later phases. The fixed private progress preview is unchanged. Successful Jev classification, Claude live/vision, commit approval and GitHub authentication remain separately recorded blockers.
