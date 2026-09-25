# Phase 2 corrections and undo

This document preserves the phase 2 checkpoint below. The later [automatic loop](phase3-loop.md), [composer choices and correction history](phase3-composer.md), and [J13 evidence map](J13.md) supersede its historical statements that Jev feedback and composer controls were unimplemented.

Undo has versioned work receipts and Git plans/results, durable replay, checkpoint reset/revert operations and a conversation coordinator. The authenticated correction endpoint and Change this step panel support Just override and Undo and redo. J13 remains incomplete: the automatic Jev loop and correction feedback have not been implemented, and the limitations below still need work.

## Conversation state

`ConversationWork.undo` validates the work, complete step range and generation before appending one durable receipt. It refuses running stretches; the service terminates owned execution and waits for checkpoint settlement before calling it. Repeating the same receipt repairs projections without repeating the operation or bumping generation, even after further messages arrive. Reusing an id for different content is rejected.

Replay retains the original request, user messages, base commit and granted allowance. It marks the affected stretches undone while retaining their handoffs and ledger entries. It rebuilds constraints, decisions, the full-plan pointer and approval, counters, model/effort and summary from surviving steps. Receipts from removed steps no longer count toward test-failure guards. Pending memory and briefs already filter by the rebuilt active-step set. Step numbers remain monotonic: redo will get a new number rather than overwrite history.

Five new cases in `tests/conversation-work.test.ts` prove:

- retained plans, approvals, original constraints, request text, notes and allowance survive while undone constraints, decisions, blockers and queued memory leave the next brief;
- undo of the last closed work reopens the same work and removes its undone plan without reusing step numbers;
- a durable undo survives a projection-write failure, retries and later user messages;
- running steps, stale generations, incomplete ranges and a closed work hidden by newer open work are refused without appending a receipt;
- successive undo and subsequent steps recompute no-progress, test-failure, cost and unknown-cost counters without reviving removed verification failures.

The coordinator now supports selecting the last closed work while newer work is open. Its durable undo explicitly identifies that newer work, preserves both requests and transfers ownership without releasing it; see [cross-work evidence](phase2-undo-following.md).

## Git behavior

`GitWorkspace.planUndo` takes exact recorded source ranges and produces a validated plan. `sourceTip` must come from the work's checkpoint history before publication rewrites it. It must not be inferred by taking every commit between an old base and today's remote HEAD: that could include other work. The service records before/after receipts for writing stretches and separate queued-memory checkpoints. A clean publication rebase can revert their original source SHAs without including unrelated upstream commits.

An earlier published undo can separate the surviving ranges. The service accepts that gap only when a completed undo receipt explains it; a successful publication between that undo and its redo decision also records the destination after a clean rebase. The plan retains each active checkpoint range and reverses those changes newest first, leaving the earlier undo and unrelated upstream changes intact. Duplicate checkpoints and reset across a gap are rejected. Conflict integration still needs checkpoint mapping; unexplained or missing boundaries are refused, never inferred from remote HEAD.

Applying a plan takes checkout ownership, requires a clean settled checkout, saves `refs/jevellan/undo/{conversationId}/{step}`, and invokes the durability callback before changing HEAD. The caller must persist the plan in that callback; a failure leaves HEAD unchanged. A different existing recovery ref is never overwritten.

Unpublished checkpoints reset to the target. For published checkpoints, planning prepares ordinary revert commit objects, newest source checkpoint first, retaining newer unrelated commits. Each tree is a reverse three-way merge with the original checkpoint as the merge base. All commits are prepared before moving the checkout; a conflict leaves HEAD, index and files unchanged. The original source commits can be reverted even when publication rebased their identities. Prepared objects are retained under `refs/jevellan/undo-results/{conversationId}/{resultCommit}` and the exact destination is persisted in the plan. Applying the plan fast-forwards main through those commits. No force-push is used. Publication remains the existing separate verification-and-lease path.

