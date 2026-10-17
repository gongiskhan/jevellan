# Projects parity, October 2026

## Clocks and scope

- Orientation started: 2026-10-17T14:51:52Z.
- Build clock: starts at the first commit of this run; its exact commit time is recorded at the next checkpoint. Fourteen hours total; feature intake closes after twelve hours.
- Live clock: not started. It starts at installation of 0.5.0 and ends three hours later.
- Baseline: da6a9bc96c9b963bb5b9bb2de609dbcddfa5dd06, main, source 0.4.1.
- Machine: Goncalos-MacBook-Pro.local. The actual local doctor identifies its Pro hub on 0.3.6. The separate Madrid 0.4.1 hub and Pro's retained Madrid member are distinct installations. Installation scope will follow doctor and the brief's current-machine rule; no unrelated installation is updated.
- Specification: root BRIEF.md, saved in full and ignored by Git. It supersedes conflicting older brief/plan decisions; untouched behavior stays.

## Phase log

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Reference, inventory, plan, roadmap and clocks | Documentation ready | Live checkout and local doctor; no product code changed |
| 1 | Settings v4, page, pause/archive and daily cap | Not started | Not run |
| 2 | Coordinator instructions, answers, cards, proposals and settings | Not started | Not run |
| 3 | Overview, resolution and thread actions | Not started | Not run |
| 4 | Automatic pull request fixes | Not started | Not run |
| 5 | Account waits, placement bounds, escalation and usage | Not started | Not run |
| 6 | Web push | Not started | Not run |
| 7 | Library, attachments, environment and scoped rigging | Not started | Not run |
| 8 | Compatible endpoints | Not started | Live credential optional, not requested yet |
| 9 | First-run setup | Not started | Not run |
| 10 | Docs, cleanup, suites, review, release and LP1–LP9 | Not started | Not run |

## Orientation evidence

Live: checkout clean on main at the specified baseline; fetch confirms origin/main matches. AGENTS.md and the required Projects, loop, decisions and Madrid acceptance documents were read. PRD.md, PLANING.md and TASKS.md are absent. CodeGraph is present and is used before code exploration. Native memory registry has no matching Jevellan entry. Existing shared handoff was read without modifying Basic Memory.

Live: local doctor reports Node22, APM, Basic Memory, Claude, Codex, daemon, hub and Jev available. Installed Pro version is0.3.6. Accounts are historically Ready but need freshness checks; this is not live provider acceptance. Doctor's Git check is missing with shell AppleGit2.39.5; compatible Git must be available for release readiness. No runtime/service/account or other repository was changed.

Simulated: documentation-only phase checks validate roadmap JSON, the required phase/out-of-scope entries, ignored brief and whitespace. Backend/browser/vision suites are not run for this documentation checkpoint; changed behavior and full-suite evidence follows in its phase. No owner acceptance claimed.

## Decisions

846. The 17 October Projects parity brief becomes the authority for this run, replacing the older phase sequencing and delivery scope, rather than redoing completed unrelated work. The run follows ordered phases, a14-hour build clock from its first commit, a separate3-hour live clock and one closing crucial-issues review. Pro is the observed current machine/hub; the brief's Madrid installation description is historical. Release target0.5.0 is unchanged.

847. Appendix A is a frozen owner-supplied parity reference. The new reference document restates it in plain prose and does not claim an independent current product audit. No new source behavior is delivered by orientation.

## Verification and live acceptance

Each feature phase requires backend regressions, typecheck, lint, affected four-layout browser journeys and tests/e2e/vision.ts. Dedicated missing credentials are recorded as blocked; real provider sessions and physical-phone acceptance remain distinct. Full backend/browser/build/secret suites and the one permitted closing review belong to phase10. LP1–LP9 use only jevellan-live-sandbox, restore changed settings and retain sanitized receipts here under live/.
