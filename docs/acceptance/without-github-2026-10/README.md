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
