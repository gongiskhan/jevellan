# Coordinator hang, fixes on moved heads and 0.5.1: handoff

## Owner steps

1. **Installations remain 0.5.0.**
   - dev-madrid (`jevellan.service`, `~/.jevellan-hub`) and the MacBook Pro member (`/Users/ggomes/.jevellan-member`) still run 0.5.0. 0.5.1 is **not** tagged, published or installed, and phase 3 (live journeys) could not start, because the build clock ended before the release steps (below).
   - The authorized phase 0 restart of `jevellan.service` did change state: it cleared the stuck classification, the sandbox coordinator resumed, and LP1's request created two real tasks, threads and pull requests (#22 and #23).
   - The release gate was **accepted** at 07:57:58 UTC under the brief's classification rule, with no regression. The six-hour clock for phases 0 to 2 then ended at 08:01:43, before the release steps after the gate: the Linux archive, publication, backups, updates and confirmation. Release, activation and the live journeys are therefore incomplete because of the clock, not because of the gate.
2. **To release 0.5.1 later,** the accepted gate at `c083ec8d` and the verified Darwin archive can be used as they are. The steps are:
   - **Archives.** The Linux archive still has to be built (`~/.jevellan-build/fix-051/bin/build-linux.sh c083ec8df17951e873433224ff9bf9217f13194a 0.5.1`). The Darwin archive is built and verified already.
   - **Publish.** Tag and publish with `~/.jevellan-build/fix-051/bin/publish.sh c083ec8df17951e873433224ff9bf9217f13194a 0.5.1`.
   - **Backups.** Take the cold backups with `backup-madrid.sh` on dev-madrid and `backup-pro.sh` on the Pro.
   - **Updates.** Update dev-madrid first (`update-madrid.sh <linux archive>`), then the Pro (`update-pro.sh <darwin archive>`), and check the result with `confirm.sh`.
   - **Live journeys.** Run phase 3 from the private harness `~/.jevellan-build/fix-051/live/`.
