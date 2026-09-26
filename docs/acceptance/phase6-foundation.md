# Improver foundation

Current publication note (2026-09-26): this unfinished work is now included in the user-requested machine-handoff checkpoint on main. References below to local-only work, staging and publication blockers describe the historical build state. The running pilot is unchanged. See [handoff notes](machine-handoff-2026-09-26.md).

Date: 2026-09-25. Phase 6 is in progress. These are component results, not completed improver jobs or acceptance journeys.

## Implemented

- Version 2 of the configuration adds versioned schedule, job and project-selection settings. Version 1 reads normalize to the new defaults without rewriting history. Retrying an acknowledged old save still returns its original revision after upgrade, restart and newer changes; changed request contents remain a conflict.
- Routing groups use the last fourteen days of explicit corrections, exact action/field/from/to keys, redo weight two and minimum weight three. Duplicate records cannot inflate the count. Applied composer choices count; pending and superseded choices do not. Suppression requires three distinct new corrections, independently of redo weight. Compact evidence contains index identifiers and one-line context, not chat messages.
- A group can be sent to Jev with one preference question. Its returned probability and model identity are recorded. Draft validation requires a concrete field change and known evidence. Pure field edits and reversal preserve unrelated settings and refuse stale text. This is not yet the durable Apply/Undo workflow or its thirty-second window.
- Twenty-four hand-written saved state packets exercise the normal two-call decision engine. The evaluator substitutes current or proposed routing guidance, menu descriptions and effort guide, while fixture availability remains explicit. Before/after receipts retain choices, acceptance, changed cases and requested/returned Jev model metadata. See [case methodology](../../packages/decisions/cases/README.md).
- `npm run eval:decisions` runs those engineering fixtures with the dedicated live Jev key; optional configuration/proposal files select a comparison. It does not launch a generative runtime or read native logins. Missing credentials exit as blocked.
- Hub job claims distinguish project, job and manual/nightly identity. One connection wins; completed or skipped nightly work stays closed after restart. Failures need an explicit retry. Leases renew, expired jobs can receive a new owner, and old or wrong workers cannot renew or complete them. Claims do not replace checkout ownership or native-process lifecycle checks.

## Verification

The settings migration and existing core selection passed 26 checks. The routing/settings selection then passed 15 checks. The combined foundation, decision-selection, decision-state/memory and core selection passed **69 tests with one existing missing-key skip in six files**. This includes simulated responses for all 24 saved cases; it proves evaluation behavior, not live routing quality. Six additional job-claim/scheduling tests passed against two SQLite connections and restart recovery.

Typecheck and lint passed during these increments. The first settings typecheck exposed a Zod input/output mismatch around defaulted guards; the transform now explicitly supplies the current schema's input type. No product behavior was relaxed to fix it.

The live evaluation command exited **2, blocked**, with `JEVELLAN_TEST_JEV_KEY` absent. It made no Jev calls and produced no passing live case result. Existing commit-approval, GitHub authentication and dedicated Claude credential blockers remain unchanged.

The final combined selection passed **75 tests in seven files, with one existing missing-key skip, in 831 ms**. Final `npm run typecheck`, `npm run lint`, secret scanning and whitespace checks passed. This is component coverage, with actual local SQLite and simulated judge responses; no new full backend or browser-suite run is claimed. The existing Tailscale preview returned HTTP 200 and contains the phase-5 116-check result and recorded screenshots. The 660-file phase-5 staged checkpoint remains intact; these phase-6 changes remain separate and uncommitted on main.

## Still to implement

The subsequent [routing increment](phase6-routing.md) implements durable outcomes, atomic field edits, private read-only draft execution and backend routing orchestration. Application/HTTP integration and scheduling, the shared card UI, badge, quiet notice and trial log; memory candidate collection, Jev judgments, checked patch publication and revert; project-device dispatch; context suggestions; and J10/J12 browser journeys remain unfinished implementation, not environmental blockers.
