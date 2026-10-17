# Phase 3 regressions observed before repair

All cases below are simulated. Provider turns and GitHub replies use disposable fixtures; git, HTTP, ledgers and the browser are real local processes. Raw logs remain outside the checkout because they contain disposable session identifiers. This file keeps sanitized assertions and source pointers.

| Test or journey | Before repair | Repair and verification |
| --- | --- | --- |
| Overview grouping, `tests/projects-parity-overview.test.ts` | `boardGroup` was unavailable. | Ordered core rule covers every state, resolution and landing value. |
| Saved-work Publish | `fixable.publish` was absent. | Owner-local facts feed a fresh indexed event; Publish uses managed verification and publication. |
| Inactivity resolution | `autoResolve` was unavailable. | Injected-time checks cover the seven-day boundary and an idle thread whose open PR must remain unresolved. |
| New comments during the request cache window | Expected1 pending comment, got0. | A remote update remains eligible for a read after the cache expires. |
| Accepted Publish after restart | Retrying an accepted request with an unfinished HTTP receipt returned409. | The pending-turn write retains the accepted request digest atomically; retry returns the existing work. |
| A failed review-comment read | The `checks-failed` event was absent after an injected reviews500. | Comment-read failures retain the ordinary PR state/event path. An initial string error matcher was invalid; the corrected regular-expression case also failed before repair. |
| Large comment batch | Expected501 pending comments, got500. | Bounded paginated reads retain the full batch; owner delivery advances the cursor and retains bounded delivered ids. |
| Fix checks on a stopped thread | The request returned200 but no next turn ran. | The owner action uses the existing same-thread continuation before queuing its turn. |
| Recently resolved thread in the coordinator's all list | Expected the resolved thread, but it was absent. | The recent-history rule includes resolution time. Active lists still omit it. |
| Header action layout, `PAR3 header action rows stay separate on narrow screens` | The bounding-box assertion found Session/Stop buttons intersecting Resolve. | The new owner actions have their own header row; the same assertion passes. |
| Overview group dots | Ready for review and Working had the same computed dot colour. | Group colours use the existing theme tokens; the colour assertions pass. |
| Current hold metadata | The thread view omitted the current nightly hold. | Cards use the already-polled daily view; the thread view supplies current hold metadata. |
| Hub unavailable while reading hold metadata | Reading the local thread returned503 instead of its reports. | Optional hold metadata may be unavailable while local thread content remains readable. Merge operations retain their existing backend fence. |
| Existing running-thread browser journey | The report summary matched twice in the transcript DOM. | The collapsed preview and expanded body are rendered exclusively; rerun checks both disclosure states. |

The initial resolution fixture supplied one choice where reports require two to four; it was corrected before its valid action assertions. The first PAR3 setup waited for unrelated global activity and was stopped. It now waits, with a deadline, for its own preparation thread. An early matrix was stopped after manual visual inspection found the header overlap; those interrupted tests are not counted as passes. One broader backend expectation needed the newly returned GitHub update timestamp; its exact result assertion was extended and its suite rerun.

The first phone-light matrix stopped after four passing journeys because a concurrent focused run reused its Playwright output directory and removed active trace files (ENOENT). This was a builder test-run collision, not a product verdict; the affected journeys are rerun with separate output folders. An added settled-history assertion passes without a product change: the earlier Overview screenshots captured Loading chat before replay finished. Both Overview captures now wait for history before taking evidence.

The subsequent isolated-output parallel runs exposed two harness boundaries: a pending intercepted daily read was fulfilled after reload cancelled it, and PAR2 cleanup used the15-second default HTTP timeout although owned-process termination allows10seconds of grace plus10seconds to confirm exit. The hold capture now installs interception on a blank page and waits for handlers before removing it. Cleanup allows60seconds and now also asserts the stop response succeeds. The functional Undo request returned200/revision3/value20; a trace of a polling retry seeing2 is not an Undo failure. These are test-harness repairs, not product-fix claims.

The later dark capture hit ECONNRESET in the interception's extra route.fetch call. The hold-only UI fixture now fulfills a schema-validated daily snapshot directly, so it does not add another network read. The held and released Merge assertions stay; real dynamic hold behavior is covered by the backend cases.

Under parallel fixture load, PAR3 navigated to controls before the workspace bootstrap finished (the failure snapshot showed Loading your workspace). The journey now prepares its fixture while the page is blank and explicitly waits for the project heading within the existing60-second bound before using the tabs. This retains the tab/action assertions and avoids treating workspace initialization as an absent control.
