# Projects deployment to the Mac mini pilot - 2026-10-06

The Projects build (BRIEF-projects.md) now runs on the owner's existing Mac mini pilot. It was installed as a frozen release outside any checkout and activated with the established flow: prepare beside the old release, snapshot the data home, wait for the lifecycle gate to be idle, switch gracefully, verify, keep rollback ready. Evidence label: **live** deployment readiness observations. No Projects work (coordinator, thread or message) was started on the pilot, no setting was changed, and Gonçalo's acceptance is not claimed.

## What was deployed

- Commit `49106b72ec45269138b243c5e327807a70c9edd7` (`49106b7`, origin main at deployment time) of https://github.com/gongiskhan/jevellan.
- Release `/Users/ggomes/.jevellan-build/pilot-projects-2026-10-06/` on goncalos-mac-mini. Its `app/` is `git archive 49106b7` from a fresh clone in a temporary directory (removed afterwards; no checkout on the mini was used or touched), installed with `npm ci` under Node 22.22.0. The prepare step ran the full build (`tsc -b`, the Vite build, the PWA and Cursor bridge steps, exit 0, about a minute). `apps/daemon/dist/index.js`, `apps/web/dist/index.html` and `packages/projects/dist/index.js` exist.
- `apps/web/dist/index.html` sha256 `ada30d8395ca749abf3c2585010f3faa20d32a5e04b1ade6c61f82758e51b65a`, identical to the same commit's build on goncalos-macbook-pro. As in the previous activation, the previous release's hashed web assets were copied into the new `assets/` without overwriting (67 files beside the new build's 7), so a browser window still open on the old page can load its chunks; both entry bundles answer 200 on the tailnet.
- `run.mjs` is the previous launcher with only its two import paths changed to the new `app/`. Unchanged: the data home `/Users/ggomes/.jevellan-build/pilot-2026-09-25/home`, loopback `127.0.0.1:9773` and the Tailscale route `https://goncalos-mac-mini-1.tail31efa.ts.net:9444`.
- Previous release, kept untouched for rollback: `/Users/ggomes/.jevellan-build/pilot-plan-approval-2026-10-03/` (`run.mjs`, `app/`, `daemon.log`), the plan-acceptance build of 2026-10-03.

## Idle check

- The local doctor route (`POST /api/local/doctor`) cannot answer on this pilot: its launcher gives `createDaemon` no diagnostics control, so every local route answers 401.
- Read-only signal: the lifecycle gate writes its admitted work to `<home>/locks/activity.json` on every enter and release (`packages/core/src/lifecycle.ts`), the file the installer reads. Polled from 04:19:33 to 04:21:54 UTC: always empty (its timestamp advances every 30 seconds as short background work enters and leaves). The hub conversation indexes listed 12 conversations, 7 done, 4 blocked and 1 waiting for you, none running.
- At the switch, a script took the gate's exclusive maintenance (`LifecycleGate.tryMaintenance()`, from the new release's core package) on its first attempt. It verified the daemon ownership record (`locks/daemon.db`: held, PID 43005, matching process start identity and command line) and held maintenance through SIGTERM and the old process's exit, so no work could be admitted between the check and the stop. A dry run at 04:21:13 (maintenance held about 15 ms, nothing stopped) tested the script first.
- Graceful close: SIGTERM runs the launcher's `close()`. It closes the application (settings sync, presence, improvers, background drafts, conversations, accounts, bridges, memory, the hub, the lifecycle gate and daemon ownership; the new release closes its project work first) and then the HTTP server. The old process exited in 0.56 seconds with no error in its log.

## Timeline (UTC, 2026-10-06)

