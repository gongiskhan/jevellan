# Shared configuration, rigging and projects

**Live:** local HTTP, SQLite, isolated files and owner history. **Simulated:** member devices, network interruptions and providers. **Not run:** a complete member application, a live second device or successful Jev classification.

Versioned shared-state operations now expose configuration revisions, projects, rigging and the Jev credential separately from owner-local execution. Members fetch authoritative data through authenticated HTTP. The protocol does not expose a generic document store or allow a previous successful read to become authoritative during an outage. Configuration and project saves retain revision checks. Project settings cannot change while an associated checkout is held on another device; observed instruction-file state has its own revision-checked update.

The conversation service awaits these boundaries before new work and decisions. New requests record the configured step allowance; replay uses the durable recorded allowance. Generation checks after delayed responses prevent obsolete choices from launching. Running steps retain their delivered rigging and local stream/handoff storage. Credential-source unavailability remains distinct from an absent Jev key and prevents a provider request.

Account-local rigging promotion retains the existing source fingerprint, local claim and recovery record while awaiting remote validation and creation. Retry after a lost successful reply reconciles the captured item's stable identity. The destination API returns complete rigging bundles for delivery, with summary-only views for Settings.

Context operations, including original instruction contents and merge drafts, now live in versioned files in the owner's isolated home. Startup migration verifies conversation ownership, saves every local copy before removing shared documents, permits exact replay after interruption and preserves divergent copies for recovery.

## Verification

- Typecheck, lint and the production build passed. The initial typecheck identified test callers that still treated asynchronous views as immediate values; these were repaired. A direct test-only typecheck after Vite cleaned the web output required regenerating project references; the normal `npm run typecheck` did that and passed.
- The existing automatic/manual conversation, project-context and Jev-client suites passed **155 tests in four files in 748.40 seconds** before the final generation/retry refinements.
- After the final build, shared-state HTTP, context-operation migration, Settings API and rigging-promotion suites passed **31 tests in four files in 10.70 seconds**. This includes eleven new shared-state/migration cases: revision conflicts, held checkout settings, lost successful replies, editing a source during delayed validation, masked summaries, credential unavailability, response identity, interrupted migration, divergent copies and owner binding.
- Focused cancellation, stale decision, guard, composer and settings-outage checks passed **21 tests in two files in 56.40 seconds**; 82 unrelated cases were excluded by the name filter. The new application cases verify current allowances, no history creation when settings are unavailable, cancellation during a delayed read, concurrent identical composer retries, and local stream/handoff completion during an outage.
- **24 browser workflows passed in 2.7 minutes:** Settings, a manual planned change, context merge, rigging promotion/recovery, automatic-decision recovery and composer choices, each across desktop/phone and light/dark. The phone Why/correction view and desktop context completion were visually inspected.
- The full-history/worktree secret scan and whitespace checks passed. The preceding full backend result remains 611 passes and one missing-key live skip; this checkpoint's results above are targeted verification, not a new full-suite claim.
- The existing Tailscale progress preview returned HTTP 200 during this checkpoint. Its recorded real Codex demonstration remains separate from these simulated provider checks. No production service, native agent home or reference checkout was changed.

## Remaining work

At this checkpoint, application construction still initialized the hub role. The subsequent [joined application checkpoint](phase4-member.md) adds member construction, local application receipts and shared sign-in integration. Configuration/APM synchronization, heartbeats, owner routing, device UI, remote provider login, external sessions and two-daemon acceptance journeys remain. Neither checkpoint completes phase 4.