3. **Sandbox pull requests [#22](https://github.com/gongiskhan/jevellan-live-sandbox/pull/22) ("README: add a short Contributing section") and [#23](https://github.com/gongiskhan/jevellan-live-sandbox/pull/23) ("Unit test for invoice total rounding")** came from LP1's original request after the phase 0 restart. Both are open, with passing checks, and mergeable. Keep them open: LP1 and LP4 on 0.5.1 use them. No action is needed from you now.
4. **ekoa-code:** nothing was sent to it, and its settings, goals and `autoMerge` (off) are unchanged. `NIGHTLY_SCHEDULER` was not set.

## The hang

- **Root cause: not established.**
- **What the evidence shows (live, phase 0):**
  - LP1's request classification passed the settings, configuration and key reads and reached the Jev HTTP attempt.
  - It never completed. The awaiting chain was no longer in the heap.
  - The shared reads answered directly while it hung.
  - Nothing bounded the wait, and the lifecycle gate counted it as running work.
- **Hypothesis (not proven):** the Jev request promise became one nothing could settle. A reproduction of the suspected garbage-collection route failed.
- **Two kinds of evidence:**
  - *About the original pending request* (one heap snapshot of the hung daemon): execution had passed the settings, configuration and key reads and created the HTTP attempt's combined abort signal. No frame for the waiting chain remained.
  - *About the shared reads, checked directly while it hung:* the configuration, settings, Jev credential summary and live Jev check all answered.
  - Neither proves where the original promise waited. There was no sign that the lifecycle or maintenance gate was involved.
- **The restart.** A normal `systemctl --user restart jevellan.service` (a 5.1-second stop, no escalation) cleared it. LP1 was then classified in 25 seconds, and its coordinator turn created the two tasks behind #22 and #23.
- **ekoa-code was not stuck.** It had coordinator turns 96 to 115 after the update and an empty queue. The previous handoff's evidence for it was stale.
- **Records.** The run log has the details, and the private records are in `~/.jevellan-build/fix-051/diagnosis/` on dev-madrid.

## What 0.5.1 changes (simulated; in source at `ea87cee7`, versioned at `c083ec8d`)

- **Fix A (Decisions 925, 926).** Every Jev decision has one overall deadline (twice the per-attempt timeout plus six seconds) owned by one shared helper.
  - The helper covers obtaining the client, the configuration, key and model reads, and every attempt.
  - An uninterpreted request reaches the coordinator with "Jev could not interpret this request".
  - Fresh session, Stop, Move coordinator and shutdown abandon a classification in progress.
  - This is a guard, not a claimed fix for a deadlock, since phase 0 found none.
- **Fix B (Decision 927).** Automatic and owner-requested fix turns start from the pull request's current head.
  - The worktree fast-forwards, or merges the head (never rebasing), with conflicts going to the turn first.
  - The thread shows the notice "Updated the worktree to pull request #n's head … before this fix.", and the next push leases on that head.
  - A thread may list runs on its own pull request's current head.
  - The failing-checks prompt names runs and jobs by id.
- **Closing review.** One closing review found no serious issue, so the source is unchanged since `c083ec8d` and the Darwin archive is current.
- **Tests.**
  - Failing-first tests failed on the old code and pass on the new.
  - The affected tests pass after seven intended contract updates.
  - PAR4 passed with vision in four layouts.

## The release gate at `c083ec8d` (simulated)

- **Passed:**
  - build, typecheck, lint and the secret scan;
  - the full backend: 2,425 passed, 0 failed and 1 skipped (the opt-in Node 20 sandbox case).
- **Full browser, vision off:** 244 passed, 13 failed, 119 not run.
  - The not-run cases are the serial projects chains after their first failures.
  - The machine logged out-of-memory kills of Chrome processes and very high load during the run. Their cause was not established; this run's suites also had many fixture processes running.
- **Classification of all 13 failures**, three runs alone at main and three at v0.5.0 each (78 runs, 05:59:37 to 07:57:58):
  - **Load-sensitive (5):** LJ2 in desktop-dark and phone-dark, Thread images in desktop-light, LJ3 in phone-light, and the packed installation journey in desktop dark. Each passed 6 of 6 alone.
  - **Pre-existing (8):** J8 and J11 in all four layouts. They fail 48 of 48 alone, at main and at v0.5.0 alike, at the same step: the Project picker on `/` (`skeleton.spec.ts:880` and `:967`), which opens the first project instead.
  - **No regression.** The gate was accepted at 07:57:58.
- **Deviations, recorded in the run log:**
  - the version bump came before the gate;
  - the Darwin build briefly overlapped Madrid's gate steps.

## Archives

- **Darwin:** `jevellan-0.5.1-darwin-arm64.tgz`, built on the Pro from a fresh clone at `c083ec8d`.
  - 443,432,589 bytes, SHA-256 `cdb19b01cee1fe48f97d7f8420f6ccc5f1f301e78523515254ad5ff9ee498e6b`.
  - Verified: tracked files match, the CLI reports 0.5.1, and the native PTY works.
  - Kept on the Pro in `~/.jevellan-build/fix-051/release-0.5.1-darwin/` and on dev-madrid in `~/.jevellan-build/fix-051/phase2/release-0.5.1-darwin-copy/`.
- **Linux:** not built.

## Backups and rollback

- The new cold backups of `~/.jevellan-hub` and `/Users/ggomes/.jevellan-member` were **not taken**, because the update stage was not reached. They remain required before any update; the scripts `backup-madrid.sh` and `backup-pro.sh` are ready.
- Nothing was installed or migrated. The 0.5.0 installation records keep 0.4.1 as the previous version on both machines, and earlier rollback material is described in the [one-mesh handoff](../one-mesh-050-2026-10/HANDOFF.md).
