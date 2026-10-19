# Release 0.5.1: publish, install, live journeys and two cleanups

Run log for the 19 October 2026 brief: publish and install 0.5.1 on both machines, run the live journeys on `jevellan-live-sandbox`, then two limited cleanups. Times are UTC. Every result is labelled live, simulated or not run.

The accepted product source is `c083ec8df17951e873433224ff9bf9217f13194a` (gate accepted in the [fix-051 run](../fix-051-2026-10/README.md)). The run started at `f955c88e`, which changes documentation only. No product source changes in this run.

## Clocks

- Run started: 2026-10-19T11:06:11Z on dev-madrid, checkout clean on `main` at `f955c88e`.
- Steps 1 to 3 (release, backups and updates, confirmation): two hours, deadline 2026-10-19T13:06:11Z.
- Live journeys: 150 minutes from the confirmation on 0.5.1. Never started: 0.5.1 was not installed.
- Cleanups: whatever is left, at most 90 minutes.

## Tooling

- Node 22.23.2 on dev-madrid and 22.22.0 on the Pro.
- Private runner and helpers for this run are in `~/.jevellan-build/release-051/` on dev-madrid. The release, backup and update scripts are the fix-051 ones in `~/.jevellan-build/fix-051/bin/`, read in full before running; the Pro's copies match dev-madrid's byte for byte.
- `confirm.sh` only prints its readings, so this run adds a private wrapper, `release-051/bin/confirm-assert.mjs`, that asserts each condition: doctor 10 of 10 OK on both machines, both healths on 0.5.1, both devices online on 0.5.1 in the roster, a vault sync after the updates with no error and nothing pending, and no open "Interpreting a project request" operation on either machine. The Pro has `timeout` in `/opt/homebrew/bin`, so no further adaptation was needed.
- CodeGraph: the checkout's `.codegraph` index is present but no CLI is installed, and the index holds symbols, not string literals. Literal searches used `rg`.

## Step log

| Step | Status | Evidence |
| --- | --- | --- |
| 1 Release | Complete, 11:07:39–11:15:21 (live publication) | Below |
| 2 Backups and updates | Blocked. dev-madrid's cold backup was taken 11:16:07–11:19:07 (live). The Pro backup and both updates were not run: from 11:34, ekoa-code's coordinator held dev-madrid's lifecycle gate with no runtime behind it | Below |
| 3 Confirmation | Not run (blocked by step 2) | |
| 4 Live journeys | Not run (blocked: 0.5.1 not installed). E1 was not sent | |
| 5 Cleanup A | Not run (blocked); drafted privately | Below |
| 6 Cleanup B | Not run (blocked); drafted privately | Below |
| 7 Handoff | Complete | [HANDOFF.md](HANDOFF.md) |

## Heavy jobs

One at a time across both machines, `uptime` recorded before each.

| Job | Machine | Start | End | Load before |
| --- | --- | --- | --- | --- |
| Linux archive build and verification | dev-madrid | 11:07:39 | 11:11:05 | 4.66, 3.41, 3.12. The owner's own ekoa-code CI (type check and lint in a runner container) was running at the time; it is not this run's work and was left alone |
| Publication (its pre-push secret scan) | dev-madrid | 11:11:35 | 11:15:21 | light |
| Cold backup of `~/.jevellan-hub` | dev-madrid | 11:16:05 | 11:19:07 | 6.35, 7.37, 5.67 |

## Step 1: release (live)

### Linux archive

- Built with `build-linux.sh c083ec8df17951e873433224ff9bf9217f13194a 0.5.1` from a fresh local clone, 11:07:39 to 11:11:05. The clone's `HEAD` was `c083ec8d`.
- Verified after extraction (`verify-release.mjs`): 3,603 tracked files byte-identical to `c083ec8d` and none different (279 tracked files are not shipped), the archive's own CLI reports 0.5.1, and its native terminal addon ran a PTY. No `.git`, `.env`, `BRIEF.md`, `CLAUDE.md` or `.claude` in the archive.

