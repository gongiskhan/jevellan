# Undo while newer work is open

Evidence: **simulated agents with actual local Git, HTTP, process control and Basic Memory**. This is component and browser evidence, not live J13 acceptance or Jev classification. Phase 2 remains in progress.

Undo can now select a step in the last closed work while newer work is pending, checkpointed or running. The confirmation explicitly includes that newer work. Jevellan stops running execution, waits for its process group and final checkpoint, then undoes the selected step and every later step in both works. Published changes use reverts and are verified and published before the requested redo starts.

The older work reopens with its original request intact. The newer work is retained as cancelled with its own original request intact; its request and notes become verbatim follow-up direction in the reopened work's brief. Ledger messages keep their original identities and work association. Step numbers and handoffs remain immutable, and undone steps cannot contribute constraints, plans or counters to the redo.

## Ownership and interruption

The durable redo operation identifies both works before execution is stopped. Checkout ownership transfers directly between them without releasing the reservation. The hub update and local mirror can recover if interrupted between writes, but unrelated work cannot acquire the checkout during that interval. Transfer requires the previous process group to be gone and both works to belong to the same conversation.

A service regression interrupts undo after Git has applied its recorded result but before that result reaches the ledger. Startup recovers the exact result, restores conversation history across both works and retains ownership. Explicit retry launches the selected redo once with both requests and the newer notes.

## Published boundaries

A separate regression reproduced loss of an unrelated upstream file when undo crossed an earlier published checkpoint and a later rewritten checkpoint. The correction now translates each checkpoint range through its own applicable rewrite receipts. A rewrite's merge base maps to its upstream boundary only when that range's end is actually replayed by that rewrite. An unchanged earlier checkpoint cannot expand to include intervening upstream commits.

Recorded work bases explain the transition between the two affected works. Undo still refuses unexplained history gaps, reverses only recorded checkpoint ranges and preserves unrelated upstream code. Repository memory from undone newer steps is removed, and the isolated search index is refreshed before redo.

## Evidence

- The published-boundary regression failed before the range translation fix; six related service cases passed afterward, including repeated published undo, unexplained gaps, conflict integration and memory refresh.
- Five focused service/core cases passed for newer work pending, checkpointed and running, with and without newer steps. The running case proves process-group termination before redo. The checkpointed case proves missing-result recovery after restart.
- The ownership regression interrupts the hub/local mirror update, proves another conversation stays blocked and recovers the same transfer idempotently.
- Browser coverage confirms the additional warning, two undone steps, preserved requests, reopened work and durable state after reload on desktop and phone in both themes.

All **28 browser workflows passed in 2.6 minutes** after the fixture fix. All eight new confirmation/history captures were visually inspected: message text is fully rendered, the extra warning and both requests are legible, and controls fit the 390-pixel phone layout. This inspection is not a Claude SDK vision check; that check remains blocked by the absent dedicated token. The final production build, typecheck and lint passed; the full suite passed **398 tests in 31 files in 631.06 seconds**. Secret scanning and whitespace results are recorded in [REPORT.md](REPORT.md). The first browser run exposed a fixture setup error: adding the independent undo project created a context conversation and invalidated the existing empty-sidebar check on phone. The fixture now seeds the same local context link as the original browser project, keeping the initial sidebar empty without changing product behavior.

| Layout | Confirmation | Reopened history |
| --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-undo-following-confirm-desktop-light.png) | [Capture](screenshots/phase2-undo-following-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-undo-following-confirm-desktop-dark.png) | [Capture](screenshots/phase2-undo-following-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-undo-following-confirm-phone-light.png) | [Capture](screenshots/phase2-undo-following-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-undo-following-confirm-phone-dark.png) | [Capture](screenshots/phase2-undo-following-phone-dark.png) |

## Remaining work

Loose Rigging discovery, remaining timeline/project controls, live manual journeys and native integration-tool/lifecycle evidence remain unfinished. Live Jev and Claude vision checks remain blocked by their missing dedicated credentials.
