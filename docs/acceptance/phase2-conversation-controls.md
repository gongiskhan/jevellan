# Conversation titles and outside outcomes

Evidence: **simulated models with actual HTTP, durable storage, Git repositories, process groups and Chrome**. These checks do not establish live Jev journeys, Claude vision approval or user acceptance. Phase 2 remains in progress.

The conversation heading is editable and its menu contains Rename and Finished outside Jevellan. The heading now includes project, device and state. The outside-finish panel asks the brief's optional question, “What made you finish elsewhere?”, and explains that execution stops while repository changes are kept.

## Durable behavior

Renaming appends a versioned control event, updates the owner projection and hub index, and preserves the exact requests, work, counters, step history and generation. It does not interrupt execution. The request carries the previous title so a stale editor cannot replace a newer title; an identical retry cannot undo a later rename. Titles are trimmed and limited to 200 characters.

Finishing outside first records a versioned intent and invalidates the active generation. The owner stops the operation and confirms process termination before recording completion. An open work closes as closed-by-you, with its request and history intact. Already closed work retains its existing closed outcome. The conversation records finished-elsewhere, the optional reason (trimmed, up to 2,000 characters) and the completion time.

Main-policy changes and unresolved checkout recovery retain the reservation for explicit settlement. Clean unchanged ownership can be released. External-policy files and Git refs remain unchanged, and ownership is released after process cleanup. The finish action does not publish, reset or discard. A writing stretch can still produce its ordinary final checkpoint while stopping.

The existing settlement UI remains available for kept changes. A reopened work can close again even if an earlier settlement was complete; a regression reproduced the previous erroneous conflict before this correction. Publication's temporary reopening preserves the outside outcome and its reason. Starting new work or explicitly reopening through undo clears the current outcome, while immutable control events retain the earlier reason for the future Trial log. That phase 6 UI is not implemented yet.

## Recovery and retries

An intent survives a crash before completion. Startup first performs normal process cleanup and undo reconciliation, then completes the saved finish intent without launching an agent or publishing changes. A failed cleanup or ownership operation remains blocked with Retry finishing; other messages and launches cannot bypass it. A repeated completed request returns current state and cannot close newer work.

Finishing a context conversation cancels its unapplied draft. Startup also repairs a missing context cancellation projection from the completed conversation outcome. The original instruction files and Git refs remain intact, and stale Apply requests are rejected.

## Verification

- Core cases cover renaming waiting/running/closed work without changing generation or requests, stale and repeated names, interrupted finish, historical reasons, and redaction before storage.
- HTTP cases cover renaming with a real process group still alive, optional reasons, main/external interruption, kept checkpoints, release failure and retry after restart, durable-intent recovery, and undo followed by another close. The first release-failure fixture did not actually own the checkout; using an unchanged writing step exercised the intended release path, which then passed.
- The undo-after-outside regression failed with “This work has already been settled.” before the fix and passed afterward in 10.40 seconds.
- The full unit/integration/contract suite passed **411 tests in 31 files in 699.99 seconds**, including startup repair of a missing context cancellation projection. A subsequent publication regression failed because the outside outcome became undefined after publishing kept changes; the discard variant passed. Temporary reopening now preserves that outcome, while explicit undo and new work still clear it. After rebuilding, **21 affected-path cases passed in three files in 196.02 seconds**; 85 unrelated cases were excluded by the focused name filter. That run includes the new Publish and Discard regression, rename, outside cleanup/retry, context recovery, and closed/cancelled settlement.
- Four new browser cases initially passed in 28.5 seconds, followed by 32 workflows in 2.5 minutes. A stronger menu-bounds assertion then reproduced a phone layout bug in both themes: the menu began 182.84375 pixels outside the left edge. The heading now keeps its actions beside the title, with the menu anchored inside the viewport. After rebuilding, the complete **32-workflow browser suite passed in 3.0 minutes** across all four layouts. Four representative refreshed captures were visually inspected; the mandated Claude SDK vision check remains blocked by the missing dedicated token. Final build and affected-path results are recorded in [REPORT.md](REPORT.md).
- Browser assertions check immediate sidebar title updates, expanded tool details surviving rename and SSE refresh, equal left/right edges for long tool headers and bodies, and absence of horizontal page overflow or browser errors. Desktop exercises Publish and phone exercises Discard after an outside finish; both must retain the recorded reason. This ports the remaining visible layout regression from the Garrison operability report.

| Layout | Long title and expanded tool | Optional reason | Recorded outcome |
| --- | --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-controls-title-desktop-light.png) | [Capture](screenshots/phase2-controls-finish-desktop-light.png) | [Capture](screenshots/phase2-controls-outcome-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-controls-title-desktop-dark.png) | [Capture](screenshots/phase2-controls-finish-desktop-dark.png) | [Capture](screenshots/phase2-controls-outcome-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-controls-title-phone-light.png) | [Capture](screenshots/phase2-controls-finish-phone-light.png) | [Capture](screenshots/phase2-controls-outcome-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-controls-title-phone-dark.png) | [Capture](screenshots/phase2-controls-finish-phone-dark.png) | [Capture](screenshots/phase2-controls-outcome-phone-dark.png) |

## Remaining work

Loose Rigging discovery, remaining file/evidence navigation and project-memory presentation, live manual journeys and native integration/lifecycle evidence remain unfinished. Automatic decisions and composer overrides belong to phase 3; the Trial log belongs to phase 6. Dedicated Jev and Claude credentials remain absent, so their live checks are blocked rather than passed.
