# Phase 2 context workflow evidence

Date: 2026-09-24. The original component/browser evidence below uses actual local HTTP, SQLite and Git operations with simulated model replies. A subsequent [live single-device J11 journey](J11.md) also passed: Codex drafted read-only, the UI displayed the diff before Apply, and Jevellan independently verified and published the linked result. Cross-device and live Claude portions remain unverified.

Settings → Projects now offers Create AGENTS.md (checked by default on Add project), both keep choices, Merge, and Leave both. Projects with separate instruction files retain a decision badge and can still run conversations. Adding a single-file project creates its excluded compatibility link under checkout ownership. Stretch admission rechecks the files and records their observed state.

Each context request creates visible work. Tracked main-policy changes use the existing preparation, checkpoint, independent verification and publication path. Local-only links do not create commits. External projects reject tracked replacement and merging; newly created seed files and links remain locally excluded. A failed verification leaves the checkpoint reserved and Retry publishes it without replacing the files again.

Merge uses a read-only reply stretch with a merge-draft handoff. The original files, their fingerprint, project revision and complete draft persist across restart. The panel displays both replacements and Apply/Cancel. Approval is explicit and durable; Retry cannot bypass a pending review. Repeated request ids return the existing operation. Newer files or settings block application and preserve outside work. A completed merge checkpoint is bound to the drafting step so Changes and published undo include the applied files.

## Tests

The final complete Vitest run passed **318 tests in 30 files** in 298.27 seconds, including fifteen context service cases and twelve component cases. Typecheck, lint and the production build also passed.

`tests/project-context-service.test.ts` exercises authenticated routes with disposable project checkouts and local bare origins. It covers creation, both keep directions, leave, restart with an unapplied draft, explicit Apply, duplicate requests, stale files/settings, cancellation from both interfaces, ownership contention, failed verification followed by retry, external policy, local-only linking and undo of a published merge.

`tests/project-context.test.ts` retains the twelve component cases, including never-clobber behavior adapted from Garrison's `tests/claude-md.test.ts`. The first combined service/component run exposed a self-generated project revision invalidating a draft. Recording that observed revision before drafting fixed it; all 25 cases passed before the additional checkpoint/undo case was added.

The fifth Playwright workflow covers all four choice controls, draft cancellation, another draft surviving reload, unchanged source fingerprints before Apply, the two-file diff, application, completed work, and actual project creation with the default checked option. It runs on desktop and 390-pixel phone in light and dark. The full browser matrix passed **20 workflows** in 1.6 minutes. All eight new screenshots were visually inspected with no blocking overlap, unreadable text or unreachable controls. Phone dialogs scroll to the remaining file viewer. This is agent inspection, not the blocked Claude SDK vision check.

## Limits

Live Claude draft generation and the specified Claude Agent SDK screenshot judge are blocked by the missing dedicated test token. The model in these fixtures is scripted; local Git and independent test commands are real. Ambiguous interrupted mutations require inspection and settlement rather than automatic replay. Conflict integration and the broader undo-history gaps remain tracked in the phase 2 report.

## Screenshots

| Layout | Merge draft | Completed |
| --- | --- | --- |
| Desktop light | [Draft](screenshots/phase2-context-draft-desktop-light.png) | [Linked](screenshots/phase2-context-linked-desktop-light.png) |
| Phone light | [Draft](screenshots/phase2-context-draft-phone-light.png) | [Linked](screenshots/phase2-context-linked-phone-light.png) |
| Desktop dark | [Draft](screenshots/phase2-context-draft-desktop-dark.png) | [Linked](screenshots/phase2-context-linked-desktop-dark.png) |
| Phone dark | [Draft](screenshots/phase2-context-draft-phone-dark.png) | [Linked](screenshots/phase2-context-linked-phone-dark.png) |