This uses Git's [merge-tree interface](https://git-scm.com/docs/git-merge-tree/2.50.0), which computes a merge without modifying the index or worktree, and [commit-tree](https://git-scm.com/docs/git-commit-tree), which creates the ordinary commit objects. Git 2.50.1 on this machine passes the actual-repository tests; compatibility with older Git installations is not established by this evidence.

Seven new cases in `tests/git-policy.test.ts` use actual disposable Git repositories and local bare origins:

| Case | Evidence |
| --- | --- |
| Unpublished code and memory | Recovery ref contains the complete old tip, reset preserves earlier checkpoints, ownership stays held, and a retry recognizes the exact completed reset. |
| Published range followed by other work | Two revert commits remove only the selected code and memory; the newer upstream file survives. The bare origin changes only after a daemon verification receipt for the new HEAD. |
| Publication rebase | Original and published SHAs differ; reverting the recorded original range restores the value while preserving the upstream addition. |
| Conflict while preparing a revert chain | A memory reversal is computable before the older code reversal conflicts. Planning leaves both files, HEAD and the index unchanged; no partial sequence reaches the checkout. |
| Stale files or unavailable ledger | An unrelated dirty file remains unchanged; a failing durability callback leaves HEAD at its original tip with the backup saved. A stale generation cannot reset it. |
| Publication after planning | An originally unpublished reset plan is refused after its checkpoint reaches origin; replanning selects revert even if the caller's published flag was stale. |
| Clean but unfinished Git operation | An actual empty cherry-pick leaves CHERRY_PICK_HEAD with a clean porcelain status. Undo planning, execution and Discard refuse it without clearing its state. |

Two additional Git cases prove exact recovery and repeated application of prepared revert chains, unchanged refs during recovery inspection, preservation of dirty files and newer commits, and rejection of a prepared commit whose tree does not reverse the recorded source. The existing external-policy case proves that undo planning cannot mutate Git there. Older revert plans without an exact destination retain their original abort behavior; an unexpected HEAD cannot be classified as success or replayed blindly.

A further actual-Git case reverses two recorded ranges while preserving an intervening commit. It also refuses overlapping ranges and an attempted reset across the gap. The service case performs two published undo operations, with upstream changes before the original publication and during the first undo's publication, plus a prepared-plan interruption and retry. Only surviving checkpoints are reversed. A separate service case leaves an unexplained history gap blocked, preserving all files, history and model-start counts.

## Conversation operations and controls

Each correction has a versioned request, from/to field changes, original decision and stretch, mode, timestamp and context. New decisions record the project, action, computed change size and risky path areas. The correction summary uses those recorded facts; earlier decisions without them are identified explicitly. The hub stores the same correction record without request/message text. Startup repairs missing index rows.

Just override appends one event and increments generation once, without terminating or changing the running stretch or its original decision. Duplicate request ids return the same correction; changed content under that id is refused. Timeline chips open Change this step; corrected steps display their changes.

Undo and redo records the request, terminates owned execution, waits for its final checkpoint, acquires checkout ownership, and persists its plan before Git mutation. It then persists the Git result before applying the conversation undo event. Stretches are retained and marked Undone, with struck-through titles. A selected redo launches automatically with source/trigger `redo`, subject to account capabilities and guards. With the decision loop still in manual mode, subsequent steps return to the manual picker.

For published work, ordinary revert commits pass the verification/publication path before the redo launches. A closed work is reopened with the same request, base, messages and allowance. Repository memory is synchronized into Basic Memory's isolated search index after undo. External-policy corrections rebuild history while preserving repository files and Git refs; the confirmation panel explains that distinction.

Recovery does not relaunch anything or mutate the checkout. A saved backup ref and HEAD matching the plan's exact destination establish completion even if the Git-result receipt was lost. Startup then repairs the result and conversation history exactly once. A later cancellation remains cancelled while history is repaired. Dirty files, unfinished Git operations or an unexpected HEAD remain blocked; recovery does not guess what happened. An unresolved plan keeps automatic checkout changes blocked.

