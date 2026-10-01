# Conversation continuity and readable replies

The user reported that a short summary request closed existing work without answering it, after several verbose stretches. Live read-only inspection confirmed a routing-only completion and a repeated earlier closing summary. Private message text, session identifiers and raw evidence are not included here.

## Behavior

- Completion is unavailable while the latest message has not reached a completed response stretch with a non-failed handoff. The durable decision input identifies the message. Routing-only decisions, failed/interrupted/timed-out/undone steps and older in-flight replies cannot consume a new message. Legacy decisions use recorded launch chronology. Explicit user closure remains a separate control.
- Briefs foreground the latest message and retain the original work, constraints and plan as context. Summary, explanation and rewrite requests answer existing evidence without repeating completed operations. Workers lead with the result and obey requested brevity, with detailed requested reports kept intact.
- Bounded recent user/assistant exchanges cross closed-work boundaries. Saved answer results take priority over streamed narration, with stream/summary fallbacks, source pointers and explicit truncation. Undone steps are excluded. Closed work's constraints, blockers and next actions are not inherited as new obligations.
- A message following an agent question is chronological context, not proof the question was answered. Jev interprets freeform intent and receives the recorded question, options, selected answer and blockers without their premature deletion. There is no keyword router.

Design choice: keep fresh bounded stretches, account/model switching and project guards, while supplying up to 8,000 characters of recent conversation context. Full history remains reachable through the scoped conversation read/search tools. Completion gating is structural; choosing what the message means stays with Jev.

## Presentation

Assistant replies use a lightweight row with model and timing information. Consecutive tools share a disclosure with working/failure feedback; their full inputs and outputs remain available. Thinking stays expanded by default. Saved answers render inline; otherwise final streamed prose or the historical handoff summary supplies the answer. Recorded handoffs, findings, attempted approaches, account/effort/usage and historical questions remain under Step details. The latest open step retains actionable blockers. Exact duplicate closing notices are suppressed. Changes, Why, correction, message edit/retry and steer/queue controls remain available.

## Research

The design uses conversation continuity described in the official [Claude SDK sessions documentation](https://code.claude.com/docs/en/agent-sdk/sessions), the result-first and request-sensitive brevity described in [Claude Code output styles](https://code.claude.com/docs/en/output-styles), and the distinction between queued turns and live steering in [OpenAI's Codex remote guidance](https://developers.openai.com/blog/mastering-codex-remote-for-engineering). This is a design adaptation, not a claim that Jevellan reproduces their entire session engine or every UI feature.

## Verification

Simulated: 112 unique focused backend/transcript cases passed across the targeted run and final focused reruns; four dedicated-key live Jev cases were skipped because the test key is absent. Four desktop/phone light/dark browser cases passed. Backend checks cover the reported multi-step summary case, completed-work follow-ups, queued messages, failure/undo/recovery, redaction, bounded context and decision/brief behavior. Browser checks use isolated local fixture daemons and temporary Chrome profiles, in desktop/phone light/dark layouts. They cover one visible answer, durable answer and historical fallback, thinking expansion, tools/results/failures, details/corrections, exact timing, historical/current blockers, duplicate notices, edit/retry controls and horizontal overflow.

The first browser attempt was blocked by a missing bundled Chromium; the installed Chrome channel resolved it. The first seven-step regression exceeded its 15-second fixture timeout; that case uses 60 seconds. Dedicated live-provider contracts, automated vision judgments, a physical phone and full unrelated suites were not run. No native credentials were borrowed and the user's native homes were not changed.

Live: the reported existing conversation was inspected read-only and reloaded after deployment. A frozen release outside the checkout was activated only when the lifecycle gate confirmed idle. Health, tailnet HTML and protected account/project/authentication, encrypted-secret, configuration, vault-key and eight ledger-file hashes passed preservation checks. The rendered lighter transcript showed no captured browser errors. The original summary request was not resent. Deployment and final verification results are recorded in REPORT.md. User acceptance is not claimed.
