# Decision components — 2026-09-24

**Local component and transport evidence from the initial phase 3 checkpoint. Automatic owner execution is now connected; see [loop and UI evidence](phase3-loop.md). Live Jev remains blocked by the missing dedicated key.**

`packages/decisions` now implements the native HTTP client and the real provider wire builder. Versioned local envelopes surround the provider's documented request/response shapes; no local schema field is sent as an API field. State is JSON text. Choice, fractional zero-based Score and Noul responses are validated, returned model and usage are retained, and malformed answers are rejected without repair or invented values. Single-option Choice requests are refused before HTTP.

HTTP uses the configured timeout, one retry after one second for 429/5xx, and no authentication retry. The timeout includes reading the response body. Cancellation stops the request or retry wait. Error messages are fixed descriptions; provider error bodies and authentication values are not retained. The connection test reads the model listing without rejecting a configured version absent from its alias list.

Call A accepts the guard-computed allowed actions, resolves single options and overrides, and asks the independent remember question only for a new latest message. Memory write permission requires Reply and probability at least 0.7. Call B filters runtime capabilities and account eligibility, applies separate once/pin precedence for model and effort, implements the keep-current threshold and preferred-needs-login notice, maps effort upward and records account ranking. No eligible model produces waiting reasons; no semantic heuristic chooses a substitute.

The versioned state builder separates configuration rules from conversation evidence, includes the five latest project corrections and three elsewhere, limits recent handoffs to three with 400-character summaries, redacts known secrets and caps the packet at 12,000 approximate tokens. Oldest handoffs are removed first. This packet has no findings or middle messages; if protected request/rule text still exceeds the cap, it requires manual fallback instead of silently dropping intent. Jevellan's verification facts remain distinct from agent-reported tests.

Memory selection sends up to twelve Score questions in one request. Each question contains its note title and first 300 characters, including unresolved-version labels. Scores at least 2.0 qualify; the five highest are selected, with original search order breaking ties. Provider failure uses the top five search results without fabricated scores. Cancellation propagates instead of selecting fallback memory. The existing brief builder retains its 2,000-token memory cap in the connected owner loop.

## Verification

- **78 passed, one skipped, four files, 3.45 seconds:** `jev-client.test.ts`, `decision-selection.test.ts`, `decision-state-memory.test.ts` and the existing `conversation-brief.test.ts`.
- Transport evidence includes native fetch against a disposable loopback server, the actual serialized payload, and an unfinished response body that hits its deadline. Other provider replies are explicitly simulated.
- The skipped case is the real Call A/Call B smoke test, gated on `JEVELLAN_TEST_JEV_KEY`. Its absence is a blocker, not a pass. These checks make no claim about real Jev classification quality or automatic acceptance journeys.
- Typecheck, lint, production build and repository secret scanning passed. The shared action descriptions moved into core without changing their text; the conversation brief regressions remain green. The full 462-test/52-browser runs establish the earlier phase 2 checkpoint; the 78-check run above is the affected phase 3 verification, not a new full-suite result.

The subsequent [loop checkpoint](phase3-loop.md) connects owner execution, durable records, Settings checks, actual recall and HTTP/UI recovery. [Composer overrides and pins](phase3-composer.md) now have durable records, hub indexing and UI evidence. [J6](J6.md) passed actual invalid-key recovery with real Codex; the remaining successful-classification journeys still require the dedicated Jev key. The progress preview continues to label its actual model work as manually selected.
