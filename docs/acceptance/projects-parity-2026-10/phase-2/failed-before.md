# Failed-before evidence

All entries below are simulated regressions. No provider acceptance is claimed.

1. tests/project-coordinator-prompts.test.ts, owner instructions and answer outcome: the fresh context began with Project notebook and the answer suffix demanded carrying the result into a thread task. The new assertion failed before the prompt change.
2. tests/project-parity-chat.test.ts, Propose mode: owner-request work became queued/dispatched instead of draft, even while the project said Propose. The new assertion failed before task admission changed.
3. The instruction snapshot case expected task "Read README." and instructions "Keep the original rule.". The old record instead put "Rules for every thread" inside task and had no instructions field.
4. The full system append then failed its instruction-tail assertion because the launcher's journal hint followed that block. Moving the hint before the session append fixes it without weakening the assertion.
5. The owner Undo route returned404 before implementation. Its test now checks the restored field, unchanged stored memory configuration and a409 when the field no longer matches.
6. The coordinator preservation case first changed an unrelated memory mode from hub to repo. The tool now uses raw stored settings and retains that mode exactly.
7. The duplicate delivery case first produced routed, routed, settings, settings. It now produces one task card and one Undo line, while the underlying ledger retains both transport deliveries.

Earlier exact record-shape and icon assertions exposed the new taskIds fields and two missing tool icons. Their explicit expectations now cover the new receipts and icons. No test was disabled and no functional assertion was loosened.
