# Phase 2: the coordinator conversation

Source scope: project instructions in coordinator context and stable thread snapshots; answer-in-place guidance; live task/thread cards; enforced Propose mode; owner-message-only proposed starts and permitted settings changes; field-specific Undo and coordinator event copy. Decisions850–852 are in the run log. The installed Pro hub remains on its earlier version until phase10.

## Simulated backend evidence

- The first two-file run had three failures and six passes before implementation: answer outcomes still demanded a task, Propose mode dispatched work, and instructions were appended to the task instead of snapshotted.
- The broader13-file run had153 passes and one failure out of154. That failure was an exact old tool-record expectation missing the newly required taskIds. The expectation now asserts each actual task id; the unchanged PJ2 behavior passes its targeted rerun.
- The final settings/prompts/tools/UI four-file run passes62 cases, including owner-turn fences, retry-safe appends, raw stored-field preservation and Undo. This overlaps the broader run. Further UI checks pass43 cases, including duplicate delivery suppression and a500-turn history. The strengthened owner-turn case separately confirms the coordinator resumes the same session and receives the changed instructions.
- Undo's new owner route first returned404 in its failing regression. The field-only endpoint now passes, retaining stored memory settings and refusing a field changed since. A separate regression first showed the coordinator accidentally normalizing an unrelated stored memory mode; it now edits raw stored settings instead of the display view.
- A thread prompt regression found the launcher adding the journal hint after the owner's instructions. Its hint now comes before the session append. Exact full-append expectations remain in coordinator, publication and verification coverage.
- Typecheck, lint and build pass. Full backend/browser suites remain phase10 gates.

Run logs are retained outside the checkout under /private/tmp/jevellan-parity-p2-*.log. They are not committed because raw process/transcript diagnostics can contain private identifiers. The assertions live in tests/project-parity-chat.test.ts, project-coordinator-tools.test.ts, project-coordinator-prompts.test.ts, project-work-ui.test.ts and the affected existing integration files.

## Browser evidence

The existing PJ3 chat journey and the new PAR2 journey pass at1440×900 and390×844, each light and dark: eight unique journeys. PAR2 covers two proposals with no started thread, Start, Start all for its remaining sibling, live placement metadata, a follow-up card, one settings revision and Undo. PJ3 checks the thread link, live metadata and the card following its own reply. Screenshots are in screenshots/.

The final PAR2 repetition on the optimized history build passes in all four layouts. The first desktop attempt used an invalid fixture setting of20 threads per device; the supported maximum is10. Correcting that setup did not change the behavior assertions. Some fixture shutdowns still print a process-group kill EPERM warning after a passing journey. That pre-existing closing-check concern is retained, not described as a clean teardown.

Automated model vision through tests/e2e/vision.ts is **not run**: JEVELLAN_TEST_CLAUDE_TOKEN is missing. Every receipt records that reason under vision/. Screenshots were inspected directly for fit and readability; that is separate from model vision, physical-phone testing and owner acceptance.

## Live prerequisite checks

The installed Pro UI refresh reports both Claude accounts and the Pro Codex account Ready. Madrid Codex still reports Needs login. The sandbox has a saved project GitHub token. Its installed-UI Git check timed out; existing SSH did not authenticate to GitHub. A read through the already signed-in GitHub CLI succeeds, as does a command-local test of the existing credential-store helper without the system helper. No global Git settings, native agent homes or Ekoa work were changed. These are prerequisite observations, not LP journey passes. The live clock has not started.
