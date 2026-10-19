# One mesh 0.5.0 handoff

## Owner steps

1. **From now on, use `https://dev-madrid.tail31efa.ts.net` everywhere.**
   - Replace your bookmarks.
   - On the iPhone, open that address in Safari, add it to the Home Screen again, turn notifications on there and send a test notification from Settings.
   - The Pro's old address `https://goncalos-macbook-pro.tail31efa.ts.net:9443` no longer exists.
   - The Pro itself is now a member at `https://goncalos-macbook-pro.tail31efa.ts.net`.
2. **Accounts:** none is at Needs login. All three (Claude Gmail, Claude Ekoa, Ekoa Codex) are Ready on both machines. Claude Ekoa was at 91% of its week at 00:02 UTC, above its 90% ceiling, so Jev will not use it until it resets on 20 October.
3. **The Mac mini:** decide only whether it should later join Madrid's mesh as an apps-only member or stay out. It dropped out with the Pro's old state point. This run did not inspect, change or migrate it. Any future join must keep its existing apps and their addresses, and must not make it a worker or eligible for ekoa-code.
4. **The folder share** on dev-madrid's `:8500` was removed to free the Tailscale routes. To bring it back: `sudo tailscale serve --bg --https=8500 /home/ggomes/Documents/Codex/2026-09-03/so-i-used-to-play-this`. While any route serves a folder or file, Tailscale refuses route changes from your user. `:8497` already serves a file today, so a later Jevellan HTTPS change needs `sudo` either way.
5. **Sandbox, when you have a minute:**
   - pull requests [#19](https://github.com/gongiskhan/jevellan-live-sandbox/pull/19) (from 15 October) and [#21](https://github.com/gongiskhan/jevellan-live-sandbox/pull/21) (LP5, with the supplemental fix check's injection and its manual cleanup commit on top) are open; merge or close them as you like;
   - [#20](https://github.com/gongiskhan/jevellan-live-sandbox/pull/20) was closed, unmerged, as planned;
   - the test thread "Add a README line about Node 22" was stopped after it rightly asked about Node 20 versus 22; its branch is kept.
6. **Decide about the stalled sandbox coordinator.**
   - The state point still holds LP1's request in "Interpreting a project request", and its lifecycle guard counts that as running work.
   - At 01:13 UTC this run tried one restart through the same lifecycle gate `jevellan update` uses. The guard did not grant the gate within 60 seconds, so nothing was stopped.
   - Restarting anyway would cut that interpretation. Leaving it waits for a product fix.

**Live acceptance was not met.**
- Most sandbox journeys could not run because the coordinator stalled on the first owner request: LP1 failed, and LP2, LP3, LP4, LP9 and LP10 were blocked.
- The supplemental automatic-fix check on #21 also ended blocked.
- Only LP6 passed. The release itself, the one-mesh move and both updates are done.

## What is live

- **One mesh.**
  - dev-madrid is the only state point: 0.5.0, `~/.jevellan-hub`, `jevellan.service`, `https://dev-madrid.tail31efa.ts.net`.
  - The MacBook Pro is a member: 0.5.0, `/Users/ggomes/.jevellan-member`, launchd `dev.jevellan.daemon`, `https://goncalos-macbook-pro.tail31efa.ts.net`.
  - doctor reports ten of ten OK on both, and both are Online on 0.5.0.
  - The Pro's old state point (0.3.6) and Madrid's old member (0.3.6) are retired. Their data folders are kept.
- **Projects.**
  - ekoa-code and `jevellan-live-sandbox` allow both machines, with fresh Pro clones under `/Users/ggomes/jevellan-projects/` and a per-device limit of 4 on the Pro.
  - ekoa-code's settings are otherwise unchanged, autoMerge off included.
  - The Pro protects your own checkout `/Users/ggomes/dev/ekoa-code`.
  - The Pro's ekoa-code coordinator notebook was appended to Madrid's.
- **Release 0.5.0** is [published](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.0) from `f212c3d3`.
  - The gate was accepted by its classification rule. That is not a fully green matrix:
    - backend: 2,402 passed, 0 failed, 1 skipped of 2,403;
    - browser: 242 passed, 12 failed, 122 not run of 376. The not-run cases are the serial projects chain after its first failure.
  - Every failure was classified pre-existing (J8 and J11) or load-sensitive. There was no regression.
  - every parity journey passed with vision in four layouts, and the judged images are kept in [vision/](vision/);
  - Decision 924 lets a project add a new device's path while threads are open.

## What is blocked or not run

- **Sandbox coordinator stall** (live, 0.5.0).
  - LP1's owner message (00:08:28 UTC) never got a coordinator turn. The state point stayed in "Interpreting a project request" for it from 00:08:31 until at least 00:51.
  - One Fresh session did not clear it. The cause is not identified.
  - This blocked LP2, LP3, LP4, LP9 and LP10.
  - No coordinator turn is recorded for ekoa-code after the update either (its last turn records are from 17 October), so the stall may not be limited to the sandbox. This is not established.
- **LP1 failed.** No cards appeared within 3 minutes.
- **LP5 blocked / failed.**
  - The first check needs the other Claude account to be eligible, and Ekoa was over its ceiling.
  - In the second check, Jev chose Codex at the start, with no wait and no "Moved from…" notice.
- **LP6 passed** (Library, a Pro thread, read-only mirror).
- **Supplemental automatic-fix check** on #21 (not LP4) **failed**. The fix turn could not read the failing run with its thread-scoped tools, and its worktree was behind the owner's commit, so it reported blocked. That is worth a product fix: let an automatic fix read the failing run on the pull request's current head, and refresh the worktree to that head first.
- **LP7 not run.** Headless Chrome here could not subscribe to the real push service. Your iPhone check stands.
- **LP8 blocked.** There is no compatible endpoint account.

Details and timings are in the [run log](README.md#second-run-18-to-19-october) and [live/](live/).

## Where the backups and rollbacks are

- **Second run, phase 0 (cold, before any change):**
  - dev-madrid: `~/.jevellan-build/one-mesh-050/backup-madrid-2/` (state point 37 GB and old member 25 GB, units, command, manifests, retired member unit under `member/unit-moved/`, `pre-https/` copies of install.json, device.json and the unit);
  - Pro: `/Users/ggomes/.jevellan-build/one-mesh-050/backup-pro-2/` (APFS clone of `/Users/ggomes/.jevellan`, plist, command, the old ekoa-code notebook and 33 memory notes).
- **Before 0.5.0 (cold, the working one-mesh 0.4.1 state):**
  - dev-madrid: `~/.jevellan-build/one-mesh-050/second/pre-update-hub/` (7.8 GB, without `worktrees/`, `cache/` and `tmp/`, which stay in place);
  - Pro: `/Users/ggomes/.jevellan-build/one-mesh-050/pre-update-member/` (2.0 GB).
- **Rollback: limits, not exercised.**
  - `jevellan rollback` alone would start the 0.4.1 application against data that 0.5.0 has migrated (settings v4, accounts v2), which 0.4.1 cannot read. Do not use it on its own.
  - A full state rollback is a coordinated cold restore. On each machine, stop the service. Keep the current 0.5.0 home aside rather than overwriting it. Restore the matching pre-update copy of the home together with its service file (unit or plist) and its `jevellan` command, from the same folder. The pre-update copies hold the 0.4.1 installation record, so no second rollback command follows.
  - On dev-madrid, that copy lacks `worktrees/`, `cache/` and `tmp/`; carry those over from the current home.
  - The vault on GitHub keeps moving; check which revision you want before restoring.
  - This full rollback was not exercised in this run.
- **Kept, never touched:** the first run's backups (`backup-madrid/`, `backup-pro/`) and the earlier Pro rollback `projects-parity-050-rollback-pro-2026-10-18`.
- **Moved aside on the Pro:** the old clones, at `/Users/ggomes/jevellan-projects/{ekoa-code,jevellan-live-sandbox}.before-one-mesh-2026-10-18`.
- **Archives:**
  - 0.4.1 Darwin (used for the join): `/Users/ggomes/.jevellan-build/one-mesh-050/release-041/`;
  - 0.5.0: on the GitHub release, with the build trees in `~/.jevellan-build/one-mesh-050/second/release-0.5.0-linux/` and on the Pro in `release-0.5.0-darwin/`.
