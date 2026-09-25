# Conversation workflow repair — 2026-09-25

Status: deployed live on 2026-09-25 at 19:50 UTC after explicit user authorization. This is a repair to the phase-5 pilot, not a resumption of the deferred full build or an acceptance claim.

## Reproduced live

The user's “Build a todo app” conversation called Jev successfully: the recorded action classification selected Plan, with separate model/effort and memory decisions. The stretch then failed. Claude's ToolSearch was denied by Jevellan's read-only hook, preventing discovery of its handoff tool. The installed native Claude also omitted dedicated Glob/Grep tools by default; with Bash denied, the agent tried repeated guessed file reads. No valid handoff was received.

A separate activity observer timed out while querying the local Cursor database (approximately 1.97 GB). The original LIKE predicate scanned the table; an indexed prefix range returned the same metadata successfully. A read-only live sensor check with the repaired worker completed in under one second with no unavailable sources. No native home was modified, and no transcript content is included here.

## Changes

- Allow ToolSearch during read-only Claude stretches; every discovered tool invocation still passes through the existing permission hook. Explicitly provide the read/search tool set so native builds offer Glob and Grep. Shell and write tools remain denied in read-only work.
- Use an indexed key range for Cursor metadata. The existing timeout and unavailable-source behavior remain in effect.
- Emit versioned progress notices and expose the current phase in conversation responses: preparation, judge decisions, memory, agent startup/execution, saving, verification and publication. Progress clears when the operation ends.
- Show a live activity card and elapsed stage time, compact the composer behind an expandable settings row, and group tool calls behind an activity summary. Historical failures remain inspectable.
- Add projects directly beside the new-conversation selector, preserving the draft. Add a signed-in folder picker for directories on the current device; it reads folder names only within the user's home. Manual absolute paths remain available.

When the brief was silent: progress uses observed service stages and real elapsed time, without percentages or guessed completion estimates. Folder browsing excludes hidden directories, dependency folders and symlinks, and never creates or changes a project just by browsing.

## Verification

- Typecheck, lint and production build passed in the workspace and the independent pilot copy.
- Focused execution/judge/safety suite: 84 passed, with two existing sensor fixture comparisons failing by one millisecond due to filesystem timestamp precision. After making fixture timestamps whole seconds, all 12 sensor/folder checks passed.
- Exact independent pilot copy: five targeted execution, progress, hook, sensor and folder checks passed.
- Browser simulation: 12 checks passed across phone/desktop and light/dark, covering initial rendering during refresh, visible judge progress, collapsible controls, folder selection and preservation of the message draft.
- Composer override/pinning browser checks: all four phone/desktop light/dark cases passed, including override application, model/effort pins, reloads and clearing choices.
- Secret scan and whitespace checks passed. The full automated suite was started and then stopped after eight minutes to keep this repair bounded as requested; no full-suite pass is claimed. The focused checks above completed.
- Successful live execution with the configured accounts: **passed after the repairs below**. Jev selected implementation and review, Claude submitted both handoffs, Jev selected Done, and the independent gate passed all 17 tests. Earlier failed attempts remain visible.

## Activation

Prepared copy: `~/.jevellan-build/pilot-workflow-fix-2026-09-25/app`. Existing data stays in `~/.jevellan-build/pilot-2026-09-25/home`. The copy retains the deployed login fix and excludes deferred phase-6 changes.

Automatic approval review rejected activation twice, citing the AGENTS.md rule against daemon restarts. The second request supplied the earlier explicit restart approval and confirmed that no operation was active; review still required approval for this exact replacement. Those attempts made no changes. Later explicit user authorization and the current approval review allowed the scoped replacement.

The activation script waits for an exclusive idle gate, verifies process ownership and start identity, snapshots account/authentication/project and ledger hashes, gracefully replaces only the pilot, checks loopback health plus the exact served Tailscale UI, and compares preservation hashes.

A separate local `~/Projects/jevellan-todo` repository was created and registered through the live UI as “Todo app”, with `node --test` and local Git handling, for the authorized end-to-end run. The authorized real-account conversation has now started there.

## Authorized redeployment attempt

