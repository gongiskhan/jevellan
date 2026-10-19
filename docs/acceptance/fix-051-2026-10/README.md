# Coordinator hang, automatic fixes on moved heads, release 0.5.1

Run log for the 19 October 2026 brief: diagnose the coordinator hang live, fix it and the automatic fixes that fail after someone else pushes to the pull request, release 0.5.1 on both machines, and rerun the blocked live journeys on `jevellan-live-sandbox`. Times are UTC. Every result is labelled live, simulated or not run.

## Clocks

- Phase 0 started: 2026-10-19T01:41:08Z on dev-madrid, source `e0718526`, clean, on `main`.
- Build clock (phases 0 to 2): six hours from the first commit of this run. First commit: 2026-10-19T02:01:43Z (its author time; the commit was amended before the push only to add this line); deadline 2026-10-19T08:01:43Z.
- Live clock (phase 3): two and a half hours from the moment both machines report 0.5.1. Not started.

## Phase log

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 Diagnose the hang | Complete, 01:41–02:00 (live). Root cause not established | Below; private records in `~/.jevellan-build/fix-051/diagnosis/` on dev-madrid |
| 1 Fixes | Not started | |
| 2 Release 0.5.1 | Not started | |
| 3 Live journeys | Not started | |
| 4 Closing | Not started | |

`PRD.md`, `PLANING.md` and `TASKS.md` do not exist in this checkout, so there was nothing to update there. `PLAN.md` stays as context.

## Phase 0: diagnose the hang (live)

Steps 1 to 4 were read-only, except for one `kill -USR1` to turn on the inspector and one heap snapshot. Step 5 was one normal service restart. No thread or provider turn was running at either point, and none was cut.

### 1. The state point's lifecycle (01:42)

- `jevellan.service`: main PID 2446679, parent the user's systemd, started 2026-10-18T23:45:43Z (the 0.5.0 update), zero restarts.
- Open lifecycle operations: one, "Interpreting a project request" (`project_request_cev_01M58QSZCGR0CZ2T5268FBB7SS`), plus short-lived HTTP request entries. A non-blocking probe of the lifecycle database was refused an exclusive lock, because the daemon holds its shared admission for that operation.
- `/api/health`: 0.5.0 OK. `jevellan doctor`: nine checks OK; Accounts WARNING "3 of 3 enabled accounts last reported ready on this device. 1 status checks need refreshing in Settings"; Jev reachable.

### 2. Both coordinators (01:42)

| Project | State | Queue | Last coordinator turn | Open classification |
| --- | --- | --- | --- | --- |
| `jevellan-live-sandbox` | idle, no session | 15 events, headed by LP1's user message (00:08:28) | 2026-10-18T20:38:37Z | Yes. LP1's message has no `request-outcomes/<eventId>.json` |
| ekoa-code | idle, session since 23:46:18 | 0 | turn 115, 2026-10-19T00:35:13Z | None |

**ekoa-code was not stuck.** It ran coordinator turns 96 to 115 between 23:46 and 00:35, after the 0.5.0 update and after LP1's message, and its queue is empty. It simply had no new owner message. The one-mesh handoff said ekoa-code had no coordinator turn since 17 October; that evidence was stale.

### 3. Where the outcome promise waits (01:45–01:49)

The inspector was turned on with `kill -USR1` after the PID, parent chain and start time were checked against the unit. It listens on 127.0.0.1:9229 only. A script attached through the Chrome DevTools Protocol, took one heap snapshot (3.3 s pause, 145 MB heap), analysed it and deleted it. No breakpoint was set, and the inspector stayed on loopback until the restart closed it.

What the snapshot showed (facts; the reading of them is a hypothesis, under 6):

