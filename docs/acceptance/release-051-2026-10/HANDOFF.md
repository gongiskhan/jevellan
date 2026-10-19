# Release 0.5.1: handoff

## Owner steps

1. **0.5.1 is published but not installed. Both machines still run 0.5.0, healthy and online** (checked at 11:55:08 UTC).
   - [v0.5.1](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.1) is tagged at `c083ec8d` and carries both verified archives.
   - Install was blocked: ekoa-code's coordinator on dev-madrid holds the lifecycle gate with no runtime behind it (below). That stops both `jevellan update` and the cold backup's gate from going ahead.
2. **Look at ekoa-code's coordinator** in the Projects area on dev-madrid.
   - Since 11:34 it reads as running, but its turn 128 never ended and its session ended at 11:50:09.
   - Pull request updates and automatic fixes keep queueing behind it.
   - This run did not stop, message or change it. Whether to stop the service is your call: the brief's stop exception covers only an open "Interpreting a project request" operation, and this is a different state.
3. **To finish the release once the gate is free,** with no turn running on either machine:
   1. Take the Pro's cold backup with `~/.jevellan-build/fix-051/bin/backup-pro.sh` on the Pro.
   2. Update dev-madrid with `~/.jevellan-build/fix-051/bin/update-madrid.sh ~/.jevellan-build/fix-051/phase2/release-0.5.1-linux/out/jevellan-0.5.1-linux-x64.tgz`.
   3. Update the Pro with `~/.jevellan-build/fix-051/bin/update-pro.sh ~/.jevellan-build/fix-051/release-0.5.1-darwin/out/jevellan-0.5.1-darwin-arm64.tgz` on the Pro.
   4. Confirm with `node ~/.jevellan-build/release-051/bin/confirm-assert.mjs 0.5.1 <update start> <out.json>` and `~/.jevellan-build/release-051/bin/devices-ui.mjs`. Run the Devices check from the checkout, with the whole `.env` loaded.
   - dev-madrid's 11:16 backup is a cold copy as of 11:16, and its home has kept changing since. Take a fresh one right before the update. `backup-madrid.sh` refuses an existing folder, so move the old one aside first.
   - `~/.jevellan-build/release-051/bin/step2-chain.sh` runs the backup and both updates in order, started by `act-when-clear.sh` at a clear moment.
4. **Then run the live journeys** with `~/.jevellan-build/fix-051/live/run.sh <journey>`, one journey at a time. Set the 150-minute deadline in `~/.jevellan-build/release-051/private/live-config.json` first; it is now a past placeholder, so every journey would record "not run".
5. **Sandbox pull requests #22 and #23** are still open, with passing checks, as LP1 and LP4 need them. ekoa-code got no message from this run: E1 was not sent. Its settings, goals and `autoMerge` (off) are unchanged, and `NIGHTLY_SCHEDULER` was not set.

## What is live on each machine

| Machine | Installation | Version | Service | Checked |
| --- | --- | --- | --- | --- |
| dev-madrid | `~/.jevellan-hub` | 0.5.0, healthy, online | `jevellan.service`, main PID 1120745, active since 11:17:38 (the backup's restart), zero restarts | 11:55:08 |
| MacBook Pro | `/Users/ggomes/.jevellan-member` | 0.5.0, healthy, online | `dev.jevellan.daemon`, PID 26384, running since 00:01:21 | 11:55:08 |

The product source is unchanged since `c083ec8d`. This run committed documentation only.

## The release (live)

- The Linux archive was built and verified from `c083ec8d`:
  - 574,661,509 bytes, SHA-256 `17c2c83bc379c68b79c09a36532e37e2543b8bfc24167c18a47552c62e33181a`;
  - 3,603 tracked files identical to the revision, with none different;
  - its own CLI reports 0.5.1, and its native PTY runs.
- The Darwin archive is unchanged from the fix-051 run: 443,432,589 bytes, `cdb19b01…498e6b`.
- The tag `v0.5.1` points at `c083ec8df17951e873433224ff9bf9217f13194a`, and the release was published at 11:15:20. GitHub's asset digests match both checksums.
- The pre-push secret scan passed for the tag push, and a rescan with `.env` loaded found nothing.

## What is blocked

- **Install (steps 2 and 3):** blocked by ekoa-code's coordinator, observed but not diagnosed.
  - Its turn 128 started at 11:33:54 and has no turn end. Its session ended at 11:50:09.
  - dev-madrid's activity file still holds `Coordinator: ekoa-code`, so the lifecycle gate stays busy.
  - Neither machine has run a runtime worker since about 11:45.
  - New events (the last at 11:54:02) start no coordinator turn.
  - Following the owner's supervision, this run stopped only its own queued runner at 11:54:49, after verifying its PID, parent and start time; that runner had run nothing. It stopped no service and no owner process.
- **Live journeys:** not run, blocked by the install. E1 and LP1 to LP10 have no receipts.
- **Cleanups A and B:** not run, blocked by the install. The J8 and J11 change and the release scripts are drafted privately, not committed.
  - J8 and J11: the change is to open `${target.url}/new` instead of `${target.url}/` before the Project picker, at `tests/e2e/skeleton.spec.ts:880` and `:967`.
  - The release script drafts and `docs/release.md` are in `~/.jevellan-build/release-051/drafts/`.

## Backups and rollback

- **dev-madrid:** cold backup of `~/.jevellan-hub` taken from 11:16:05 to 11:19:07, in `~/.jevellan-build/fix-051/backup-madrid/`.
  - 11,079,400 KiB in 141,163 files, with a SHA-256 manifest, the unit and the command. The stop was clean.
  - It is a valid cold copy as of 11:16, not of the home's later state.
- **The Pro:** no backup was taken this run.
- **Rollback:** nothing was installed, so there is nothing to roll back. Both 0.5.0 installation records keep 0.4.1 as the previous version, as before.
