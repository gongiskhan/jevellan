# Phase 2: Project memory hooks

Evidence date: 2026-09-24. This is component and workflow evidence, not completed J1–J13 acceptance.

## Behavior

Project memory is a built-in Rigging item, enabled initially for each runtime. Its content is read-only; its per-runtime toggles remain editable. Safety stays locked on. Disabled items remain visible in a filtered Rigging view so they can be enabled again. Toggles show the pending choice immediately during delivery and roll back on request failure.

APM delivers PreCompact, Stop and SessionEnd command hooks to the isolated account: Claude settings.json and Codex hooks.json. Launches verify stable Rigging delivery, including accounts created before this built-in existed. Incomplete APM output fails before changing the account. Existing custom hooks and Settings hooks coexist with capture. Delivery remains idempotent and preserves loose or externally edited files.

The command has a two-second input/request deadline within the configured three-second native timeout. It returns an empty JSON object, never a blocking decision or additional context. The provider payload is bounded; only its allowlisted event name crosses the bridge. No transcript, native session identifier, provider-authored message, tool argument or environment value enters the captured note. The hook writes no files and starts no detached worker.

The owner derives project, conversation, step, action, runtime, model, effort, device, start time and starting commit from its own durable state. It queues one metadata checkpoint per step, coalescing lifecycle events and retries. A Stop or SessionEnd is explicitly not evidence that the step completed. An ordinary answer-only reply produces no automatic note; an explicit remember reply may capture. Handoff repair cannot capture. The live runtime toggle is checked on each request, and an expired grant is rejected.

The existing durable memory queue applies the proposal only after the stretch, under checkout ownership, then checkpoints and publishes normally. Read-only hooks themselves never edit project memory. Disabling the hook does not disable agent memory tools or handoff findings. Recall remains exclusively in the stretch brief.

## Evidence

- `tests/rigging.test.ts`: actual installed APM delivers both account formats, preserves custom hooks and settings, repeats without duplication, removes only disabled capture and leaves disposable native-home sentinels intact. Missing hook output is rejected before account writes.
- `tests/settings-api.test.ts`: authenticated edits toggle one runtime independently, reject built-in content changes and stale revisions, and retain the Safety restriction.
- `tests/stretch-bridge.test.ts`: concurrent events deduplicate after handoff; two grants retain separate project scopes; disabled, repair, answer-only and expired cases cannot queue. Actual command subprocesses exercise hostile-looking path characters as literal filenames, discarded provider content, malformed/oversized inputs, missing scope, rejected tokens and the timeout against an unresponsive local server. No provider model is involved.
- `tests/conversation-service.test.ts`: a simulated read-only runtime queues capture without changing Git while running. Actual Basic Memory and Git then create one memory checkpoint and publish it without a code-test exemption being mistaken for a passed code test. A separate answer-only flow with hooks enabled closes with its original HEAD and clean tree.
- `tests/runtime-contracts.test.ts`: both production adapters and their actual SDKs load APM-delivered capture through simulated provider CLIs. Two concurrent stretches share an account home while all three events reach their own launch-scoped queue. Per-launch Safety still denies `git push`. This proves transport wiring with simulated providers, not native lifecycle dispatch.
- `scripts/spikes/codex-native-controls.mjs`: **installed runtime, no model call**. Codex 0.154.0 discovers `preCompact`, `sessionEnd` and `stop` from the isolated user layer with three-second timeouts, alongside the session-flags hook. Its untrusted project hook stays excluded. Positive read/write controls and actual native read-only write denials also passed. Discovery does not prove native event dispatch.
- The browser Settings workflow now toggles capture off/on in the Claude-filtered view and verifies persistence after reload, application success and continued reachability. The initial matrix exposed a delayed checkbox state during APM application; the UI now shows its pending state immediately. The complete rerun is recorded in REPORT.md.
- [J2's live manual journey](J2.md) now proves installed Codex lifecycle dispatch through the complete owner loop. Its ledger contains a hook-sourced proposal during the real implementation, followed by an owned checkpoint and publication. The driver did not synthesize or invoke the hook. Coalescing means this receipt does not prove every individual lifecycle event separately. [J1](J1.md) closed an answer-only reply without automatic capture or Git changes.

The focused bridge/delivery/owner cases passed after correcting a fixture's Git filename quoting. Both SDK coexistence cases passed after the fixture learned the SDK's `--setting-sources=value` argument form. The hook's lightweight entry avoids loading SQLite and emitting its experimental warning on every native event. Final complete-suite results are recorded in REPORT.md.

## Reference and limits

Read-only Garrison sources: `fittings/seed/basic-memory/scripts/setup.sh`, `scripts/agent-continuity.py`, `tests/basic-memory-backend.test.ts` and `tests/agent-continuity.test.py`. Adapted behaviors include metadata-only capture, input allowlisting, project scoping, deferred capture, retry identity, repeated setup, preserving unrelated hooks and refusing incomplete delivery. The obsolete standalone transcript-tail capture, native memory importer, shared/global vault, peer roster and recall hooks are deliberately excluded by Jevellan's brief.

[Codex hook documentation](https://learn.chatgpt.com/docs/hooks) describes account hook files, additive config layers and the three-second SessionEnd limit. [Claude hook documentation](https://code.claude.com/docs/en/hooks) describes account settings and lifecycle command input. Runtime discovery and protocol fixtures above are the local evidence; documentation alone is not an execution pass.

Live Claude lifecycle dispatch and Claude SDK vision checks remain blocked by the missing dedicated Claude token. Native Codex dispatch now has the live J2 evidence above; separate live coverage of each coalesced event remains unclaimed.
