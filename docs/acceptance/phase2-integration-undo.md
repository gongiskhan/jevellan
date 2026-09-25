# Undo after publication integration

Evidence: **simulated agents with actual local Git, HTTP, process control and Basic Memory**. No new live model, Jev classification, Claude vision or second-device claim is made here. Phase 2 remains in progress.

Publication now retains Git's native original-to-rewritten commit pairs. Undo uses the checkpoints that were actually integrated, including conflict resolutions. It preserves upstream changes and treats a dropped checkpoint as an unchanged boundary rather than reverting the upstream commit it maps to.

## Native capture and ownership

Before rebasing, Jevellan records a versioned plan, pins the original tip under `refs/jevellan/integrations/{conversationId}/{id}`, and creates an isolated capture beneath its own home. Command-scoped `core.hooksPath` forwards existing executable hooks through their original paths. The post-rewrite collector preserves the original hook's arguments and stdin and records Git's pairs in a versioned document. It does not edit local or global Git configuration, native agent homes, or the project's hook files.

The merge rebase uses `--reapply-cherry-picks` so Git records checkpoints that become empty because upstream already contains their changes. Completion validates the entire ordered source list and every destination: each is either the preceding boundary (a dropped commit) or its direct child. The final boundary must equal clean main. Missing, incomplete or inconsistent mappings cannot authorize publication or undo. This follows Git's documented [post-rewrite protocol](https://git-scm.com/docs/githooks#_post_rewrite); the behavior was also exercised against this machine's Git.

Rebase explicitly disables automatic updates to other branches and uses the recorded merge base rather than reflog-based fork-point selection. A fixture with `rebase.updateRefs=true` reproduced an unintended change to another branch before the explicit override. The fixed invocation preserves it while leaving that user's configuration intact. Git documents this configuration override in its [rebase options](https://git-scm.com/docs/git-rebase#Documentation/git-rebase.txt---no-update-refs).

Conflict stretches receive a scoped `jevellan_integrate` bridge tool. The agent starts integration, edits the reported conflicts, and requests continue or skip. Code owns the precise Git invocation, stages only the unresolved paths on continue, validates the recorded rebase metadata and enforces checkout ownership and the publication lease. The tool is unavailable to ordinary steps, after handoff and during repair. No extra agent environment variables or writable sandbox directories are needed.

The original stretch boundaries remain in history. Corrections translate their checkpoint receipts through completed rewrite receipts, then use the existing reset/revert machinery. Conflict resolution belongs to the rewritten implementation checkpoint; extra files and captured memory added by the integration stretch belong to that stretch. Repeated published undo still excludes earlier revert operations and preserves newer upstream work.

## Interruption behavior

The plan is durable before Git rewrites anything. Before retrying publication or preparing undo, Jevellan reconciles outstanding plans. If the checkout remains at the original clean tip with no rebase, it records an aborted attempt. If the native rewrite result exists, it validates and records the missing ledger receipt without replaying Git. A rewritten checkout with missing evidence stays blocked; retry cannot bypass that requirement merely because upstream is now an ancestor.

Recovery retains ambiguous or externally changed state for explicit reconciliation. It does not reset the checkout or infer a mapping from commit messages or similar patches.

## Functional evidence

- Clean rebases, changed conflict resolutions, skipped commits, and already-upstream commits produce exact native mappings. Undo retains the upstream file and restores its value rather than the pre-integration value.
- A dropped checkpoint between two surviving changes maps to the previous boundary; undo creates two reverts and preserves the upstream contribution.
- Existing pre-rebase hooks can reject integration. Existing post-rewrite hooks receive their original path, arguments and unmodified input, including an existing nonzero hook result. Git configuration remains byte-for-byte unchanged.
- Captures can be reopened from disk. Lost ledger receipts recover from native evidence; missing native evidence blocks the retry without moving main or publishing.
- The HTTP/FakeRuntime conflict fixture resolves local value 2 versus upstream value 3 to value 5, captures a memory note, verifies and publishes. Undo from the implementation restores 3 and removes the note; undo from the integration removes the note and retains 5. Both preserve the unrelated upstream file and publish before starting the requested redo.
- Automatic memory conflict undo restores the exact upstream note, removes the unresolved label from the actual Basic Memory index, and retains the memory-only test exemption. Memory is refreshed again after revert publication so the next read-only step can recall notes arriving from upstream during that publication. The missing-note case reproduced before this final refresh.
- Previously covered repeated published undo continues to use the surviving rewritten checkpoints across an earlier undo and a later upstream update.

Typecheck, lint and the production build pass. The full suite passed **391 tests in 31 files in 526.95 seconds**. Focused runs passed ten Git/service cases and then four conflict/bridge cases. After the final branch-setting correction, all **42 Git policy cases passed in 137.66 seconds**, including the regression reproduced before that fix. After the final memory-refresh correction, all **five related published-undo service cases passed in 117.11 seconds**. The rebuilt application also passed all 24 browser workflows before that backend-only refresh, with no UI source changes. Secret scanning and whitespace checks pass. Exact run ordering is recorded in [REPORT.md](REPORT.md).

## Remaining work

Undo of the last closed work while newer work is open now has [separate evidence](phase2-undo-following.md). Loose Rigging discovery, managed promotion and the remaining timeline controls now have separate evidence. [J1](J1.md) and [J2](J2.md) passed live in their phase-2 manual forms. The single-device part of [J11](J11.md) also passed live with Codex. Cross-device and automatic journeys, plus native integration-tool execution, remain to be collected. These implementation and evidence gaps are not environmental blockers. Jev and Claude checks remain separately blocked by their missing dedicated credentials.
