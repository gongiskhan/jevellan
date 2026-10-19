# Release 0.5.1: publish, install, live journeys and two cleanups

Run log for the 19 October 2026 brief: publish and install 0.5.1 on both machines, run the live journeys on `jevellan-live-sandbox`, then two limited cleanups. Times are UTC. Every result is labelled live, simulated or not run.

The accepted product source is `c083ec8df17951e873433224ff9bf9217f13194a` (gate accepted in the [fix-051 run](../fix-051-2026-10/README.md)). The run started at `f955c88e`, which changes documentation only. No product source changes in this run.

## Clocks

- Run started: 2026-10-19T11:06:11Z on dev-madrid, checkout clean on `main` at `f955c88e`.
- Steps 1 to 3 (release, backups and updates, confirmation): two hours, deadline 2026-10-19T13:06:11Z.
- Live journeys: 150 minutes from the confirmation on 0.5.1. Not started.
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
| 2 Backups and updates | In progress: dev-madrid's cold backup taken 11:16:07–11:19:07; waiting for the owner's running ekoa-code threads before the Pro backup and the updates | Below |
| 3 Confirmation | Not started | |
| 4 Live journeys | Not started | |
| 5 Cleanup A | Not started | |
| 6 Cleanup B | Not started | |
| 7 Handoff | Not started | |

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
- The Pro backup and both updates wait for them to end (the brief's step 2.1). A private poller reruns the read-only preflight every minute until 13:00 and logs each reading.
