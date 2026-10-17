# Phase 3: Overview and owner actions

Status: source complete; affected verification passes, with dedicated model vision not run. Source is not installed. The live clock has not started.

The Overview has Waiting for you, Ready for review, Working, Landing, Idle and Resolved groups. Chat and Overview share the phone surface. Pull requests, Queue and Routines have their own Overview tabs. Cards and thread pages use the same owner actions. Resolve retains work, Reopen clears it, and an hourly sweep resolves eligible threads after seven days without activity.

Owner fix actions use the existing runner; Publish uses managed verification and publication. The review-comment reads needed by Address comments are shared with phase4's upcoming automatic loop. Landing projection changes use fresh ledger ids and retain the existing hub index fences.

## Verification

- Simulated backend: the broader10-file run passed166 of167 cases; its remaining exact-result expectation was extended for the new GitHub update timestamp, and all32 GitHub client/awareness and Overview cases then passed. Later edge/API/UI runs passed56 and67 cases (overlap), followed by both hold-metadata cases and the two-daemon remote-action case. These are affected runs, not a full-suite claim.
- Simulated browser: all seven unique affected journeys pass in each of the four layouts across the recorded runs. The final phone-dark seven-case run passes in5.2minutes. The final scoped phone-light Overview/header run passes both cases; its preceding five journeys pass. The final settled desktop Overview repetitions pass in both themes. Assertions cover existing opening/chat/questions/transcripts/merge, phase2 cards/Undo, and phase3 groups/actions/publication/header layout.
- Simulated checks: typecheck, lint, build, whitespace and working-tree secret scan pass. The existing bundle-size warning remains. Full backend/browser suites and the normal push history scan remain separate gates.
- Not run: dedicated model vision. All88 screenshot receipts explicitly say JEVELLAN_TEST_CLAUDE_TOKEN is absent. Representative Overview and thread-header captures were inspected directly in all four layouts; this is not a model-vision pass or physical-phone acceptance.
- Not run: release installation and real-provider journeys, reserved for phase10. No Ekoa work, installed source, native homes or other owner checkouts changed.

The [before-repair assertions and harness failures](failed-before.md) retain each actual failure without native session identifiers or raw traces. The broader run's exact-result mismatch, invalid initial fixtures, interrupted attempts, output-folder collision, interception and bootstrap timing failures are not counted as passes. Final successful captures total88 images. Existing process-group shutdown cleanup warnings remain a closing-check concern.

The two-daemon remote-action test checks Resolve and Reopen on the owning member, managed Publish opening one PR without another model turn, and absence of member-private state on the hub.

## Implemented behavior

- The first matching board rule selects Resolved, Waiting for you, Working, Landing, Ready for review or Idle. A resolution marker wins, while an open pull request prevents owner or inactivity resolution. Recent resolved history starts at14days and expands by14.
- Resolve retains the worktree and branch, withdraws open questions and records its reason. Accepted follow-ups and Reopen clear the marker. The hourly owner-device sweep uses the injected clock and a seven-day activity boundary.
- Cards in chat and Overview share the owner actions. Fix checks, Resolve conflicts and Address comments use pending turns. Publish runs verification and managed publication without an extra model turn. Existing merge confirmation and backend holds remain.
- A versioned request receipt plus the pending-turn request digest makes retries safe across an acceptance/receipt crash boundary. Remote actions route to the owner device; the two-daemon test checks that member-private state does not leak to the hub.
- Landing facts are indexed through fresh ledger events. Current hold metadata uses the existing polled daily view on the project page and an optional thread-view field. A hub metadata outage leaves local thread content readable and cannot authorize a merge.
- Comment reads are bounded, cached and budgeted, with a durable local batch. Automatic fixes, rounds and the two-minute quiet window are phase4 work and are not claimed here.

## Boundaries

All browser and backend behavior in this phase uses simulated providers/GitHub and disposable homes. The screenshots are desktop1440×900 and phone390×844, light and dark. Direct visual inspection is separate from the unavailable model vision checks and from physical-phone acceptance. The release, installed service and real Ekoa work are unchanged. Full suites and the normal push history scan remain separate gates.