- **No frame for the wait.** The heap held no suspended frame for the outcome callback, `decideProjectOutcome`, `askJev`, `JevClient` or the coordinator's turn preparation, and no `JevClient` object.
- **It got past every read.** The sandbox coordinator's outcome signal carried the dependant set that only `JevClient`'s `AbortSignal.any()` creates (`packages/decisions/src/client.ts`). The set was empty, the signal was not aborted, and it had no abort listener. On the state point, the settings, configuration and key reads are synchronous SQLite reads, so the request had passed all three and reached the HTTP attempt.
- **No Jev request in flight.** No socket to the Jev API was open. The retry delay would have held a live timer and an abort listener, and there was neither.
- **The coordinator still held the turn.** The sandbox coordinator's running-turn promise was pending.

### 4. The shared reads, timed against the running daemon (01:49)

| Read | Route | Result |
| --- | --- | --- |
| Configuration | `GET /hub/config` | 200 in 1.2 s |
| Settings | `GET /api/runtimes` (reads the `x-jevellan` settings) | 200 in 0.1 s |
| Jev credential summary | `GET /hub/secrets/jev` | 200 in 0.06 s, saved |
| Jev check (client, key and HTTP) | `POST /api/decisions/check` | 200 in 1.4 s, connected |

All four answered, each well within the 30-second client timeout.

### 5. Restart (live)

- **Fresh checks at 01:55:28.** The PID, parent and start time matched the unit. No runtime process ran under the daemon. The only open operation was the stuck classification, and the sandbox queue held 15 events. The coordinator states, activity and listings were copied privately before and after.
- **The restart.** `systemctl --user restart jevellan.service` ran at 01:55:29.8. systemd logged Stopping at 01:55:29.8 and Stopped at 01:55:34.9 (5.1 s), with no stop timeout, no kill escalation and no failure result.
  - The new daemon was listening at 01:55:36.5 and healthy on 0.5.0. The inspector port closed with the old process.
  - Before the restart, the code suggested shutdown would wait on the pending coordinator turn and run into systemd's 90-second stop timeout. That did not happen. Why the close finished is not established.
- **The replay.**
  - LP1's request was classified at 01:56:00.3 (source Jev, goal "change"), 25 s after the start.
  - Coordinator turn 43 ran from 01:56:01.2 to 01:57:33.7 and cleared the queue (15 to 0).
- **Tasks created by LP1:**
  - "README: add a short Contributing section", created at 01:56:51 and running in its thread;
  - "Unit test for invoice total rounding", created at 01:57:01 and queued at 01:58.

  Both are left to run as LP1 evidence for phase 3.

### 6. Diagnosis

- **Root cause: not established.**
- **What the evidence shows:**
  - The classification passed the settings, configuration and key reads and reached the Jev HTTP attempt (step 3).
  - It then never completed for 1 h 47 min, and nothing bounded that wait. The coordinator awaits the classification with no deadline of its own. Fresh session does not abort it, and the lifecycle gate counts it as running work.
  - The shared reads answered directly while it hung (step 4).
  - A restart cleared it, and the same request then classified in 25 s.
- **Hypothesis, not proven:** the Jev fetch, or its body read, became a promise nothing could settle, and the waiting chain was then garbage-collected. The absence of a frame or object in one heap snapshot supports this, but it does not prove that a fetch was dropped without settling.
- **Tested and not reproduced:** the combined abort signal being collected while a fetch waits. On Node 22.23.2, with garbage collection forced every 50 ms, the 1-second timeout fired in 3 of 3 runs against a server that never answers. The service journal around 00:08 holds nothing.
- **Ruled out:**
  - A wait on the maintenance or lifecycle gate: no awaited step touches it.
  - A configuration, settings or key read that never settles, as the cause of this hang: they completed for this request, and they answer.
- **For phase 1:**
  - The decision deadline races the whole decision against a timer the shared helper owns, so the caller settles even when an inner promise never settles and ignores its abort. A guard test uses exactly such a fetch.
  - Stop, Fresh session, Move and shutdown settle the outcome wait themselves and release the operation.
