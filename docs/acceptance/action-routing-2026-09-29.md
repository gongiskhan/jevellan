# Operational action routing — 2026-09-29

The reported bare `git pull` request was classified as reply. Reply intentionally has no shell access, so the worker stopped with a blocked handoff and suggested the unrelated integrate action.

The shared action descriptions and Call A instructions now distinguish performing work from explaining it. Implement includes operational commands without code edits; task simplicity belongs in effort selection. These instructions reach existing installations without replacing their configured routing profile. Jev still decides meaning: there is no command-string router or forced action. Integrate remains a guard-selected response to a publication conflict.

The reply contract now returns partial with implement proposed when execution remains requested. The implementation contract explains that first writing admission under main policy already fetches and fast-forwards clean main, so the worker should inspect that result rather than independently changing history. Existing dirty-checkout, ownership, history and publication guards remain intact. In particular, unrelated untracked files can still block writing admission; this fix does not commit, discard or adopt them.

## Evidence

- **Live observation:** inspected the failed decision and confirmed it selected reply; local main matched origin/main before changes. No private conversation identifiers or project contents are included here.
- **Local tooling, simulated providers:** 103 focused checks passed across decision selection, action contracts, saved-case evaluation, routing improver/API, safety hooks, Git admission and automatic conversations. The two new app scenarios exercise actual local HTTP/Git with simulated Jev/runtime responses: owned upstream fast-forward with no added checkpoint, and partial-reply recovery to a write-capable step. These do not prove live model classification.
- **Blocked:** four dedicated-key live checks (the existing smoke plus three new operational action cases) were skipped because `JEVELLAN_TEST_JEV_KEY` is absent. Native credentials were not used.
- **Local tooling:** build, typecheck and lint passed. Initial process-based fixture runs failed under sandbox restrictions; reruns with required process/HTTP access passed. One stale saved-case total assertion was corrected from 24 to 27, then its suite passed.
- **Not run:** full backend/browser suites, live generative execution and a retry of the user's original project command. The user's reported failure authorized these focused regressions, not a broad acceptance run.

Three new saved cases cover a bare update command, a politely phrased execution request and an explanation-only question. The existing evaluator now checks 27 cases; expected answers remain outside the request sent to Jev. The new live cases will run when the dedicated test key is available.

## Deployment

Deployed to the mini's isolated pilot release, retaining the existing state home and tailnet address. The old daemon exceeded the initial graceful-shutdown wait, then exited and released ownership; no forced stop was used. The prepared replacement started successfully. Loopback and tailnet health both returned HTTP 200, and the three deployed implementation files matched the verified build. Working-tree secret scanning and whitespace checks passed before commit.
