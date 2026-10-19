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
| 2 Release 0.5.1 | Gate accepted at 07:57:58 (simulated); the clock ended at 08:01:43 before the Linux archive, publication, backups and updates | Below |
| 3 Live journeys | Not run: 0.5.1 was not installed within the build clock | |
| 4 Closing | Complete: one closing review at about 08:00 (no serious issue), docs, handoff | Below; [HANDOFF.md](HANDOFF.md) |

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
- **Not supported by the evidence:**
  - A wait on the maintenance or lifecycle gate: no awaited step in the outcome path touches it.
  - A configuration, settings or key read that never settles: for the original request, execution had passed them (step 3), and they answered directly (step 4). Neither proves exactly where the original promise waited.
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
- **The run.** It ran in the four layouts with `JEVELLAN_VISION_EVIDENCE_DIR=docs/acceptance/fix-051-2026-10/vision`, from 03:27:48 to 03:31:45, with a load average of 14 to 23. All 4 passed.
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

## Phase 2: release 0.5.1 and update both machines

### Sequencing and gate setup

- **Version bump before the gate.** `c083ec8d` ("Release 0.5.1 version"), pushed at 03:48:23, bumps every package to 0.5.1 the same way `de5bb8ce` did for 0.5.0, and adds the 0.5.1 release notes to `docs/acceptance/REPORT.md`.
  - This came before the full gate, a small deviation from the brief's order. It changes version strings and notes only.
  - The full gate runs on this bumped source, and nothing is published or installed until the gate is accepted.
- **The gate**, on dev-madrid at `c083ec8d`, one heavy step at a time with `uptime` recorded:
  - build, typecheck, lint and the secret scan;
  - the full backend with six Vitest workers (Decision 916);
  - the full browser suite with vision off.
- **The gate's environment:**
  - the whole `.env` loaded;
  - the pinned APM 0.10.0 first on PATH;
  - umask 002, as in the previous accepted gate, whose umask-dependent installation cases are noted there;
  - the browser run's "not run" vision records in a private folder, so the tracked evidence is not overwritten. Tracked screenshots that the run rewrites are restored from git afterwards.
- **The classification baseline** is a private copy of the v0.5.0 build tree (`f212c3d3`), not a worktree or branch. All 3,819 files tracked at the tag match it byte for byte, its `dist` comes from that tree's own 0.5.0 release build, and its tests are the tag's originals.
- **The Darwin archive** builds on the Pro from a fresh private clone at `c083ec8d`, started at 03:48:51.
- **Deviation: overlapping heavy jobs.** The Darwin build overlapped Madrid's gate build, typecheck, lint and secret scan (03:48:28 to about 03:52). The heavy-job rule spans both machines, so this was a mistake. At 03:51:44, after the scan step had started, this run stopped only its own gate wrapper (PID 3782743, after checking its parent and start time). The scan finished by itself, and the secret scan passed. The full suites wait for the Pro build to end, and every later heavy job runs one at a time across both machines.

### Archives

| Archive | Built | Revision | Bytes | SHA-256 | Verification |
| --- | --- | --- | --- | --- | --- |
| `jevellan-0.5.1-darwin-arm64.tgz` | On the Pro, from a fresh private clone of GitHub, 03:48:51 to 04:03:05 | `c083ec8d` | 443,432,589 | `cdb19b01cee1fe48f97d7f8420f6ccc5f1f301e78523515254ad5ff9ee498e6b` | Extracted: 3,603 tracked files byte-identical to the revision, none different (279 tracked files are not shipped); its own CLI reports 0.5.1; its native terminal addon ran a PTY. The copy on dev-madrid matches the checksum |

### Gate results at `c083ec8d` (simulated)

| Step | Start | End | Result |
| --- | --- | --- | --- |
| Build (`npm run build`) | 03:48:28 | 03:48:32 | Passed |
| Typecheck | 03:48:32 | 03:48:52 | Passed |
| Lint | 03:48:52 | 03:49:14 | Passed |
| Secret scan | 03:49:14 | about 03:52 | Passed |
| Full backend (six workers) | 04:03:47 | 04:36:53 (33 min 6 s) | 2,425 passed, 0 failed, 1 skipped of 2,426 tests in 224 files; the skip is the opt-in `live-sandbox-node20` case |
| Full browser (vision off, four workers) | 04:36:53 | 05:58:22 (1 h 21 min 29 s) | 244 passed, 13 failed, 119 not run of 376. The not-run cases are the serial `projects.spec.ts` chains after their first failure in each projects layout |

**The 13 browser failures** go to classification below:
- LJ2 in desktop-dark and phone-dark: the new thread's pull request did not appear within 60 s;
- "Thread images open from folded history…" in desktop-light: a visibility timeout;
- LJ3 "five tasks…" in phone-light;
- J8 and J11 in all four layouts, each at the same `selectOption` timeout;
- the packed installation journey in desktop dark.

