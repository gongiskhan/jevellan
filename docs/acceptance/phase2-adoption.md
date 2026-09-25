# Phase 2: accepting blocked file changes

The conversation now offers **Review changes** when automatic checkpointing is blocked. The Changes drawer includes tracked and untracked changes, including symlink targets. **Continue** accepts that reviewed state as the work's checkpoint. A newer message, file edit or Git boundary invalidates the review; **Refresh changes** obtains a new one. The manual picker becomes available after the checkpoint settles. Publication still uses Jevellan's own verification and publication lease.

## Recorded authority and recovery

Each new checkpoint block retains the pre-stretch Git snapshot. A review binds the project path, owning work, step, unresolved block events, conversation generation, Git snapshot and worktree digest. Main, other branches, tags, remote configuration and remote state must still match the recorded boundary. A pending Git operation, another checkout owner, an unresolved undo or external branch policy prevents acceptance. A first checkpoint also requires evidence that the step began on clean, published main. Earlier blocks without a saved Git snapshot remain unavailable for automatic recovery.

After the user accepts the review, Jevellan stages the reviewed files and prepares an exact commit with the normal Git identity. It pins that object under `refs/jevellan/checkpoints/{conversationId}/{requestId}` and records a versioned plan before moving main with compare-and-swap. It does not replace worktree files. Rechecks before applying reject changes to the index, files, conversation or Git boundary. Accepting a restored clean tree creates no empty commit.

The recorded checkpoint receipt belongs to the original step, so its code and repository memory are included in later undo. The original failed step and handoff remain intact. The isolated memory index is refreshed after acceptance, before queued notes are applied, so an already-open provider and the next read-only brief see edited memory. Deferred handoff findings are captured, and queued memory is applied under ownership at the open work's settled boundary. Cancelled work can accept its kept files and later publish while retaining its request and closed state.

Startup recognizes the exact prepared result if Git moved before its result receipt was saved. It repairs the receipts without another commit or runtime launch. A prepared result that was never applied waits for a fresh review. A superseded attempt cannot recreate a checkpoint receipt. Files arriving after the accepted checkpoint get a new block and remain uncommitted until reviewed.

## Evidence

The tests use actual local Git repositories, SQLite/ledger storage, authenticated HTTP, owned processes and isolated Basic Memory. Model behavior is simulated. Six Git cases cover the exact prepared result, untracked files and symlinks, stale files/index/history, pending Git operations and an unchanged tree. Eleven service cases cover acceptance and deferred memory, edited-memory index refresh and read-only recall, normal verification/publication, duplicate requests, stale files and messages, unrecorded commits, unresolved undo, restart at three boundaries, undo of accepted changes, checkout ownership, external policy and cancelled work.

The browser workflow exercises a simulated read-only violation, reload, review of tracked and untracked content, invalidation by a newer message, refresh, Continue and verified publication. The complete 24-workflow matrix passed in 2.1 minutes. All four new screenshots were inspected: the diff, explanation and controls are readable and reachable, with no observed blocking overlap. The phone panel scrolls vertically. This inspection does not replace the required Claude SDK vision check, which is blocked by the missing dedicated token.

| Review panel | Desktop | Phone |
| --- | --- | --- |
| Light | [screenshot](screenshots/phase2-adoption-desktop-light.png) | [screenshot](screenshots/phase2-adoption-phone-light.png) |
| Dark | [screenshot](screenshots/phase2-adoption-desktop-dark.png) | [screenshot](screenshots/phase2-adoption-phone-dark.png) |

The initial targeted run passed 14 cases. The first two full runs each passed 373 of 374 tests. The multi-review/retry case exceeded the default 15-second deadline in the first run; after its deadline was corrected it passed in the second, where the accept-then-undo case reached the same short limit. The new service cases now use the existing 60-second real-I/O allowance, with every behavioral assertion retained. The next full run passed all 374 tests in 455.46 seconds. A subsequent regression reproduced stale memory search after accepting an edited note; the index refresh fixed it, and the test also proved recall in the next read-only brief. Final results with that additional regression are recorded in REPORT.md.

This completes the explicit file-acceptance path. Detection of outside native sessions and connecting those observations to checkpoint blocks remain phase 4 work. Later checkpoints add [conflict-integration undo mapping](phase2-integration-undo.md) and [last-closed undo with newer work open](phase2-undo-following.md). Other unfinished phase 2 controls remain listed in REPORT.md. No complete live acceptance journey is claimed here.
