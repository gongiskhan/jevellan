# Decisions

Jev decides what the work means and which action, model and effort fit it. Code enforces available resources, runtime permissions, user choices and work limits. The implementation is in `packages/decisions`; conversation guards are in `packages/conversations/src/guards.ts`.

The current question set is **q-v2**, declared in `selection.ts` and recorded with automatic decisions. The seeded configuration requests `jev-1.13.0`, uses a 4,000 ms request timeout and keeps the current eligible model at a probability of at least 0.6. Settings → Decisions can change the configured model, routing profile, model descriptions and effort guidance; the Configuration editor exposes the timeout and threshold. These are application defaults, not claims about the provider's latest models.

## State packet

`buildDecisionState` produces a redacted `decision-state-v1` JSON document containing:

- Routing profile, effort guide and up to eight recent correction sentences: five from this project and three from other projects.
- Original request, latest user message, current state/next-work summary and the last three handoffs. Each handoff summary is limited to 400 characters and includes action, status, proposed next action, test outcome and blockers.
- Recorded facts: stretch/review counts, whether code changed, change size/files, risky areas, latest verification, publication conflict and whether the project has a test command.
- The current model's identifier, label, description and effort when available.

The packet does not contain the raw transcript. Its conservative size estimate is UTF-8 bytes divided by three, rounded up, with a 12,000-token cap. Old handoffs are removed first and their stretch numbers are recorded as omitted. If the required request and rules still do not fit, the decision falls back to manual selection rather than truncating the user's intent.

After-the-fact overrides and applied composer choices contribute correction context. Pending or rejected composer choices do not become evidence of an applied correction.

## Questions and resolution

Call A determines the action. Call B determines model and effort after resource eligibility is known. Questions with a fixed answer are omitted; a call with no questions is not sent.

| Question | Type | When asked and how used |
| --- | --- | --- |
| `next_action` | Choice | Asked when multiple allowed actions remain and the user has not overridden the action. Only allowed actions appear. |
| `remember_request` | Noul | Asked for a new message. A probability of at least 0.7 enables explicit remembering for a `reply` action. |
| `keep_current` | Noul | Asked if the current model remains eligible and the model is not fixed by the user. The configured threshold decides whether to retain it. |
| `pick_eligible` | Choice | Asked when more than one model is eligible and the model is not fixed. Selects among runnable models if the current one is not kept. |
| `pick_any` | Choice | Asked when enabled candidates include ineligible models. Records which model would fit absent account constraints and can explain a missing-login preference. It cannot select an ineligible account for execution. |
| `effort` | Choice | Asked unless effort is fixed by a one-step choice or pin. Criteria come from the configured effort guide. |

Noul answers are probabilities of the stated proposition. Choice answers include the selected option, a distribution and confidence. The client validates the answer type, required option keys, probability bounds and distribution sum. It rejects missing or inconsistent answers. It does not accept arbitrary provider text as an action.

Resource filtering considers enabled runtime/model entries, required tools, enforceable read-only behavior, account readiness, device, cooldown, capacity and paid-use rules. Account ranking then chooses among eligible accounts for the selected runtime. No eligible model leaves the work waiting with recorded reasons. An unavailable pinned model is not silently replaced.

A one-step model/effort choice takes precedence over a conversation pin. Otherwise Jev selects them; a single eligible model needs no model-choice question. Requested effort is mapped to the nearest supported effort, with both values and the adjustment notice retained. A publication conflict forces the integration action through a guard. `done` requires no runtime; `ask-you` can use an existing question or obtain one through a reply stretch.

## Memory selection

Project search supplies up to twelve note candidates. Each `memory_{index}` score question asks how useful that note is for the selected action, from 0 (not useful) through 3 (essential). Jevellan keeps at most five notes scoring at least 2, ordered by score with search order breaking ties. Excerpts are at most 300 characters; the brief has its own memory budget. Unresolved conflicting notes are labelled.

If memory scoring fails, the first five search-ranked candidates are used and the source is recorded as `search-rank`. This fallback selects recalled context only; it does not infer the next action, model or effort. See [memory](memory.md).

## Transport, failure and evidence

The client sends JSON to `POST https://api.typesafe.ai/v1/systemone` and checks aliases with `GET /models`. Internal versioned request/response schemas wrap the provider's wire format. Credentials are read from the hub vault, supplied as bearer authentication and omitted from persisted records. Redirects are refused. Provider error bodies are cancelled without being read because they may echo inputs or authentication.

HTTP 429 and 5xx responses retry once after one second. Authentication, malformed responses, network failure and request timeout become typed failures; cancellation aborts the request. The owner offers manual selection or an explicit retry. Missing credentials are never recorded as a successful classification.

The durable decision records the allowed/chosen action and source, eligible and excluded models, probabilities where available, model retention, requested/effective effort, account ranking, corrections shown and memory selection. Jev call records include requested/returned model, latency and usage. The **Why** drawer reads this saved evidence; opening it does not ask Jev again. **Test connection** in setup and Decisions checks model aliases and reports measured latency, not a completed classification.

## Changing the question set

For routing preferences, edit the configuration through Settings. Keep resource eligibility and work guards in code; do not add keyword or other heuristic routing around Jev.

For a semantic change to the questions, update `prepareAction`/`prepareModel`, their resolvers and the relevant state/memory builder together. Give the question set a new version and extend the versioned record schema while preserving readable historical records. If a stored document shape changes, add its explicit migration. Update the Why presentation only where the recorded evidence changes.

Run the decision-selection, state/memory, transport and automatic-conversation tests, then the affected browser journeys. Tests should cover the intended choices, eligibility, user overrides, malformed responses, cancellation and manual fallback. The saved-case evaluator and routing improver are still pending phase 6; a simulated response is not a substitute for the dedicated-key live evaluation.

See the [acceptance report](acceptance/REPORT.md) for the current live/simulated distinction and missing-credential blockers.
