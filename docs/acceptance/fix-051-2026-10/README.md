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
| 1 Fixes | Complete, 02:08–03:35 (simulated): failing-first tests red, then green; affected tests, PAR4 with vision in four layouts, typecheck and lint pass | Below; red and green logs in `~/.jevellan-build/fix-051/phase1/` |
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

## Phase 1: fixes, each with a test that failed first (simulated)

Phase 0 established no root cause beyond the missing deadline, so Fix A is a guard. It does not claim to fix a deadlock. The decisions are 925 to 927 in `docs/decisions.md`.

### Fix A: one overall deadline per Jev decision

- **The deadline.** One shared helper in `@jevellan/decisions` (`withDecisionDeadline`, `runDecision`, `deadlineClient`) owns a timer of 2 × `timeoutMs` + 1 s + 5 s.
  - It races the whole decision, so a decision settles with `JevError('timeout')` even when an inner promise never settles and ignores its abort.
  - An abort settles it at once with `JevError('cancelled')`.
- **The daemon's source.** The daemon's `decisionClient` is a decision source. Each decision obtains its client (the configuration read) inside the deadline, and the key read and every HTTP attempt run inside it too. The deadline length comes from the last configuration read.
- **Every call site uses it:**
  - the request outcome;
  - placement p-v1 and the account choice a-v1;
  - follow-up routing;
  - the merge route m-v1;
  - conversation q-v2;
  - memory selection and memory care;
  - the routing improver.
- **Settings reads.** The request outcome's model read (`project-work.ts`) moved inside the deadline, as did those of follow-up routing and the merge route.
- **The coordinator prompt** now carries "Jev could not interpret this request" for an unavailable outcome.
- **Abandoning a classification.** Fresh session, Stop, Move coordinator and shutdown abandon an in-flight classification and release its operation. Fresh runs the next turn at once.

| Test (red first, then green) | Red | Green |
| --- | --- | --- |
| Configuration read never settles: the coordinator turn starts within the deadline with the instruction | Failed: no turn in 6.5 s | 2.1 s |
| Key read never settles | Failed: no turn | 2.0 s |
| Settings read for the decision model never settles | Failed: no turn | 2.0 s |
| HTTP attempt never settles and ignores its abort | Failed: no turn | Passed |
| Fresh session during a hung classification: operation released, next turn runs fresh | Failed: no turn in 5 s | 0.6 s |
| Stop during a hung classification: released at once, owner message stays queued | Failed: Stop hung past 30 s | 0.2 s |
| Move coordinator during a hung classification hands the queue over | Failed: hung past 30 s | 0.2 s |
| Shutdown during a hung classification completes | Failed: close hung | 0.2 s |
| Maintenance gate requested during a hung classification is granted within the deadline | Failed: not granted in 6.5 s | 1.9 s |
| m-v1 route request that never settles: ask-owner within the deadline (daemon path) | Failed: test timed out at 90 s | 18.2 s |
| Placement p-v1 falls back (timeout) within the deadline (daemon path) | Failed: test timed out at 90 s | 15.5 s |
| Owner message gets its coordinator turn within the deadline (daemon path) | Failed on the unmodified v0.5.0 build: no turn in 24 s, then the fixture's close hung | 15.1 s |

- **Timings.** The coordinator cases use a 1.5 s test deadline. The daemon-path cases use the configured 4 s timeout, so a 14 s deadline.
- **The daemon-path outcome test.** Its first red run does not count: its fixture had no coordinator-capable model. The corrected test was rerun against a private copy of the unmodified v0.5.0 build tree.
- **Helper unit tests.** `tests/decision-deadline.test.ts` covers the helper itself: the formula, a never-settling and abort-ignoring fetch through `JevClient`, cancellation, and pass-through.

### Fix B: fix turns start from the pull request's current head

- **Catching up the worktree.** Before a `checks`, `conflict` or `comments` turn on a worktree thread with an open pull request, the thread first fetches `refs/pull/<n>/head` into `refs/jevellan/threads/<tid>/pull-head`. This applies to automatic fixes and to the Fix checks, Resolve conflicts and Address comments buttons.
  - With nothing unpushed, it fast-forwards to that head.
  - Otherwise it merges, never rebases. A conflicted merge goes to the turn, whose prompt names the conflicted files first.
  - The thread notice reads "Updated the worktree to pull request #{n}'s head {short sha} before this fix.", and the next push leases on that head.
