# Phase 3 reference preparation

Read on 2026-09-24 while phase 2 verification was running. This is source preparation, not an implemented decision layer or a live Jev result.

Ekoa's local remote-tracking `origin/jev` points to `d81ae33782c3ca0a30d6e6e00cf184db3faeeb65`. Read `docs/jev/EXTENDING.md`, `DECISIONS.md` and `REPORT.md` completely before inspecting `api/src/llm/judge/contract.ts`, `jev-client.ts` and the contract-test inventory. The checkout was not switched, fetched or modified. Its environment files and credentials were not read.

The current [TypeSafe API reference](https://docs.typesafe.ai/api) agrees with the observed Ekoa wire shape: POST `/v1/systemone` receives model, state and a question map. Choice sends an option-to-description criteria map and returns choice, probabilities and confidence. Score sends an ordered criteria array and returns a fractional weighted score with zero-based probability keys, legend and confidence. Noul returns `noul`, without confidence. The envelope includes the returned model and token usage. Question keys do not contribute meaning; each memory question must contain its note's title and excerpt.

The [models reference](https://docs.typesafe.ai/models) documents GET `/v1/models` as a `models` array, with name, description and release date. It lists aliases; a configured versioned model need not appear in that list. A connection check must not reject a configured version solely because only aliases were returned.

Port the verified request mapping and relevant contract regressions when implementing the client: no empty question batch, Choice requires at least two options, Score has 2–10 ordered levels, only known option ids, required answers, finite probabilities, explicit rounding tolerance and honest missing usage. Preserve the returned model. Jevellan's state is JSON text as required by BRIEF.md, and its configuration selects the requested model.

Jevellan's own brief controls the transport: native fetch, a bounded timeout, one retry on 429/5xx after one second, no retry on 401, and manual fallback. Ekoa's generative fallback, tenant admission, billing, circuits, sector registries and evaluation thresholds are reference-specific and are not Jevellan requirements. No Ekoa credential may be borrowed for Jevellan's live checks.
