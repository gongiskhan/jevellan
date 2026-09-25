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
- Successful live end-to-end execution with the repaired Claude adapter: **in progress**. The repaired daemon serves the current build; real Jev selected Implement, Opus and high effort, and Claude is writing the Todo app.

## Activation

Prepared copy: `~/.jevellan-build/pilot-workflow-fix-2026-09-25/app`. Existing data stays in `~/.jevellan-build/pilot-2026-09-25/home`. The copy retains the deployed login fix and excludes deferred phase-6 changes.

Automatic approval review rejected activation twice, citing the AGENTS.md rule against daemon restarts. The second request supplied the earlier explicit restart approval and confirmed that no operation was active; review still required approval for this exact replacement. Those attempts made no changes. Later explicit user authorization and the current approval review allowed the scoped replacement.

The activation script waits for an exclusive idle gate, verifies process ownership and start identity, snapshots account/authentication/project and ledger hashes, gracefully replaces only the pilot, checks loopback health plus the exact served Tailscale UI, and compares preservation hashes.

A separate local `~/Projects/jevellan-todo` repository was created and registered through the live UI as “Todo app”, with `node --test` and local Git handling, for the authorized end-to-end run. The authorized real-account conversation has now started there.

## Authorized redeployment attempt

The user removed the daemon restriction from AGENTS.md and explicitly instructed “redeploy”. Prepared build fingerprints still match, and the activity receipt showed no active operations. Activation failed at its first launcher write with EPERM under `~/.jevellan-build`, before any stop signal. That earlier attempt stopped before any service change. With the current permissions, automatic review approved the same scoped activation, and deployment succeeded at 19:50:45 UTC. Loopback health and the exact Tailscale-served UI matched the repaired build. Preservation checks passed for all three accounts, two projects, two existing conversations, authentication data and ledgers. The isolated state directory is unchanged.
