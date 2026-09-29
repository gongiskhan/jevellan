# Ordinary conversation presentation · 29 September 2026

The user stopped work on the other machine and requested the latest main plus the same presentation improvements for ordinary Jevellan conversations.

## Source synchronization

**Live, read-only:** origin/main matched local main at `1112132`; a fast-forward-only pull reported already up to date. Dev Madrid's main checkout was clean at `8264aab`. That commit is an ancestor of the mini's main, with fourteen later local/published commits and no missing commits from Dev Madrid. Its checkout and services were not changed.

## Shared behavior

Ordinary conversations already use the shared sidebar rename/order controls, desktop dragging/mobile long press, wide reading layout, two-line latest-user message, compact growing composer and separate steer/queue actions. This update closes the transcript and live-feedback gaps:

- Native and ordinary conversations use one transcript component, with Markdown, compact spacing, one disclosure arrow, expanded readable thinking and labelled tool inputs/results. Ordinary tool file links still open their evidence viewer.
- Ordinary step transcripts retain event order instead of placing all text first and grouping tools separately. Streamed text is joined; tool results attach to their calls. Completed responses stay visible. Unfinished historical tools say Recorded rather than Running.
- Ordinary user messages render Markdown. Step metadata, choices, handoffs, changes, verification, questions and guards remain available.
- The ordinary composer shows current activity and Jump to latest when the reader scrolls away. The heading also shows a working spinner.
- The existing versioned runtime and ledger contracts now accept readable thinking deltas. Claude's exposed thinking text and Codex's SDK reasoning summaries feed those deltas. Signatures and encrypted reasoning are not projected. Thinking is available for future work when the runtime exposes it; older ledgers cannot recover discarded thinking.

Design choice: share the display component while preserving ordinary conversation orchestration and evidence controls. Native session discovery and CSG transport are unchanged. Optional malformed reasoning display items do not fail an otherwise valid Codex run.

## Verification limits

Build, typecheck and lint are required for this iteration. Two synthetic projection cases and two SDK fixture cases were added for ordered streams, tool results/status and readable thinking without opaque fields; their execution is deferred under the user's no-tests instruction. No automated suite, provider run, browser interaction test or phone acceptance is claimed. The final scoped source review covers event validation, historical compatibility, evidence links and unchanged steering/queue semantics. Deployment readiness is recorded below when activated.

**Live deployment readiness:** the new isolated copy at `~/.jevellan-build/pilot-conversation-parity-2026-09-29/app` is active on the existing tailnet address and data home. Local health returned HTTP 200 and the served HTML matched the final build. Build, typecheck, lint and the worktree secret scan passed. No conversation was started or messaged for verification. Dev Madrid's checkout and CSG connections were left unchanged.