The user removed the daemon restriction from AGENTS.md and explicitly instructed “redeploy”. Prepared build fingerprints still match, and the activity receipt showed no active operations. Activation failed at its first launcher write with EPERM under `~/.jevellan-build`, before any stop signal. That earlier attempt stopped before any service change. With the current permissions, automatic review approved the same scoped activation, and deployment succeeded at 19:50:45 UTC. Loopback health and the exact Tailscale-served UI matched the repaired build. Preservation checks passed for all three accounts, two projects, two existing conversations, authentication data and ledgers. The isolated state directory is unchanged.

## Publication

The user explicitly requested commit and push. The completed pilot and deployed repairs were committed on main as `3d1c3fb` and pushed to public `gongiskhan/jevellan`. Staged application source matched the tested installed copy exactly; deferred phase-6 changes were preserved locally and excluded. The worktree and pre-push history secret scans passed, with no forbidden files staged.

The gh API login returned 401; the authenticated GitHub browser created the empty public repository, and existing SSH authentication as gongiskhan pushed main. No native login was changed. Complete visibility snapshots were saved outside the checkout before creation and after the first push. All 207 existing repositories retained their visibility; the only new entry is public Jevellan.

## Live follow-up: read-only handoff approval

The real implementation stretch completed and submitted its handoff. Jev then selected Review automatically. That review could discover the handoff tool but the native CLI denied invoking it in `dontAsk` mode. A permissive PreToolUse result only deferred the decision; it did not pre-approve MCP invocation. A repeated review reproduced the failure. These failed stretches remain in the conversation history.

The Claude adapter now explicitly pre-approves the exact scoped Jevellan bridge tools. The list is shared with the read-only hook policy, including conditional memory writes; unrelated MCP tools, shell tools and file writes remain denied. Repair turns omit memory-write permission. This follows the [SDK's documented permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).

The independent replacement copy passed typecheck, lint, production build and all 54 safety/execution cases. A preceding restricted workspace run passed the 43 safety cases but failed the 11 process-based execution cases; the fully permitted isolated-copy run passed all 54. No browser UI changed in this follow-up.

The assistant-created verification work was paused and its files kept unchanged before redeployment. Automatic review initially blocked the pause and settlement-dialog opening; source inspection established that cancellation preserves partial output/files and that opening the dialog only changes local UI state. The reviewed retries succeeded. No rejection was bypassed.

The handoff fix was activated at 20:10 UTC from `~/.jevellan-build/pilot-handoff-fix-2026-09-25/app`. Accounts, authentication data, both projects and all three conversation ledgers were preserved. The resumed read-only review ultimately handed off successfully, and the independent completion gate passed. A further missing-stretch-number defect and its fix are recorded below.

## Live result and final stretch context

The resumed review exposed missing current-stretch metadata in the launch brief: the agent guessed a number and received a generic mismatch error. A subsequent review submitted a valid handoff. The brief now explicitly names the next conversation-wide stretch number, the same-session repair prompt supplies its exact number/action, and a mismatch response supplies the correct scoped number without accepting the invalid handoff. Regression coverage includes a new work after a cancelled work, mandatory context under trimming, and rejection followed by a corrected handoff.

**Live result:** the configured Jev service (`jev-1.13.0`) chose Implement, Opus and high effort, then Review. The final read-only review completed with an accepted native handoff and no blocking findings. Jev chose Done with probability 0.69. Jevellan then ran its own `node --test`: 17 passed, 0 failed, exit 0, no timeout. The receipt confirmed stable HEAD and identical file-content digests before and after verification. The UI shows Done and exposes the passing verification output in Changes. No manual Done override was used.

The agent's earlier 24 browser checks are agent-reported evidence; the 17-case completion gate was independently run and recorded by Jevellan. The original failures remain in history. This establishes the repaired live conversation/stretch/judge/handoff/verification path on one machine, not general judge quality, full-suite acceptance or section-20 completion.

Final release validation: typecheck, lint and build passed; all 79 cases across safety, brief, bridge and execution passed. The tested source exactly matches the staged application source. Final activation at 2026-09-25T20:19:34.647Z preserved all three accounts, two projects, three conversations and authentication data. The active copy is `~/.jevellan-build/pilot-final-fix-2026-09-25/app`. The earlier blocked pause became unnecessary when the read-only run completed naturally; no alternate stop mechanism was used.