| Time | Step |
| --- | --- |
| 04:15:57 | Fresh clone, checkout and archive of `49106b7` into the new `app/` |
| 04:16:03 to 04:16:59 | `npm ci` with the prepare build, exit 0 |
| 04:19:33 to 04:21:54 | Read-only idle polling: idle throughout |
| 04:19:37 to 04:19:41 | BEFORE snapshot (`before.json`, full) |
| 04:21:54.998 | Gate maintenance held |
| 04:21:55.016 | SIGTERM to PID 43005 |
| 04:21:55.573 | Old process exited; maintenance released; port 9773 free |
| 04:21:55.884 | At-rest snapshot (`rest.json`) |
| 04:21:55.885 | New release started, PID 64382 |
| 04:22:00.419 | `Jevellan ready` and loopback health 200 |
| 04:22:29 | Health, tailnet and served HTML checks |
| 04:22:43 to 04:22:46 | AFTER snapshot (`after.json`, full) |
| 04:25:10 | Stability check after three minutes |

The pilot was unavailable for about 5.4 seconds.

## Checks

| Check | Result |
| --- | --- |
| Loopback `GET /api/health` | 200, `health-v1`, status `ok`, version `0.1.0` |
| Tailnet `GET /api/health` | 200, from the mini and from goncalos-macbook-pro |
| Served `/` (tailnet and loopback) | sha256 equals the new build's `index.html` (`ada30d83…`); before the switch it served the old build's (`31eccb01…`) |
| `GET /api/project-work` without a session | 401 `unauthenticated`, as expected, on loopback and tailnet |
| Startup log | `Jevellan ready at https://goncalos-mac-mini-1.tail31efa.ts.net:9444` and Node's SQLite ExperimentalWarning lines only; no error, also after three minutes |
| Process | PID 64382, parent PID 1, command `node /Users/ggomes/.jevellan-build/pilot-projects-2026-10-06/run.mjs`, working directory the new `app/`, the only listener on 127.0.0.1:9773 |
| Launch environment | The same seven variables as the previous process (HOME, LANG, PATH, SHELL, SSH_AUTH_SOCK, TMPDIR, USER), PATH identical, so Git, Claude and Codex resolve as before |
| No Projects work | No `projects/` or `worktrees/` directory in the data home, no new Projects hub namespace, no child process of the daemon |

The new release was started with the previous activation's method: a detached Node spawn (its own session, parent launchd) with the previous process's recorded environment, rather than a shell `nohup`, whose non-interactive PATH would have changed which Git, Claude and Codex the daemon finds.

## Preservation

`snapshot.py` records hashes, counts and ids only and opens the hub database read-only. `compare.py` compared both BEFORE (old release running) and the at-rest snapshot (old process stopped, before the new start) with AFTER. Both comparisons pass with the same results.

- **Strict, all identical (25 of 25):** the 7 files under `auth/` (login requests), the 3 account sign-in files in Jevellan's account homes (the Codex `auth.json` and the two Claude `.claude.json`), `device.json`, `git-settings.json`, the vault key `hub/secret.key` and the 12 conversation ledger files (`conversations/*/ledger/*.jsonl`).
- **Conversations:** 12 conversations; all 174 files under `conversations/` are identical (ledgers, projections, stretches, decisions, handoffs, work and blobs).
- **Hub** (`PRAGMA quick_check` ok before and after):
  - Vault secrets: 4 rows, identical.
  - Configuration revisions: 5, identical (no setting changed). Configuration requests: 1, identical.
  - Registered projects: 6, same ids. Accounts: 3, same ids. Every account's authentication status is unchanged (`ready`). Those statuses were recorded by earlier runs; no runtime has run since the switch, so this is not a fresh login check. That runtimes resolve as before is inferred from the identical launch environment.
  - Namespaces: 20 of 22 are identical row by row (355 rows). `devices` and `heartbeats` (1 row each) gained a revision. That is the presence heartbeat, which also advanced every 30 seconds while the old release ran (measured before the switch). No namespace was added or removed; the Projects namespaces are created on first use.
