# Phase 2 work settlement evidence

Close this work now offers Publish, Keep them and Discard. Cancelled work exposes the same settlement route. Publish uses the daemon's verification and publication path; Keep reserves unpublished work; Discard saves the old tip before resetting to the work base. External projects only close with their files kept.

This checkpoint uses real local HTTP, SQLite, durable journals, Git, shell verification, owned processes and disposable bare origins. Runtime behavior and provider approval are simulated. It is not a live-provider or real-Jev acceptance journey, and phase 2 remains incomplete.

## Verification

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm test` — 272 tests in 29 files passed.
- `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` — 12 workflows passed, three in each desktop/phone and light/dark combination.

The first browser run passed Settings and Keep → Publish, but the new discard fixture sent account creation before sign-in completed (trace: HTTP 401). Waiting for the signed-in Runtimes screen fixed the fixture; the complete 12-case matrix then passed. No product authentication behavior was weakened.

## Integration evidence

Eight cases were added to `tests/conversation-service.test.ts`, bringing that file to 23 cases:

| Requirement | Observed evidence |
| --- | --- |
| Keep retains ownership; Discard preserves code and memory | A competing conversation cannot launch while checkpoints remain. The saved ref contains both value.txt and a memory note; reset restores the base and another conversation can then write. |
| Publish closes only after verification | A daemon receipt names the published SHA, the bare origin receives it, and closedAs remains closed-by-you. Retrying the same browser id appends no new events. Reusing it for another choice is rejected. |
| Cancelled work can settle later | Publication retains the original request, work id, counters and cancelled outcome, without an additional runtime launch. |
| Failed verification cannot close/publish | The original open work and reservation remain. A later cancelled-work publication failure preserves its cancelled outcome; Discard still recovers the checkpoints. |
| Discard protects uncommitted or published changes | An uncommitted file remains byte-identical; an already-pushed checkpoint cannot be reset. Both failures retain ownership. |
| External policy stays free of git mutations | Publish/Discard return 409. Close/Keep leaves refs, status and file contents unchanged while releasing the reservation. |
| Stale settlement cannot reset or launch concurrently | A message arrives during a delayed discard fetch. Generation fencing prevents reset, and a concurrent manual launch receives 409. |
| Interrupted settlement stays recoverable | The test records a saved ref, resets, then restarts before completion is recorded. Startup reports unfinished settlement, preserves the ref and launches nothing. A fresh request settles the reservation. |

Settlement intents, saved refs and completion/failure receipts are versioned journal documents. Startup never retries their effects automatically. The existing checkout owner is reattached before release, including after daemon recovery. The browser hides further new-work submission while the last closed work awaits settlement; the server enforces the retained reservation too.

## Browser evidence

The manual workflow now closes with Keep, reloads history and publishes through Close this work. It checks the real verification receipt and two completed settlement receipts. The third workflow creates a different checkpoint, keeps it, reloads, confirms Discard, checks the saved-ref receipt and sends a new request with a new work id. All layouts assert no horizontal overflow and no browser script errors.

| Panel | Desktop | Phone |
| --- | --- | --- |
| Close this work | [light](screenshots/phase2-settlement-desktop-light.png), [dark](screenshots/phase2-settlement-desktop-dark.png) | [light](screenshots/phase2-settlement-phone-light.png), [dark](screenshots/phase2-settlement-phone-dark.png) |
| Discard confirmation | [light](screenshots/phase2-discard-desktop-light.png), [dark](screenshots/phase2-discard-desktop-dark.png) | [light](screenshots/phase2-discard-phone-light.png), [dark](screenshots/phase2-discard-phone-dark.png) |

Representative desktop and phone panels were visually inspected: text, controls and confirmation copy are visible without clipping or overlap. This does not replace the brief's Claude SDK vision judge, which remains blocked by the missing dedicated Claude token.

## Remaining scope

Undo/redo, published-work reverts and explicit adoption of blocked uncommitted changes remain unfinished. Dirty Discard is intentionally refused until those files have been inspected and checkpointed; the UI for adopting blocked changes is still required. Integration now applies its queued memory before publication, but the complete conflict-plus-memory runtime path still needs evidence. Hook delivery, memory-only publication/conflict handling, context application, other timeline controls and the later phases remain on the roadmap.

No service was installed. No new commit or push was attempted against the unchanged COMMIT-APPROVAL and GH-AUTH blockers. No crucial-issues review was performed; the brief reserves that review for the end.
