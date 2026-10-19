# Release 0.5.1: current installation handoff

## Owner steps

1. No installation action remains. Both dev-madrid and the MacBook Pro are healthy and Online on **0.5.1**, confirmed at 2026-10-19T13:18:28.681Z. Doctor reports **10/10 OK** on both. Vault sync and the Devices UI check pass.
2. The without-GitHub brief may now proceed from its own orientation. The previous live journeys and cleanup phases were **not run**, not passed.

## Backups and rollback (live)

- Fresh hub backup: `~/.jevellan-build/fix-051/backup-madrid/` on dev-madrid. The earlier 11:16 backup remains in its timestamped `backup-madrid-before-resume-*` sibling.
- Fresh member backup: `/Users/ggomes/.jevellan-build/fix-051/backup-pro/` on the Pro. Both backups have manifests and service/command copies.
- Both normal updates retain **0.5.0** as their previous installed version. To roll back Jevellan itself, wait for turns to finish and run the installation's normal `jevellan rollback` command on the affected machine. Do not purge or restore an older data snapshot over newer work.
- Private current receipts: `~/.jevellan-build/release-051/resume-20261019/` on dev-madrid. No product source changed.

## Original blocked handoff (11:55 UTC, retained history)

# Release 0.5.1: handoff

## Owner steps

1. **0.5.1 is published but not installed. Both machines still run 0.5.0, healthy and online** (checked at 11:55:08 UTC).
   - [v0.5.1](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.1) is tagged at `c083ec8d` and carries both verified archives.
   - Install was blocked: ekoa-code's coordinator on dev-madrid holds the lifecycle gate with no runtime behind it (below). That stops both `jevellan update` and the cold backup's gate from going ahead.
2. **Look at ekoa-code's coordinator** in the Projects area on dev-madrid.
   - Since 11:34 it reads as running, but its turn 128 never ended and its session ended at 11:50:09.
   - Pull request updates and automatic fixes keep queueing behind it.
   - This run did not stop, message or change it. Whether to stop the service is your call: the brief's stop exception covers only an open "Interpreting a project request" operation, and this is a different state.
3. **To finish the release once the gate is free,** with no turn running on either machine, in this order:
   1. **Fresh dev-madrid backup.** The 11:16 backup is a cold copy as of 11:16, and the home has kept changing since. Move `~/.jevellan-build/fix-051/backup-madrid` aside (`backup-madrid.sh` refuses an existing folder), then run `~/.jevellan-build/fix-051/bin/backup-madrid.sh` on dev-madrid.
   2. **Pro backup.** Run `~/.jevellan-build/fix-051/bin/backup-pro.sh` on the Pro.
   3. **Update dev-madrid:** `~/.jevellan-build/fix-051/bin/update-madrid.sh ~/.jevellan-build/fix-051/phase2/release-0.5.1-linux/out/jevellan-0.5.1-linux-x64.tgz`.
   4. **Update the Pro**, on the Pro: `~/.jevellan-build/fix-051/bin/update-pro.sh ~/.jevellan-build/fix-051/release-0.5.1-darwin/out/jevellan-0.5.1-darwin-arm64.tgz`.
   5. **Confirm** on dev-madrid, from the checkout, with the whole `.env` loaded (`set -a; . ./.env; set +a`). Use `N=/home/ggomes/.nvm/versions/node/v22.23.2/bin/node`.
      - `$N ~/.jevellan-build/release-051/bin/confirm-assert.mjs 0.5.1 <update start, ISO> <out.json>`;
      - `$N ~/.jevellan-build/release-051/bin/devices-ui.mjs 0.5.1 <screenshot.png> <record.json>`.

      Both must exit 0.
   - The private `~/.jevellan-build/release-051/bin/step2-chain.sh` covers only sub-steps 2 to 4: the Pro backup and both updates. It does **not** take the fresh dev-madrid backup, so it is not a complete resume command by itself. Run sub-step 1 first.
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
  - No runtime worker was running on dev-madrid at the checks at about 11:50, 11:53 and 11:54:29, nor on the Pro at about 11:51. These are sampled observations, not proof of a continuous absence.
  - New events (the last at 11:54:02) start no coordinator turn.
  - Following the brief's stop rule, this run stopped only its own queued runner at 11:54:49, after verifying its PID, parent and start time; that runner had run nothing. No additional service stop was performed during blocker closeout; the earlier authorized backup stop/restart is recorded below.
- **Live journeys:** not run, blocked by the install. E1, LP1, LP2, LP3, LP4, LP5, LP9 and LP10 have no receipts.
- **Cleanups A and B:** not run, blocked by the install. The J8 and J11 change and the release scripts are drafted privately, not committed.
  - J8 and J11: the change is to open `${target.url}/new` instead of `${target.url}/` before the Project picker, at `tests/e2e/skeleton.spec.ts:880` and `:967`.
  - The release script drafts and `docs/release.md` are in `~/.jevellan-build/release-051/drafts/`.

## Backups and rollback

- **dev-madrid:** cold backup of `~/.jevellan-hub` taken from 11:16:05 to 11:19:07, in `~/.jevellan-build/fix-051/backup-madrid/`.
  - 11,079,400 KiB in 141,163 files, with a SHA-256 manifest, the unit and the command. The stop was clean.
  - It is a valid cold copy as of 11:16, not of the home's later state.
- **The Pro:** no backup was taken this run.
- **Rollback:** nothing was installed, so there is nothing to roll back. Both 0.5.0 installation records keep 0.4.1 as the previous version, as before.
