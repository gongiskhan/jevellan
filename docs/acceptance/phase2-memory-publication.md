# Phase 2 memory publication evidence

Date: 2026-09-24. Actual local Git, SQLite, HTTP and Basic Memory operations; runtime responses are simulated. No live-model acceptance journey is claimed.

## Behavior

Memory-only work publishes under the ordinary checkout ownership and publication lease, with an explicit verification exemption. Classification checks the entire change from the recorded work base, with renames disabled for path comparison, and checks the final change after rebase/integration. Changes outside memory require Jevellan's own exact-commit verification. An empty result after Git recognizes an already-upstream memory patch remains exempt.

A versioned ledger receipt preserves the memory-only classification of an exact commit before pushing. A newly added regression first reproduced a failed-push retry incorrectly treating upstream code as local work and running the failing project test. It now passes after reopening the ledger and workspace, and proves that a later local code edit cannot reuse the earlier exemption.

Regular UTF-8 Markdown conflicts wholly inside repository memory are preserved automatically. The upstream version supplies the outer metadata/body; the full local document is appended with device and date; outer status becomes unresolved. Delete/modify conflicts preserve the remaining document and name the deletion. Successive conflicted checkpoints preserve each earlier version. Git blob hash round trips prevent invalid UTF-8 or binary data from being rewritten as lossy text.

Non-note, binary, symbolic-link and mixed code conflicts use the existing integration path. A later code conflict rolls back earlier tentative automatic merges before saving the complete original tip. Generation and lease assertions fence mutations and pushing. Successful automatic merges record a versioned receipt with source blob ids; reverted tentative merges produce no success receipt.

The owner service syncs the project's isolated Basic Memory index after publication. The next conversation retrieves the combined note and displays the unresolved label in its brief.

## Regression evidence

`tests/memory-conflicts.test.ts` covers metadata/comments, malformed frontmatter, CRLF content, directory boundaries, device-only memory, actual modify/modify, add/add and both delete/modify directions, repeated conflicts, literal shell-sensitive and Unicode filenames, nontext and symbolic-link fallback, mixed conflicts in one or successive commits, generation changes, binary attachments, renames out of code, an already-upstream patch and code added during integration. The code-and-memory case asserts passing receipts for both the original checkpoint and the final rebased HEAD.

Two additional cases in `tests/conversation-service.test.ts` exercise authenticated HTTP and actual Basic Memory: a read-only reply's captured memory checkpoint publishes without a deliberately failing code test, and automatic note merging refreshes search and supplies unresolved recall to the next stretch. The first focused run passed 23 publication cases; the final suite adds the invalid-root case. Both new service cases passed in their focused run (39 unrelated cases excluded by the name filter).

These adapt the preservation, literal-path and nontext regressions read from Garrison's `tests/archive-sidecar-merge.test.ts`. Its derived-content winner selection is deliberately excluded: BRIEF §13.5 requires both authored note versions, not a selected winner. Garrison was read only. The [Git rebase documentation](https://git-scm.com/docs/git-rebase/2.50.0) and [unmerged-index documentation](https://git-scm.com/docs/git-ls-files) define the stage semantics used here.

Typecheck, lint and the production build passed. The first full Vitest run passed **344 tests in 31 files** in 395.51 seconds, including all 24 then-existing publication cases and all 41 conversation-service cases. All 20 browser workflows passed in 1.7 minutes. After the failed-push retry regression was added and corrected, its focused run passed and the final complete suite passed **345 tests in 31 files** in 339.54 seconds. The final build also passed all **20 browser workflows** in 1.5 minutes. Secret scanning and whitespace checks passed; the recorded Garrison HEAD and complete status still match the latest preflight snapshot.

## Limits

This completes the automatic memory-publication behavior within the manual owner loop. Hook delivery, Jev-selected recall, cross-device acceptance and nightly memory care remain unfinished. Mapping checkpoint history across conflict integration for undo is separate remaining phase-2 work. J11/J12 are not marked passed. Claude SDK vision checks and live Jev/Claude acceptance remain blocked by missing dedicated credentials.
