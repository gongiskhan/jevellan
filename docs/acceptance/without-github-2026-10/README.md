# Without GitHub: run log

## P0 orientation

Live: release-051 is closed by its pushed handoff. Both active devices report Online on 0.5.1. The complete brief, repository instructions, decisions attachment, continuity handover, Projects, loop, mesh and release handoff were read before implementation. PRD.md, PLANING.md and TASKS.md are absent on recheck.

Live: read-only inventory is complete in private `snapshot.md`, with raw receipts in `preflight.json`, `orientation.json`, `open-pulls.json` and `branch-protection.json`. The actual daily inventory route is `/dailies`; the earlier singular route returned 404. Branch protection was refused by the API and remains unknown. Existing work and settings were not changed.

The exact attachment source-location difference is recorded privately in `snapshot.md`. Older continuity rules superseded by the decisions are recorded there. The brief adopts the decisions document's proposals; no additional disagreement was found.

CodeGraph's existing SQLite symbol index was queried read-only first. It predates Projects, so implementation uses targeted source reads. No reindexing, agents, delegation, native-home changes or reference-repository changes.

Tests: not run for this documentation-only phase. The previous release's live journeys and cleanups remain not run. Their clock is closed.

## Clocks

P0–P9 build: 18 hours from the first new commit. Its exact time and deadline are recorded before that commit below and in private `clocks.json`. Release/install has a separate three-hour clock; live checks have three hours from both devices reporting 0.6.0. Neither later clock has started.

First new commit time: `2026-10-19T13:43:10Z`. P0–P9 deadline: `2026-10-20T07:43:10Z`.

## P1 health checks

Implemented versioned health definitions and run receipts, settings v5 migration from v1–v4, a project editor, Run now, and `jevellan health run <project> [<check name>] [--file <path>] [--json]`. Members relay to the state point. Requests use no agent, job, checkout or placement. Steps stop on the first failure, refuse redirects and sign-in headers, inspect at most 64 KiB, and retain only result metadata. The hub keeps 500 runs per check.

Choices: the editor can explicitly run a draft definition before Save, and shows its five latest receipts. Saving still uses the project's single revision. Duplicate check ids and credentials embedded in a URL are refused. No background health polling was added. The deploy display and automatic scheduling follow in P5.

Simulated: **145 backend checks in five files passed**, including settings migration, every refusal and failure reason, bounded bodies, retention, CLI exit codes/file handling, member routing and the real local control route. The exact API refusal fix was first reproduced by a failing regression test, then passed. Typecheck, lint and build passed.

Simulated browser journeys: **four passed**, desktop 1440×900 and phone 390×844, light and dark. Live vision: **eight checks passed**, using `tests/e2e/vision.ts` and its documented dedicated credential. Evidence is private in `p1-vision` and `p1-browser.log`.

Live: **the ERP check passed**. Discovery and coverage are in private `erp.md`; the definition and CLI result are `erp-check.json` and `erp-check-result.json`. The active project's settings are unchanged; application is reserved for the release switch. Production was not deployed, restarted or modified.