The conversation now offers **Retry undo and redo** for an interrupted correction. A retry preserves the original correction, checks the current generation and uses a client request id for deduplication. It resumes after completed undo rather than repeating it. Redo decisions carry the correction id; an actual started stretch (or completed done action) establishes that the redo already ran, even if its final operation receipt was lost. Preparation-only integration stretches do not count as the selected redo. Newer outside commits are preserved and block retry until reconciled; normal manual selection cannot bypass that recorded block.

Eight HTTP/process/Git regression cases cover noted corrections during a live owned process, idempotency and index content, termination and automatic redo of an unpublished code/memory range, clean publication rebase with unrelated upstream changes, dirty-file preservation, interrupted operations, recovery after a saved result with missing work receipt, external policy, and separately queued memory with search-index refresh. Runtime responses are simulated; Git, process termination, HTTP, persistence and Basic Memory are actual local tools. Final command outcomes are recorded in REPORT.md.

Five further service cases cover lost result receipts for reset and published revert, cancellation before restart, dirty-checkout retry with stale/idempotent requests, lost completion after an actual redo, and newer outside commits followed by explicit reconciliation. The browser correction flow now disables the selected runtime's accounts before undo, reloads the resulting pause, retries while the accounts are still disabled, then re-enables them and retries the same correction. It asserts one undone original step, one actual redo and two distinct retry receipts.

The first extended browser run passed the twelve earlier workflows and rejected the correction fixture's account update: an API-key account was missing its required payment policy. The fixture now preserves that policy while toggling availability. The complete sixteen-workflow matrix then passed. This was a fixture correction, with no live credentials or native account changes.

Retry screenshots were recaptured with the button in view, then inspected at desktop and 390-pixel phone sizes in both themes. The card, explanation and control are readable without overlap or horizontal clipping. This supplementary inspection does not replace the required Claude SDK vision judge, which remains blocked by the missing dedicated Claude credential.

| Retry state | Desktop | Phone |
| --- | --- | --- |
| Interrupted correction | [light](screenshots/phase2-undo-retry-desktop-light.png), [dark](screenshots/phase2-undo-retry-desktop-dark.png) | [light](screenshots/phase2-undo-retry-phone-light.png), [dark](screenshots/phase2-undo-retry-phone-dark.png) |

All 16 browser workflows passed after the selector correction. Screenshot inspection found and fixed low dark-mode contrast on the new chip buttons; the complete matrix passed again, and history screenshots were visually checked in all four layouts, along with phone-light and desktop-dark confirmation panels. The browser matrix adds correction chips, Just override, confirmation, automatic redo, history, reload and responsive screenshots to the existing Settings and settlement flows. Its first run exposed a test selector mismatch: exact label text did not match the nested select's label representation. The failed fixture retained checkout ownership, correctly blocking later work. The test now uses the combobox's accessible name and follows the existing scenarios so the Settings empty-state assertion remains valid.

## Remaining work

Checkpoint mapping across conflict integration now has [native Git and service evidence](phase2-integration-undo.md). Last-closed undo while newer work is open now has [component, service and browser evidence](phase2-undo-following.md). Unexpected Git state and legacy revert plans without a destination still require explicit reconciliation. Add composer overrides/pins, eligibility explanations, recent-correction selection, Jev feedback and the automatic loop. Full J13 evidence is still required. These are unfinished implementation, not environmental blockers. No live Claude, Jev or second-device evidence was added. The overall build goal and phase 2 remain active.

The first expanded full run passed 291 tests; the running-step undo case exceeded its 60-second test deadline under concurrent browser load. It passed alone in 48 seconds. That case includes the actual 30-second late-handoff window plus cold memory startup and Git, so its deadline is now 120 seconds with unchanged process, ref, history and content assertions. The full suite was rerun without simultaneous browser execution. Final results are in REPORT.md.

Verification before the recovery extension: typecheck, lint, production build, all 292 Vitest tests in 29 files, all 16 Playwright workflows, history/worktree secret scan and whitespace checks passed. That full Vitest run took 198.68 seconds; the browser run took 1.1 minutes. The recovery extension's final results are recorded in REPORT.md. No live model calls were added by these fixtures.
