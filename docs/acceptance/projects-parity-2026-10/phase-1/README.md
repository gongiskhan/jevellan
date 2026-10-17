# Phase 1: project settings and lifecycle

Source checkpoint for BRIEF.md phase 1. Activation is not claimed.

Settings v4 migrate all stored versions, preserve unrelated fields and rename threadRules to instructions. Vault-project-v2 preserves portable settings, accepts v1 and restores active. The standalone settings page saves one revision; status changes apply immediately. Secret values use the encrypted hub vault and the authenticated member credential route. Owner APIs return only saved-state metadata.

Pause/archive gates cover coordinator turns, thread preparation and turns, dispatch, goals, nightly items, jobs and memory sessions. Running work can finish. Pull request polling and owner controls remain available. Resume sweeps retained work. Calendar-day admission includes durable remote starts, excludes replacement threads and reports the cap on the queued task.

## Evidence

- Simulated: 22 migration, reserved-name/path and portable-vault cases failed before implementation and pass afterwards.
- Simulated: paused/archived admission regressions failed before their gates. Lifecycle tests exercise retained owner events/messages, resume and running-turn completion.
- Simulated: a stale remote plan incorrectly hid a newer restart relationship; its failing cap regression now passes.
- Simulated: recovery started a reserved command while paused; the regression failed before the gate and now passes.
- Simulated: Run now started a paused memory dream; the regression failed before the gate and now passes.
- Simulated: a pause immediately after admission created a worktree; the regression failed before the preparation fence and now passes, with its pending first turn retained.
- Simulated: a joined member received a redacted environment credential. The authenticated credential reply now follows the existing GitHub/Jev bypass; public responses remain redacted and values remain encrypted at rest.
- Simulated: the first browser run could not find an initially populated instructions textarea by its label. Explicit accessible names fix saved textarea controls. Its unchanged save/reload assertion passes.
- Simulated: the existing report-boundary assertions still used 1,200 despite Decision 841's existing 4,000 limit. Tests now verify the current 4,000 boundary without changing product behavior.
- Not run: automated vision judging lacks JEVELLAN_TEST_CLAUDE_TOKEN. The browser fixture records this separately; screenshots are directly inspected.
- Not run: real-provider acceptance and owner/physical-phone acceptance. LP journeys follow the release.

Affected backend and browser totals, build/typecheck/lint and secret-scan evidence will be recorded before this checkpoint is committed. The complete backend/browser suites remain phase 10 closing gates. Initial overlapping full/backend/browser attempts hit startup/test timeouts under load and were stopped; they are not passes. Browser fixture cleanup also reported kill EPERM in one run; this remains visible for closing verification.

Screenshots are in screenshots/. They contain disposable fixture data and no secret values.

The quiet two-worker run also reproduced a 15-second default harness timeout in the existing two-runtime-turn Conversation test (16.9 seconds observed before termination). The complete rerun uses two workers and a 60-second default test/hook budget, alongside the suites' existing explicit longer integration budgets. No product timeout, assertion, test body or configured default is changed by this execution flag. The earlier attempts remain non-passing; the serial attempt was stopped without failures to keep time available for later phases. This operational choice is separate from the live journeys' unchanged deadlines.

The exploratory full-suite rerun with a 60-second harness budget was stopped without failures after confirming the previously timed-out Conversation case. It is not a full pass. Per the brief, this phase closes with its affected backend checks; the complete suites close in phase 10.

## Final phase verification

Simulated: 429 distinct affected backend cases pass. The 33-file run passed 399 of 402 before three exact project-list expectations were updated for the new active status. All three failed cases then pass unchanged in behavior, explicitly asserting the added field. Two additional paused/archived PR polling-and-owner-merge cases and 25 thread-bridge cases pass. New quota and reserved-job resume checks are included.

Simulated: eight distinct browser journeys pass, two cases across desktop 1440×900 and phone 390×844 in light and dark. The saved settings, revision conflict/Reload, pause/resume, archive/unarchive and manual-git policy are exercised. A final desktop settings rerun passes after radio-label alignment. To avoid fixture startup contention, layouts were run sequentially with one selected project and its existing fixture from playwright.config.ts; test bodies, assertions and browser timeouts were retained. The original parallel startup failure remains recorded.

Simulated: final typecheck, lint and production build pass. The normal Vite chunk-size advisory remains. Working-tree secret scan passes; the normal push hook scans reachable commit history before publication.

Not run: 24 dedicated model vision verdicts, because JEVELLAN_TEST_CLAUDE_TOKEN is absent. The four settings layouts, mobile pause banner and dark archived sidebar were directly inspected; this is separate from automated vision and physical-phone acceptance. Screenshots and their vision receipts are retained here. Full backend/browser suites and real LP journeys remain phase 10 gates; no full-suite pass or owner acceptance is claimed.