- **Configuration files:** `apm.yml`, `git-settings.json` and `device.json` are identical. `settings-sync.json` changed only its `at` timestamp (status `applied` before and after), as on every sync.
- **Account homes:** 33 of 36 top-level files are identical. At startup the two Claude `settings.json` and the Codex `hooks.json` (Jevellan's memory hooks in its own account homes) changed in exactly two ways. Restoring both reproduces the BEFORE hash byte for byte:
  - the release path in the hook command (3 occurrences);
  - `_apm_source`, the content hash of the generated rigging package, which embeds that path (`82e0e081f5b1…` to `c33bec9384d2…`).
  The data home keeps one such package per earlier release.
- **Native:** the owner's `~/.cursor/hooks.json` is identical.
- **Whole data home:** 4,686 files before and 4,713 after; 4,673 identical and none removed.
  - Changed (13): the three hook files above; the hub database, WAL and shared-memory files; `locks/activity.json` and `locks/daemon.db` (the gate's publication and the new daemon's ownership record); `rigging/application.json` and the three per-account `rigging/state` files (the applied rigging for the new package); and `settings-sync.json`.
  - Added (27): the new release's rigging package (3 files per runtime) and its account stages (14 Claude, 7 Codex).

## Known limit on this pilot

Terminal takeover does not work on this pilot yet: its launcher (`run.mjs`, kept from the earlier pilot releases) builds the daemon with `createDaemon` and no `LocalDiagnostics`, so no installation control file is written and every `/api/local/*` route, including `jevellan doctor` and the attach and detach routes behind `jevellan thread attach`, answers 401. The thread page still shows the takeover line. To enable it, the launcher must pass `new LocalDiagnostics(application, address)` to `createDaemon` and close it on shutdown, as `startDaemon` does (apps/daemon/src/index.ts), and the command must run against the pilot's data home; that is a launcher change plus another switch through the same idle-gate flow, not a code change. Recorded, not done.

## Rollback

The previous release is intact and needs no data change to run again. The new release has written nothing the previous one cannot read. No Projects namespace or `projects/` state exists until Projects is first used. The conversation documents keep their schemas; the one new field, `noProgressReset`, is optional and is only written with a new reply. `ROLLBACK.md` beside the new `run.mjs` has the exact commands:

1. Wait until `locks/activity.json` lists no activity.
2. Send SIGTERM to the listener on 9773 (the new `run.mjs`) and wait for it to exit.
3. Run `node /Users/ggomes/.jevellan-build/pilot-projects-2026-10-06/launch.mjs old`. It starts the old `run.mjs` detached, with the recorded environment, its `app/` as working directory and its `daemon.log`.
4. Check `Jevellan ready`, health 200 and the old HTML hash (`31eccb01…`), then compare a new snapshot with `before.json`.

The switch script would have rolled back automatically if the port had stayed busy or the new release had not become ready within 120 seconds; neither happened.

## Files on the mini

`/Users/ggomes/.jevellan-build/pilot-projects-2026-10-06/` (mode 700) holds `app/`, `run.mjs`, `daemon.log`, `build.log` and `ROLLBACK.md`, with small step markers. It also holds:

- the switch and launch helpers: `switch.mjs`, `switch.log`, `launch.mjs`, `previous-process.json` (the previous process's environment and command; it contains no secret) and `activation.json`;
- the snapshot tools: `snapshot.py` and `compare.py`;
- the snapshots: `before.json`, `rest.json`, `after.json` and `churn-check.json` (the running baseline taken before the switch);
- the comparisons: `compare-before-after.json` and `compare-rest-after.json`.

## Labels

- **Live:** the release build on the mini, the idle-gated switch, health, the served HTML, the process and environment checks, and the preservation comparison.
- **Not run:** an authenticated browser session on the pilot's Projects pages, and any coordinator, thread, Jev placement, Claude or Codex turn or GitHub pull request on the pilot. PJ-live stays blocked on its credentials.
- The deployment starts no Projects work, and Gonçalo's acceptance is not claimed.
