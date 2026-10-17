# Projects parity, October 2026

## Clocks and scope

- Orientation started: 2026-10-17T14:51:52Z.
- Build clock: 2026-10-17T14:59:21Z to 2026-10-18T04:59:21Z, from first commit 3d8e975b. No new feature phase starts after 2026-10-18T02:59:21Z (03:59 Lisbon).
- Live clock: not started. It starts at installation of 0.5.0 and ends three hours later.
- Baseline: da6a9bc96c9b963bb5b9bb2de609dbcddfa5dd06, main, source 0.4.1.
- Machine: Goncalos-MacBook-Pro.local. The actual local doctor identifies its Pro hub on 0.3.6. The separate Madrid 0.4.1 hub and Pro's retained Madrid member are distinct installations. Installation scope will follow doctor and the brief's current-machine rule; no unrelated installation is updated.
- Specification: root BRIEF.md, saved in full and ignored by Git. It supersedes conflicting older brief/plan decisions; untouched behavior stays.

## Phase log

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Reference, inventory, plan, roadmap and clocks | Pushed | Live checkout and local doctor; no product code changed |
| 1 | Settings v4, page, pause/archive and daily cap | Source complete; vision blocked | Simulated: 429 distinct backend cases, 8 browser journeys across 4 layouts, typecheck/lint/build and working-tree secret scan pass. See phase-1/. Full suites remain phase 10 gates. |
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

Live: local doctor reports Node22, APM, Basic Memory, Claude, Codex, daemon, hub and Jev available. Installed Pro version is 0.3.6. Accounts are historically Ready but need freshness checks; this is not live provider acceptance. Doctor's Git check is missing with shell AppleGit2.39.5; compatible Git must be available for release readiness. No runtime/service/account or other repository was changed.

Simulated: documentation-only phase checks validate roadmap JSON, the required phase/out-of-scope entries, ignored brief and whitespace. Backend/browser/vision suites are not run for this documentation checkpoint; changed behavior and full-suite evidence follows in its phase. No owner acceptance claimed.

## Decisions

846. The 17 October Projects parity brief becomes the authority for this run, replacing the older phase sequencing and delivery scope, rather than redoing completed unrelated work. The run follows ordered phases, a 14-hour build clock from its first commit, a separate 3-hour live clock and one closing crucial-issues review. Pro is the observed current machine/hub; the brief's Madrid installation description is historical. Release target 0.5.0 is unchanged.

847. Appendix A is a frozen owner-supplied parity reference. The new reference document restates it in plain prose and does not claim an independent current product audit. No new source behavior is delivered by orientation.

848. Settings v4 replace threadRules and the old modal; v1–v3 settings/v1 vault definitions migrate without resetting unrelated choices. Project instructions now store up to16,000 characters. Execution of the later placement/fix/environment/notification settings follows its own phase.

849. Pause/archive fence new work while retaining queued events/messages; resume sweeps it. Calendar-midnight admission counts durable starts and exempts replacements. Project environment secrets extend encrypted envelopes to the specified namespaced keys, with member-only credential fetches and metadata-only owner responses. See phase-1/README.md for regressions and evidence.

## Verification and live acceptance

Each feature phase requires backend regressions, typecheck, lint, affected four-layout browser journeys and tests/e2e/vision.ts. Dedicated missing credentials are recorded as blocked; real provider sessions and physical-phone acceptance remain distinct. Full backend/browser/build/secret suites and the one permitted closing review belong to phase 10. LP1–LP9 use only jevellan-live-sandbox, restore changed settings and retain sanitized receipts here under live/.

## Local run prerequisites

Live: Homebrew Git 2.56.0 is installed for the missing compatible Git capability. No shell profile or login was edited. A temporary AC-only caffeinate process keeps this run awake; system power preferences are unchanged, and the process is stopped at closing. Source/test operations use Node 22.22.0. The installed Pro service remains on its existing version until phase 10.