**Machine conditions during the browser run** (observed; their cause was not established, and this run's suites also had many fixture processes running):
- The kernel recorded OOM kills of Chrome processes at 05:14:21 and 05:14:43. Memory stood at 57.0 of 64.3 GB used, with no swap.
- The load average reached 69 at about 05:39 and 92 at about 05:50.
- SSH and HTTPS health checks to dev-madrid timed out between about 05:38 and 05:50. Tailscale SSH failed between 05:44 and 05:50 and recovered at 06:14.
- LJ2, Thread images and LJ3 failed between 05:13 and 05:16, and the installation journey in desktop dark failed at about 05:43.

**Evidence restored.** The browser run rewrites tracked screenshots and records across `docs/acceptance`. Its 334 changed tracked files were restored from git, and the 8 new screenshots it created were removed. Its "not run" vision records went to a private folder.

### Classification of the browser failures (simulated)

Each failed case is rerun alone, three times at `c083ec8d` and three times at the private v0.5.0 copy, each run in a fresh invocation with only its own fixture server, one heavy job at a time.
- A failure is a **regression** if it fails alone at main and passes at v0.5.0.
- It is **pre-existing** if it fails alone at both.
- It is **load-sensitive** if it passes alone at both.

The order puts the cases nearest to this run's changes first. At 06:16, after case 3, the remaining cases were reordered to put the installation journey, which exercises update and rollback, before J8 and J11. No completed run was repeated.

| # | Case | Alone at main | Alone at v0.5.0 | Class |
| --- | --- | --- | --- | --- |
| 0 | LJ2 native setup and merge routing, desktop-dark | 3 of 3 passed | 3 of 3 passed | Load-sensitive |
| 1 | LJ2, phone-dark | 3 of 3 passed | 3 of 3 passed | Load-sensitive |
| 2 | Thread images open from folded history, desktop-light | 3 of 3 passed | 3 of 3 passed | Load-sensitive |
| 3 | LJ3 five tasks obey phone drag, phone-light | 3 of 3 passed | 3 of 3 passed | Load-sensitive |
| 12 | Packed first run, active update, rollback and removal, desktop dark (installation) | 3 of 3 passed | 3 of 3 passed | Load-sensitive. The full-suite failure ("Jevellan did not become ready") was at about 05:43, in the high-load window |
| 4–7 | J8 simulated mesh journey, all four layouts | 0 of 3 passed in each layout | 0 of 3 passed in each layout | Pre-existing. All 24 runs, 12 at main and 12 at v0.5.0, fail at the same step: `locator.selectOption` times out after 15 s waiting for `getByRole('combobox', { name: 'Project', exact: true })` at `tests/e2e/skeleton.spec.ts:880`, about 20 s in, after the journey opens `/` |
| 8 | J11 simulated mesh journey, desktop-light | 0 of 3 passed | 0 of 3 passed | Pre-existing. All six runs fail at the same step after about 118 s: `locator.selectOption` times out waiting for `getByRole('combobox', { name: 'Project', exact: true })` at `tests/e2e/skeleton.spec.ts:967`. That is after the saved-note search and published-commit assertions (lines 965–966) pass. Like J8, the journey expects a conversation form on `/`, which now opens the first project |
| 9 | J11, phone-light | 0 of 3 passed | 0 of 3 passed | Pre-existing; the same `skeleton.spec.ts:967` Project combobox step in all six runs |
| 10 | J11, desktop-dark | 0 of 3 passed | 0 of 3 passed | Pre-existing; the same `skeleton.spec.ts:967` Project combobox step in all six runs |
| 11 | J11, phone-dark | 0 of 3 passed | 0 of 3 passed | Pre-existing; the same `skeleton.spec.ts:967` Project combobox step in all six runs |

**Gate result: accepted under the brief's rule at 07:57:58, with no regression.**
- All 13 failed cases were classified, 78 isolated runs in all, from 05:59:37 to 07:57:58.
- **Load-sensitive (5):** LJ2 in desktop-dark and phone-dark, Thread images in desktop-light, LJ3 in phone-light, and the installation journey in desktop dark.
- **Pre-existing (8):** J8 and J11 in all four layouts. They fail at the same step at main and at v0.5.0: the journeys expect a project picker on `/`, which opens the first project.
- After the classification, the 30 tracked evidence files the reruns had rewritten were restored from git, and the one new vision record they created was removed.

### Release, backups and updates: not done

- The phases 0–2 clock ended at 08:01:43, with no time left for the steps after the gate. None of them was started:
  - the Linux archive;
  - the `v0.5.1` tag and GitHub release;
  - the cold backups of both homes;
  - the updates;
  - the confirmation.
- Phase 3 (live) did not start.
- Both machines still run 0.5.0, healthy and online, checked at 07:45.
- The Darwin archive stays private and unpublished.
- The scripts for the remaining steps are in `~/.jevellan-build/fix-051/bin/` on dev-madrid and the Pro.

## Phase 4: closing

- **Closing review.** One review for serious issues ran at about 08:00, over the full source diff since `e0718526`, and found no serious issue, so there was no second review or source change. The tested and versioned source is still `c083ec8d`, and the Darwin archive built from it is still current.
  - It checked the deadline helper (timers and listeners cleared, late rejections handled), every call site's existing fallback, the coordinator's Fresh, Stop, Move and shutdown paths, the head sync (fast-forward or merge, never rebase, conflict re-detection, push lease) and the scoped GitHub reads.
  - One non-serious note, recorded only: if a fix turn reported done without resolving a merge left in conflict, publication's leftover commit would commit it. The existing conflict turn has the same exposure, and publication verifies before it pushes.
- **Docs.**
  - `docs/projects.md` documents the decision deadline and the head refresh before fix turns.
  - Decisions 925 to 927 are in `docs/decisions.md`.
  - The roadmap, `PLAN.md` and `docs/acceptance/REPORT.md` are updated.
  - The handoff is [HANDOFF.md](HANDOFF.md).
