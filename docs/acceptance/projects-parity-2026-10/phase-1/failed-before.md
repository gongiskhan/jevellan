# Retained failing checks

All entries below are simulated disposable fixtures. They are regressions and test-execution evidence, not owner acceptance.

| Check | Before | After |
| --- | --- | --- |
| Settings migrations and validation | 22 failed cases: stored v1–v3 were not v4; new fields/validation were absent | 22 pass |
| Paused admission | Paused and archived projects still admitted work | Both refusal regressions pass |
| Daily cap after a remote restart | Expected admission; got `New threads per day reached (2).` because the older start plan hid `restartedAs` | Restart relationship is retained; regression passes |
| Reserved job recovery while paused | `jobs.busy(id)` was true rather than false after recovery | Reservation stays pending while paused; regression passes |
| Paused memory dream, Run now | Expected rejection; got `{ schema: 'memory-dream-run-receipt-v1', accepted: true }` | Refused with `The project is paused.` |
| Pause immediately after admission | Expected an empty cwd; a new disposable worktree had been created | No preparation; first turn remains pending |
| Member environment credential | Expected the configured fixture value; received `[redacted]` | Authenticated internal fetch returns the value; owner responses still omit it |
| Saved instructions field | `getByLabel('Project instructions', { exact: true })` could not find the initially populated textarea | Explicit accessible names; unchanged save/reload assertion passes |
| Existing report size test | Old test expected 1,201 characters to be refused, despite Decision 841's existing 4,000 limit | Boundary test accepts 4,000 and refuses 4,001; product behavior unchanged |

## Execution failures

The initial overlapping full backend/browser runs hit the unchanged 60-second fixture startup deadline and 15-second default backend deadlines. Their partial results are not complete passes. A quiet serial run was stopped without failures so subsequent phases retain time. A quiet two-worker attempt then reproduced the existing Conversation test timeout:

```
an unfinished reply can hand execution to implement without asking the user again
16906ms
Test timed out in 15000ms.
```

The final complete run uses `--maxWorkers=2 --testTimeout=60000 --hookTimeout=60000`, preserving every behavior assertion and all product timeouts. Explicit longer per-test integration budgets remain in force. The browser fixtures' occasional shutdown `kill EPERM` warning is retained as an open verification concern; successful UI assertions do not prove clean process teardown.