| Archive | Built | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `jevellan-0.5.1-linux-x64.tgz` | dev-madrid, this run | 574,661,509 | `17c2c83bc379c68b79c09a36532e37e2543b8bfc24167c18a47552c62e33181a` |
| `jevellan-0.5.1-darwin-arm64.tgz` | the Pro, fix-051 run | 443,432,589 | `cdb19b01cee1fe48f97d7f8420f6ccc5f1f301e78523515254ad5ff9ee498e6b` |

### Publication

- `publish.sh c083ec8df17951e873433224ff9bf9217f13194a 0.5.1`, 11:11:35 to 11:15:21. It checked both archives against their checksums, confirmed `c083ec8d` is an ancestor of `main`, created the annotated tag and pushed it, then created the release.
- **Secret scan.** The repository's pre-push hook (`.githooks`, `scripts/secret-scan.mjs`) ran before the tag push and passed ("Secret scan passed.").
- **Rescan with the test values (11:31).** The scan also checks the values of the `JEVELLAN_TEST_*` variables, but only when they are loaded, and the shells of the tag push and of the first log push had not loaded `.env`. The scan was rerun at once with the whole `.env` loaded (two test values) over everything this run had pushed (`f955c88e..1da67294` and the tag) and over the working tree: no finding. Every later push loads `.env` first.
- **Tag.** `v0.5.1` (tag object `fe796811`) points at `c083ec8df17951e873433224ff9bf9217f13194a`, not at the later documentation commits.
- **Release.** [v0.5.1](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.1), published 11:15:20, not a draft or prerelease. GitHub's asset digests match the archives:
  - `jevellan-0.5.1-darwin-arm64.tgz`, 443,432,589 bytes, `sha256:cdb19b01…ee498e6b`;
  - `jevellan-0.5.1-linux-x64.tgz`, 574,661,509 bytes, `sha256:17c2c83b…2e33181a`.
- The private release notes' last sentence was changed before publication to point at this folder for the release, updates and live journeys (the gate stays in the fix-051 folder). Nothing else in them changed.

## Step 2: backups and updates (live)

### Before each stop

A private read-only preflight (`release-051/bin/preflight.sh`) checks, through the owner API and the process table: no coordinator running and no thread preparing, running or publishing in any project; both lifecycle activity files empty; and each service's main PID, parent and start time, with its child processes.

