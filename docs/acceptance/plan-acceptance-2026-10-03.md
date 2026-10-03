# Plan acceptance — 2026-10-03

The user requested that plans wait for acceptance and be readable enough to approve or request changes. This supersedes the brief's original default of continuing automatically after planning.

## Behavior

- Pause after a plan now defaults on. The existing setting remains available for an explicit future change. The current installation is also enabled through its revisioned configuration.
- Pending plans allow read-only discussion and further planning. They exclude implementation, tests, integration and completion from automatic choices and enforce that boundary before execution. Ordinary follow-up messages cannot count as implicit approval.
- Approve plan is bound to the current plan and conversation generation. Request changes provides an inline feedback form, validates the same context, and uses the existing explicit next-action override to run another planning stretch. Repeated feedback delivery does not duplicate the message or launch. Every returned plan needs new approval, even if its stored contents match a previous version.
- The plan is a dedicated reading card in the conversation's normal scroll. It has readable headings, numbered steps, file lists, checks, risks and decisions, with approval controls immediately below. Historical objects and JSON strings are rendered structurally; their complete stored contents remain unchanged. New planning briefs request Markdown. Loading failures show Retry and leave approval disabled.
- Existing work is preserved. The reported conversation had already run an implementation stretch before this change; it is not undone, reopened or described as awaiting its first approval.

## Evidence

**Simulated backend:** three focused cases passed: default approval pause followed by execution with the approved plan in its brief; discussion, explicit revision, delivery replay, stale-approval rejection and blocked unapproved execution; and durable invalidation of approval for an identical reissued plan. The two service cases passed in 22.50 seconds, and the separate ledger replay case passed in 1.83 seconds. The initial service fixture expected a specific rejection message, while the existing stale-retry guard rejected it first; the assertion was corrected without weakening the requirement that retry must fail.

**Simulated browser:** four desktop/phone light/dark workflows passed on the final build in 30.5 seconds and exercise structured plans, Markdown, JSON strings, reading without a nested scroll, load failure and retry, disabled unloaded approval, canceling feedback, sending changes with the plan/generation, approving and showing the approved state. The initial run exposed a section-title casing mismatch, which was corrected. Representative phone-light and desktop-dark captures were inspected, with subsequent refinements to headings and nested step titles. Providers and API results are fixture data; no real plan was approved.

**Live:** the new frozen release is serving the existing tailnet URL after an idle-gated restart. Served HTML matches the build, and the revisioned pause-after-plan setting is enabled. The normal configuration schema upgrade was materialized with the save; other effective settings are preserved. The one-time configuration setup was removed from the launcher. No live conversation was approved, revised, reopened or undone.

Typecheck, lint, production build and whitespace checks passed. Full unrelated suites, provider contracts, automated vision judging and physical-phone checks were not run. User acceptance is not claimed.