- **Scoped GitHub reads.** Thread-scoped `jevellan_github` reads use the pull request head as this device's tracker last read it. A thread may list runs, but only those on that head.
- **The checks prompt** names the failing runs and jobs by id.

| Test, against the fake GitHub (red first, then green) | Red | Green |
| --- | --- | --- |
| Owner commit, then failing checks: worktree at the new head, the failing job log readable in thread scope, runs on the head listed, run and job ids in the prompt, and the fix publishes on top | Failed: worktree at the old head | Passed |
| Fix checks button after an owner commit | Failed | Passed |
| Review comment on top of an owner commit | Failed | Passed |
| Conflict turn after an owner commit | Failed | Passed |
| Local unpushed commit plus a conflicting owner commit: a merge (two parents, never a rebase) and a turn that resolves the conflict | Failed | Passed |

The first case also showed that a fix turn which caught up could not publish: its push still leased on the thread's own earlier push. The fix leases on the fetched head.

### Affected existing tests (simulated)

These are the 33 existing files that exercise the changed code: the coordinator, follow-ups, runner, automatic fixes, placement, merge gate, shared memory, bridge, conversations, lifecycle, doctor, GitHub reads, the improvers and memory care. The full suites run once in phase 2.

| Run | Files | Tests | Passed | Failed | Notes |
| --- | --- | --- | --- | --- | --- |
| affected-1 (02:33–03:01) | 33 | 505 | 498 | 7 | All 7 are intended contract changes, none a product regression |
| affected-2 (03:09–03:17): the 3 updated files and every new regression file | 8 | 91 | 90 | 1 | PJ2d ran an assertion from before its update finished |
| affected-3 (03:18): `projects-coordinator` | 1 | 8 | 8 | 0 | |

The seven intended contract changes, each with its expectation updated to assert the new behaviour explicitly rather than loosened:
- **Six exact coordinator prompts** in `project-coordinator-loop` (2) and `projects-coordinator` (4, one of them PJ2d with three prompt checks):
  - Their fixtures save no Jev key, so each owner request is now uninterpreted, and the prompt carries the new required line "Requested result for … (unavailable): Jev could not interpret this request. …" (Decision 925).
  - The expectations now require that line, through `uninterpretedBlock` and `withEventIds` in the shared test helper.
- **The thread scope's blanket refusal of `runs`** in `project-github-awareness`:
  - The expectation now requires that a thread lists only the runs on its own pull request head, asked of GitHub with `head_sha`.
  - The refusals of other lists, other pulls and another head's run and log are unchanged.

### Browser journey with vision (simulated product, live vision judge)

- **What changed.** The PAR4 automatic-fix journey now has the owner push a commit to the pull request branch first, through the new fixture action `owner-commit`, before the failing checks. The journey checks that the thread shows "Updated the worktree to pull request #1's head {short sha} before this fix." under Session notices.
- **The run.** It ran in the four layouts with `JEVELLAN_VISION_EVIDENCE_DIR=docs/acceptance/fix-051-2026-10/vision`, from 03:27:48 to 03:31:45, with load average 14 to 23 from other users' CI on the machine. All 4 passed.
- **Vision.** 16 live vision receipts, with 0 blocking and 67 cosmetic findings, recorded only.
- **Where the images are.**
  - The new screens are in [screenshots/](screenshots/).
  - The journey's other judged images are in [screenshots/par4-judged/](screenshots/par4-judged/). The journey writes them into the 17 October parity folder, so they were copied here byte for byte, and that folder's tracked images were restored.
  - [vision/manifest.json](vision/manifest.json) pairs each receipt with its image and SHA-256.
- **Two earlier attempts failed in the harness, not the product:**
  - The fixture's first thread could not start because the shell's `apm` was the system 0.24.0. The previous run's scripts put the pinned APM 0.10.0 first on PATH, and this run's scripts now do the same.
  - The notice locator anchored the start of the text, but the notice line has a time before it.

### Verification

- `npm run typecheck` and `npm run lint` pass (03:32–03:33).
- The targeted and affected tests are as above.
- The full backend and browser suites run once in phase 2.
