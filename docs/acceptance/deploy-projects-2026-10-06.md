# Projects deployment to the Mac mini pilot - 2026-10-06

The Projects build (BRIEF-projects.md) now runs on the owner's existing Mac mini pilot. It was installed as a frozen release outside any checkout and activated with the established flow: prepare beside the old release, snapshot the data home, wait for the lifecycle gate to be idle, switch gracefully, verify, keep rollback ready. Evidence label: **live** deployment readiness observations. No Projects work (coordinator, thread or message) was started on the pilot, no setting was changed, and Gonçalo's acceptance is not claimed.

The same day a second activation replaced this release with commit `6647f91` and enabled the installation control file, so terminal takeover works on the pilot; see [Second activation](#second-activation-6647f91-and-the-installation-control-file). The sections before it describe the first activation (`49106b7`) as it happened.

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

## Terminal takeover on this pilot

Terminal takeover works on the pilot from 2026-10-06 (second activation, below). The owner runs, on the mini:

    JEVELLAN_HOME=~/.jevellan-build/pilot-2026-09-25/home ~/.nvm/versions/node/v22.22.0/bin/node ~/.jevellan-build/pilot-projects-2-2026-10-06/app/bin/jevellan.mjs thread attach <threadId>

The first activation's launcher built the daemon without `LocalDiagnostics`, so until the second activation no installation control file existed and every `/api/local/*` route answered 401.

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

## Second activation: 6647f91 and the installation control file

Later on 2026-10-06 the pilot was switched again, with the same flow and the same evidence label (**live** deployment readiness observations). Again no Projects work (coordinator, thread or message) was started, no setting was changed, and Gonçalo's acceptance is not claimed.

### Why

- **The vision fixes.** Commit `6647f91` (`6647f910404b4cb29be4ea33ddf0ff90c520ca70`) carries the interface fixes from the full live vision matrix: decisions 592 to 601, among them readable card diffs, Jump to latest and the composer clearance, and the settings tab chevrons. Decisions 593 and 602 change only tests and the fixture server. Since `49106b7` only `apps/web` changed in the shipped code; the daemon, the packages, the runtimes and `bin/` are identical. Origin main is now `37c3cbd`, which only adds evidence files.
- **The installation control file.** The new launcher enables `LocalDiagnostics`, so `jevellan doctor` and `jevellan thread attach` work against the pilot's data home. This removes the known limit of the first activation.

### What was deployed

- Release `/Users/ggomes/.jevellan-build/pilot-projects-2-2026-10-06/` on goncalos-mac-mini, built like the first one:
  - `app/` is `git archive 6647f91` from a fresh clone in a temporary directory. The clone was removed afterwards, and no checkout on the mini was used or touched.
  - `npm ci` ran under Node 22.22.0 with the full prepare build, exit 0. `npm ci` reported one high-severity advisory, in `source-map-js`, which only the build tooling uses (vite and postcss).
  - `apps/daemon/dist/index.js`, `apps/daemon/dist/diagnostics.js`, `apps/web/dist/index.html`, `packages/projects/dist/index.js`, `packages/cli/dist/index.js` and `bin/jevellan.mjs` exist.
- `apps/web/dist/index.html` has sha256 `f142168e4c1f03e6508d0bed3bb52b507d467bb4d3660cb69830e86b9a0ed2d5`. That is identical to the same code's build on goncalos-macbook-pro.
  - The first release's 74 hashed web assets were copied into the new `assets/` without overwriting, so an open browser window can still load its chunks. Four font files had the same names and were byte-identical, which leaves 77 files.
  - The old and the new entry bundles both answer 200 on the tailnet.
- `run.mjs` is the first release's launcher with the new `app/` paths and the installation control file. Everything else is unchanged: the origin, `allowedOrigins`, `proxyOrigin`, port 9773 and the data home.
  - It imports `LocalDiagnostics` from `apps/daemon/dist/diagnostics.js` and passes a mutable options object to `createDaemon`, which reads `options.diagnostics` at request time.
  - Once the server listens and `app.started` resolves, it sets `options.diagnostics = new LocalDiagnostics(app, "http://127.0.0.1:9773")`, before the `Jevellan ready` line.
  - On SIGTERM it closes the listeners (`closeListeners`, which also ends open streams), then the control file, then the application. That mirrors `startDaemon` in apps/daemon/src/index.ts.
- The switch, launch and snapshot helpers are the first activation's, with their paths adapted. `snapshot.py` and `compare.py` are byte-identical copies. `previous-process.json` now records PID 64382 and its command.
  - Its environment is the same seven variables. Their values were verified equal to the running process before the switch.
- `switch.mjs` gained two guards:
  - Before SIGTERM, while holding the gate's maintenance, it refuses if the data home has a `projects/` directory or the daemon has a child process. Projects turns do not enter the lifecycle gate, so `locks/activity.json` alone would not show them.
  - After the new release is ready, it requires a valid installation control file (`doctor-control-v1`, mode 600, origin `http://127.0.0.1:9773`) or rolls back.
- Previous release, kept untouched for rollback: `/Users/ggomes/.jevellan-build/pilot-projects-2026-10-06/` (`49106b7`, the first activation). No file in it changed, outside `daemon.log`, which received the old process's last lines.

### Idle check

- Read-only, before the switch:
  - `locks/activity.json` was polled 19 times, 5 seconds apart, from 12:55:14 to 12:56:50 UTC. It was always empty, and its timestamp advanced every 30 seconds.
  - The daemon had no child process, and the data home had no `projects/` directory.
  - The hub conversation indexes listed 12 conversations: 7 done, 4 blocked and 1 waiting for you, none running.
- The pilot had not been used since the first activation: comparing that activation's AFTER snapshot with this BEFORE snapshot, no conversation, ledger or configuration file had changed.
- Dry run at 12:56:56: the script held the gate's maintenance for about 27 ms and verified the ownership record (held, PID 64382, matching start identity and command line) and that no Projects work was present. It stopped nothing.
- At the switch, maintenance was held on the first attempt and kept through SIGTERM and the old process's exit.

### Timeline (UTC, 2026-10-06)

| Time | Step |
| --- | --- |
| 12:48 to 12:50 | Read-only orientation: listener PID 64382 (parent 1, the first release's `run.mjs`), environment equal to the recorded one, no control file |
| 12:50:38 | Fresh clone, checkout and archive of `6647f91` into the new `app/` |
| 12:51:06 to 12:51:23 | `npm ci` with the prepare build, exit 0 |
| 12:54:43 to 12:54:47 | BEFORE snapshot (`before.json`, full) |
| 12:55:14 to 12:56:50 | Read-only idle polling: idle throughout; then the running baseline (`churn-check.json`) |
| 12:56:56 | Dry run of the switch script |
| 12:57:09.116 | Gate maintenance held |
| 12:57:09.139 | No Projects work state, no child process; SIGTERM to PID 64382 |
| 12:57:09.573 | Old process exited (0.43 s); maintenance released; port 9773 free |
| 12:57:09.688 | New release started, PID 41431 |
| 12:57:13.731 | `Jevellan ready` and loopback health 200 |
| 12:57:13.732 | Installation control file present, valid, mode 600 |
| 12:57:54 | Health, tailnet, served HTML and route checks |
| 12:58:20 to 12:58:22 | `jevellan doctor` and `jevellan thread attach thread_doesnotexist` |
| 12:58:33 to 12:58:37 | AFTER snapshot (`after.json`, full), taken after the command checks so that it covers them |
| 12:59:17 | Stability check |
| 13:04:30 | Stability check after seven minutes; a later snapshot (`later.json`) compared with BEFORE passes with the same results |

The pilot was unavailable for about 4.6 seconds.

The at-rest snapshot that the switch script takes between the old exit and the new start failed this time. Its read-only connection to the hub database answered `unable to open database file`, so it wrote nothing and did not delay the start. The preservation result does not depend on it: BEFORE and AFTER are both full snapshots.

### Checks

| Check | Result |
| --- | --- |
| Loopback `GET /api/health` | 200, `health-v1`, status `ok`, version `0.1.0` |
| Tailnet `GET /api/health` | 200, from the mini and from goncalos-macbook-pro |
| Served `/` (tailnet and loopback) | sha256 equals the new build's `index.html` (`f142168e…`). Before the switch the tailnet served the first release's (`ada30d83…`). |
| `GET /api/project-work` without a session | 401 `unauthenticated`, on loopback and tailnet |
| Installation control file | `<home>/doctor.json`, `doctor-control-v1`, mode 600, origin `http://127.0.0.1:9773`. Its token was never printed or copied. |
| `jevellan doctor` (pilot data home, the daemon's recorded environment) | `OK Daemon: Jevellan 0.1.0 answered on its local diagnostics endpoint.`, so it reports through the local route, not 401. Full result below. |
| `jevellan thread attach thread_doesnotexist` | Exit 1, prints `This thread was not found.` The daemon accepted the control token and refused the unknown thread. A refused attach sends no detach, so nothing changed. |
| `POST /api/local/doctor` without the token | 401 on loopback and through the tailnet route |
| Startup log | `Jevellan ready at https://goncalos-mac-mini-1.tail31efa.ts.net:9444` and Node's SQLite ExperimentalWarning lines only; no error, also seven minutes later |
| Process | PID 41431, parent PID 1, command `node /Users/ggomes/.jevellan-build/pilot-projects-2-2026-10-06/run.mjs`, working directory the new `app/`, the only listener on 127.0.0.1:9773 |
| Launch environment | The same seven variables and values as the previous process (HOME, LANG, PATH, SHELL, SSH_AUTH_SOCK, TMPDIR, USER) |
| No Projects work | No `projects/` or `worktrees/` directory in the data home, no new Projects hub namespace, no child process of the daemon |

`jevellan doctor` exits 1 because not every check is OK. Its lines:

- OK: Node 22.22.0, Git 2.50.1, APM 0.10.0, Claude 2.1.282, Codex 0.160.0, Daemon and Hub.
- MISSING Basic Memory: the doctor's tool probe reads Jevellan's private Basic Memory from the installation manifest (`install.json`). This pilot has no manifest because it was never installed with `jevellan install`.
- WARNING Accounts: 3 of 3 enabled accounts last reported ready. Their status checks are older than five minutes because no runtime has run on the pilot since.
- WARNING Jev: Jev is reachable, but the configured model was not in the list it returned. This is an owner setting to check in Settings, and it was not changed. The check made one live models request with the pilot's saved Jev key.

These are observations about the pilot, not deployment failures.

### Preservation

BEFORE (12:54:43, the first release running) was compared with AFTER (12:58:33, after the command checks). `compare.py` passes with no failure.

- **Strict, all identical (25 of 25):** the 7 login request files under `auth/`, the 3 account sign-in files, `device.json`, `git-settings.json`, the vault key `hub/secret.key` and the 12 conversation ledger files.
- **Conversations:** 12 conversations; all 174 files under `conversations/` are identical.
- **Hub** (`PRAGMA quick_check` ok before and after):
  - The vault's 4 secrets are identical.
  - The 5 configuration revisions and the 1 configuration request are identical.
  - The 6 project ids and the 3 account ids are the same, and every account's authentication status is unchanged (`ready`).
  - 20 of 22 namespaces are identical row by row (355 rows). In `devices` and `heartbeats` (1 row each) the presence heartbeat advanced. It also advanced while the old release ran (`churn-check.json`).
  - No namespace was added or removed.
- **Configuration files:** `apm.yml`, `git-settings.json` and `device.json` are identical. `settings-sync.json` changed only its `at` timestamp (status `applied` before and after).
- **Account homes:** 33 of 36 top-level files are identical. The two Claude `settings.json` and the Codex `hooks.json` changed only in the release path (3 occurrences each) and in `_apm_source` (`c33bec9384d2…` to `b8eda5b6f479…`). Restoring both reproduces the BEFORE hash byte for byte.
- **Native:** the owner's `~/.cursor/hooks.json` is identical.
- **Whole data home:** 4,713 files before and 4,741 after; 4,700 identical and none removed.
  - Changed (13), the same set as in the first activation: the three hook files; the hub database, WAL and shared-memory files; `locks/activity.json` and `locks/daemon.db`; `rigging/application.json` and the three per-account `rigging/state` files; and `settings-sync.json`.
  - Added (28):
    - The new release's rigging package (3 files per runtime) and its account stages (7 per account).
    - **The installation control file `doctor.json`** at the data home's root (`doctor-control-v1`). This addition is expected: `LocalDiagnostics` writes it at startup with a token that is new on every start. By the code (`LocalDiagnostics.close` in the launcher's close order), a graceful stop removes it; that has not been observed on the pilot yet.

### Rollback

`ROLLBACK.md` beside the new `run.mjs` has the exact commands. Rollback needs no data change: the daemon code is identical, and by the code the only new file, the control file, is removed when this release stops gracefully (not yet observed on the pilot). The previous release neither reads nor removes it, and after a forced stop it is safe to delete.

1. Wait until `locks/activity.json` lists no activity and the data home has no `projects/` work.
2. Send SIGTERM to the listener on 9773 (the new `run.mjs`) and wait for it to exit.
3. Run `node /Users/ggomes/.jevellan-build/pilot-projects-2-2026-10-06/launch.mjs old`. It starts the first release's `run.mjs` detached, with the recorded environment.
4. Check `Jevellan ready`, health 200 and the first release's HTML hash (`ada30d83…`). Then compare a new snapshot with `before.json` without path prefixes: the hook files return to the path `before.json` recorded.

After a rollback the local commands answer 401 again. The switch script would have rolled back automatically if the port had stayed busy, the new release had not become ready within 120 seconds, or the control file had been missing or invalid. None of these happened.

### Files on the mini

`/Users/ggomes/.jevellan-build/pilot-projects-2-2026-10-06/` (mode 700) holds:

- the release itself: `app/`, `run.mjs`, `daemon.log`, `build.log` and `ROLLBACK.md`, with the step markers `source-tmp.txt`, `clone.start`, `build.start`, `assets-new.txt`, `switch.start` and `switch.out`;
- the helpers: `switch.mjs`, `switch.log`, `switch-dry.log`, `launch.mjs`, `previous-process.json` (no secret) and `activation.json`;
- the snapshot tools and snapshots: `snapshot.py`, `compare.py`, `before.json`, `churn-check.json`, `after.json` and `later.json`;
- the comparisons: `compare-before-after.json` and `compare-before-later.json`.

### Labels

- **Live:**
  - the release build on the mini, the idle-gated switch, health, the served HTML, the process and environment checks;
  - the installation control file and the two local command checks: the doctor through the local route, and the attach refusal for an unknown thread;
  - the preservation comparison.
- **Not run:**
  - a takeover of a real thread (no live Claude or Codex resume has run on the pilot);
  - an authenticated browser session on the pilot's pages;
  - any coordinator, thread, Jev placement, Claude or Codex turn or GitHub pull request on the pilot.
- The deployment starts no Projects work, and Gonçalo's acceptance is not claimed.