- **11:15:56: clear.** Both coordinators idle, no running threads, both activity files empty.
  - dev-madrid: `jevellan.service` main PID 2981796, parent 1599 (the user's systemd), started 01:55:34 (the fix-051 restart), zero restarts. Its only children were its Basic Memory helpers.
  - The Pro: `dev.jevellan.daemon` PID 26384, parent launchd, started 00:01:21 (the 0.5.0 update), with no children.

### Cold backup of dev-madrid

- `backup-madrid.sh`, 11:16:05 to 11:19:07, into `~/.jevellan-build/fix-051/backup-madrid/` (private).
- `cold-backup.mjs` held the lifecycle gate (granted at once), then the normal `systemctl --user stop jevellan.service`. systemd logged Stopping and Stopped at 11:16:07, with no stop timeout or kill escalation. It copied the stopped home (without `worktrees`, `cache` and `tmp`, as before), restarted the service at 11:17:38 and saw it healthy on 0.5.0 at 11:17:45. The new main PID is 1120745.
- 11,079,400 KiB in 141,163 files, with a SHA-256 manifest (manifest hash `a2529019…ee41580`), plus copies of the unit and the `jevellan` command with their checksums.

### Waiting for the owner's work

- At 11:19:50 the preflight was no longer clear: ekoa-code had three threads running on dev-madrid, started after the backup's restart. They are the owner's work: this run does not stop, message or change them.
- The Pro backup and both updates wait for them to end (the brief's step 2.1). A private poller reran the read-only preflight every minute; it read clear at 11:32:00, but by the fresh check before the Pro backup (11:34) ekoa-code's coordinator and three threads were running again.
- So each remaining stop is started by a private runner (`act-when-clear.sh`) that polls the preflight about every 15 seconds and starts the step only on a fresh clear reading. A thread or coordinator turn holds the lifecycle gate (a `conversation` activity), and `cold-backup.mjs` and `jevellan update` both wait for that gate, so neither can stop the service under a running turn.

### ekoa-code's coordinator holds the gate with no runtime (observed, not diagnosed)

Read-only observations from the owner API, the coordinator ledger (event types and times only), both lifecycle activity files and both process tables:

- ekoa-code's coordinator turn 128 started at 11:33:54 on dev-madrid. Its session recorded a turn-cache entry at 11:36:24, then a session-turn-cache entry for turn 1 at 11:50:08 and a session end at 11:50:09. Turn 128 has no turn end.
- From 11:34 on, the work view reads the coordinator as running, and dev-madrid's activity file holds `Coordinator: ekoa-code` (kind `conversation`), which keeps the lifecycle gate busy.
- Since about 11:45 no runtime worker has run under dev-madrid's daemon (workers appear there as `runtime-claude` and `runtime-codex` processes, as at 11:19 and 11:34), and the Pro's daemon has no children and an empty activity file.
- Events keep queueing for the coordinator (pull request updates and automatic fixes, the last at 11:44:53), and no coordinator turn has started since.

This is the owner's coordinator on 0.5.0. It is not an open "Interpreting a project request" operation, so the brief's stop exception does not apply: this run stops nothing and waits. The cause is not established here.

### Stopped at the blocker (11:54–11:55)

- **11:54:29, one fresh check, as the owner's supervision asked.**
  - Turn 128 still had no turn end, and the session end at 11:50:09 was still the latest session event.
  - A new pull request update at 11:54:02 had started no coordinator turn.
  - The work view still read the coordinator as running, and the gate activity was still held.
  - No runtime worker ran on either machine.
- **The owner's decision.** The owner judged this a different blocking condition from the authorized interpreting-only case. They asked the run to stop, record it and hand off, without stopping any service or owner work and without further diagnosis.
- **What this run stopped.** Only its own queued runner (`act-when-clear.sh`, PID 1211115, started 11:38:31, parent the runner's shell), at 11:54:49, after checking its parent, start time and command. It had not run its step 2 chain. None of this run's runners remains.
- **11:55:08, the services.**
  - Both machines are healthy on 0.5.0 and online in the roster.
  - `jevellan.service`: main PID 1120745, active since 11:17:38, zero restarts.
  - The Pro's `dev.jevellan.daemon`: PID 26384, running.
  - The Pro has no backup folder from this run, and no backup or update process.

## What was prepared but not run

All of it is private (dev-madrid, `~/.jevellan-build/`), and none of it changed product source.

- **Live harness.** `fix-051/live/journeys.mjs` and `run.sh` are adapted for this brief. The fix-051 copy is kept in `release-051/journeys.fix051-original.mjs`.
  - Receipts go to `docs/acceptance/release-051-2026-10/live`.
  - LP1's card timing is judged from the fix-051 run log (turn 43 at 01:56:01.2, tasks at 01:56:51 and 01:57:01), with the ledger only as a cross-check, and no past screenshot.
  - LP4 targets #23 for the failing file and the review comment, and #22 for the conflict. It times each automatic fix from the thread ledger. The comment is always posted, and the rename is judged only if #23 adds a helper (at present it adds only a test).
  - E1 cancels a created task as soon as its tool event names it, by exact id.
  - LP5 requires the thread's real turn to run on the Ekoa account.
  - LP10 counts only its own three threads for the overlap.
  - Restores run in `finally`. A setting or ceiling someone else changed meanwhile is left as it is and recorded.
  - The run stops after any failed step.
  - The config (`release-051/private/live-config.json`, mode 600) validates against the harness. Its deadline is a past placeholder until the live clock starts.
- **Confirmation.** `release-051/bin/confirm-assert.mjs` asserts every condition. `devices-ui.mjs` asserts Settings → Devices in the owner UI and takes a screenshot; its read-only dry run on 0.5.0 found both devices Online.
- **Cleanup A.** In `tests/e2e/skeleton.spec.ts`, J8 (line 880) and J11 (line 967) would open `${target.url}/new` instead of `${target.url}/`. All their other steps and assertions stay as they are.
- **Cleanup B.** Drafts are in `release-051/drafts/`: `scripts/release/` (build, pack, verify, publish, backup with its home copy, update, confirm, each with an argument check and a dry run where one applies) and `docs/release.md`.
