# One mesh 0.5.0 handoff

## Owner steps

1. **From now on, use `https://dev-madrid.tail31efa.ts.net` everywhere.**
   - Replace your bookmarks.
   - On the iPhone, open that address in Safari, add it to the Home Screen again, turn notifications on there and send a test notification from Settings.
   - The Pro's old address `https://goncalos-macbook-pro.tail31efa.ts.net:9443` no longer exists.
   - The Pro itself is now a member at `https://goncalos-macbook-pro.tail31efa.ts.net`.
2. **Accounts:** none is at Needs login. All three (Claude Gmail, Claude Ekoa, Ekoa Codex) are Ready on both machines. Claude Ekoa was at 91% of its week at 00:02 UTC, above its 90% ceiling, so Jev will not use it until it resets on 20 October.
3. **The Mac mini** dropped out with the Pro's old state point and was not touched. Decide whether it should join Madrid's mesh as an apps-only member (Settings → Devices → Add a device on Madrid, then run the shown command on the mini with a fresh home) or stay out.
4. **The folder share** on dev-madrid's `:8500` was removed to free the Tailscale routes. To bring it back: `sudo tailscale serve --bg --https=8500 /home/ggomes/Documents/Codex/2026-09-03/so-i-used-to-play-this`. While a route serves a folder or file, Tailscale refuses route changes from your user, so a later Jevellan HTTPS change will need `sudo` again.
5. **Sandbox, when you have a minute:**
   - pull requests [#19](https://github.com/gongiskhan/jevellan-live-sandbox/pull/19) (from 15 October) and [#21](https://github.com/gongiskhan/jevellan-live-sandbox/pull/21) (LP5, with the supplemental fix check's injection and its manual cleanup commit on top) are open; merge or close them as you like;
   - [#20](https://github.com/gongiskhan/jevellan-live-sandbox/pull/20) was closed, unmerged, as planned;
   - the test thread "Add a README line about Node 22" was stopped after it rightly asked about Node 20 versus 22; its branch is kept.
6. **Check the sandbox coordinator** (see "Blocked" below). If it still shows your LP1 message as waiting, a restart of `jevellan.service` at a quiet moment is the next thing to try. This run did not restart it.

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
- **Release 0.5.0** is [published](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.0) from `f212c3d3`:
  - the gate passed (no regressions; failures pre-existing or load-sensitive);
  - every parity journey passed with vision in four layouts, and the judged images are kept in [vision/](vision/);
  - Decision 924 lets a project add a new device's path while threads are open.

## What is blocked or not run

- **Sandbox coordinator stall** (live, 0.5.0).
  - LP1's owner message (00:08:28 UTC) never got a coordinator turn. The state point stayed in "Interpreting a project request" for it from 00:08:31 until at least 00:51.
  - One Fresh session did not clear it. The cause is not identified.
  - This blocked LP2, LP3, LP4, LP9 and LP10.
  - ekoa-code's coordinator kept working.
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
- **Rollback:**
  - `jevellan rollback` on either machine switches the application back to 0.4.1.
  - 0.4.1 cannot read the 0.5.0 settings and accounts. A full rollback therefore stops the service and restores the pre-update copy over the home, then rolls back.
- **Kept, never touched:** the first run's backups (`backup-madrid/`, `backup-pro/`) and the earlier Pro rollback `projects-parity-050-rollback-pro-2026-10-18`.
- **Moved aside on the Pro:** the old clones, at `/Users/ggomes/jevellan-projects/{ekoa-code,jevellan-live-sandbox}.before-one-mesh-2026-10-18`.
- **Archives:**
  - 0.4.1 Darwin (used for the join): `/Users/ggomes/.jevellan-build/one-mesh-050/release-041/`;
  - 0.5.0: on the GitHub release, with the build trees in `~/.jevellan-build/one-mesh-050/second/release-0.5.0-linux/` and on the Pro in `release-0.5.0-darwin/`.
