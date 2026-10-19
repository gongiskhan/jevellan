# One mesh, release 0.5.0 and live journeys, October 2026

Run log for the 18 October 2026 brief: release 0.5.0 with a gate that blocks only on new failures, make dev-madrid the only state point with HTTPS, put the Pro on 0.5.0 as an ordinary member, and run the parity journeys live on `jevellan-live-sandbox`. Times are UTC. Every result is labelled live, simulated or not run.

## Clocks

- Preflight started: 2026-10-18T09:27:58Z on dev-madrid, source `2e3f4fd19d05a85aed8e5736c8dd68bde84ceb3c` (0.4.1), clean, equal to `origin/main`.
- Build clock (phases 0 to 3): first commit at 2026-10-18T09:44:42Z (pushed as `025d44e4` after an amend that only added these clock lines); deadline 2026-10-18T18:44:42Z.
- Live clock: three hours from the moment both machines report 0.5.0 in `jevellan doctor`. Not started.

## Phase log

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 Preflight | Complete, 09:27–09:44 | Live; below |
| 1 Release gate | Passed by the brief's rule at 18:43:46 UTC | Simulated; caveats below |
| 2 Release 0.5.0 | Partial | Version bump and verified archive candidates (`de5bb8ce`; Darwin also `46ca83d2`), unpublished; no archive at the final revision |
| 3 One mesh | Not run | Build clock ended first |
| 4 Live journeys | Not run | Release and migration did not happen within the clock |
| 5 Closing | Handoff | [HANDOFF.md](HANDOFF.md) |

## Phase 0: preflight (live)

### dev-madrid

- `jevellan doctor` (default command, Madrid state point 0.4.1): nine checks OK; Accounts WARNING "3 of 3 enabled accounts last reported ready on this device. 3 status checks need refreshing in Settings"; exit 1.
- Health: `http://127.0.0.1:9771` 0.4.1 (`jevellan.service`, home `~/.jevellan-hub`); `http://127.0.0.1:9772` 0.3.6 (`jevellan-member.service`, home `~/.jevellan-member`, member of the Pro's old mesh); `https://dev-madrid.tail31efa.ts.net` proxies to 9772 and answers 0.3.6.
- Units: both active, zero restarts. `jevellan-member.service` is the hand-made unit from the 16 October reconnection; the member home's `install.json` records no application, service or command, only the `:443` HTTPS route.
- `tailscale serve status`: 35 routes. Root `:443` → 9772; `:8500` serves the folder `/home/ggomes/Documents/Codex/2026-09-03/so-i-used-to-play-this`; `:8497` serves a single file. `sudo -n tailscale serve status` succeeds without a password prompt.
- Disk 397 GB free on `/`; load 3.9 on 16 cores; Node default v20.19.4, builds and services use v22.23.2; Tailscale 1.98.8.
- Madrid project threads: none running. ekoa-code has five threads in review; `jevellan-live-sandbox` has one in review, four stopped and one done. The state point's service process tree contains only the daemon and Basic Memory, no agent process. Nothing was stopped.
- Checkout: `main` at `2e3f4fd1`, equal to `origin/main`. `.env` exists, is ignored (`.gitignore:5`) and defines `JEVELLAN_TEST_CLAUDE_TOKEN` (checked by name only). `BRIEF.md` is ignored (`.gitignore:1`).
- SSH to the Pro (`goncalos-macbook-pro`, `100.108.210.116`) with batch mode works.
- CodeGraph: the checkout's `.codegraph` index is from 3 October and no CodeGraph command is installed; source exploration uses the checkout directly.

### Pro

- `jevellan doctor` (`~/.local/bin/jevellan`, 0.3.6): nine checks OK; the same Accounts WARNING; exit 1.
- Health: `http://127.0.0.1:9771` and `https://goncalos-macbook-pro.tail31efa.ts.net:9443` both answer 0.3.6 at 09:30. The brief's unresponsiveness was not reproduced at this moment.
- launchd `dev.jevellan.daemon` running. No project thread running (one ekoa-code thread in review); the daemon's children were Basic Memory and SSH sessions only.
- `tailscale serve status`: `:9443` → 9771 plus eight unrelated routes. Tailscale client 1.92.3, daemon 1.102.2.
- Disk 49.9 GB free (89 % used); load 6.1 on 10 cores; macOS 15.7.4; Node v22.22.0.
- `/Users/ggomes/.jevellan-member` does not exist. `/Users/ggomes/jevellan-projects/` already holds `ekoa-code`, `ekoa-code-runtime`, `jevellan-live-sandbox` and cache folders from earlier runs.

### Cold backups (live)

Each copy was taken by holding the installation's own lifecycle gate (the exclusive lock `jevellan update` uses) until no admitted work remained, stopping the service, copying the stopped home, then restarting the service and waiting for health. Each service answered its previous version again afterwards. Manifests and hashes stay private beside each copy.

| Machine | Source | Stopped | Method | Size | Files in manifest |
| --- | --- | --- | --- | --- | --- |
| dev-madrid | `~/.jevellan-hub`, `jevellan.service`, `~/.local/bin/jevellan` | 09:30:27–09:35:33 | `cp -a` | 37 GB | 496,398 |
| dev-madrid | `~/.jevellan-member`, `jevellan-member.service` | 09:35:56–09:40:04 | `cp -a` | 25 GB | 430,598 |
| Pro | `/Users/ggomes/.jevellan`, `dev.jevellan.daemon.plist`, `~/.local/bin/jevellan` | 09:40:28–09:41:44 | APFS copy-on-write clone (`cp -c`) | 17 GB | 312,772 |

Locations: `~/.jevellan-build/one-mesh-050/backup-madrid/` on dev-madrid and `/Users/ggomes/.jevellan-build/one-mesh-050/backup-pro/` on the Pro. The earlier Pro rollback `projects-parity-050-rollback-pro-2026-10-18` (01:47) is retained untouched.

## Phase 1: release gate (simulated)

Builder: dev-madrid, Node 22.23.2, the isolated APM and Basic Memory toolchain of the retained member home first on PATH (native Basic Memory unused). Browser: Playwright's bundled Chromium, as in the 15 October Madrid run; PAR6 alone uses the installed Google Chrome (Decision 921). Baseline: a separate clone at `da6a9bc96c9b963bb5b9bb2de609dbcddfa5dd06`, built the same way, fixture port base 29771 or a per-case base. Every class and attempt is in [gate.json](gate.json).

### Full runs at main (`025d44e4`)

- Build, typecheck and lint pass. `npm run scan:secrets` passes before every push.
- Backend (six workers, Decision 916): 2,388 passed, 9 failed, 5 skipped of 2,402, in 34 minutes.
- Browser (vision off, four workers): 233 passed, 13 failed, 130 not run of 376, in 1.3 hours. `projects.spec.ts` is serial, so its first failure in each layout skipped the rest of that layout's journeys.

### Classes of the main failures

| Case | Main alone | Baseline alone | Class | Action |
| --- | --- | --- | --- | --- |
| Six push-notification backend cases (`/private/tmp` path) | 0 of 3 each | absent | Regression | Fixed in `f47b314f` (Decision 918); the file passes 13 of 13 |
| Two installation-file and one runtime-packaging mode checks | 0 of 3 each | 0 of 3 each | Pre-existing | None. They expect group and other execute bits; the runner's umask is 077, and they pass 26 of 26 under umask 022 |
| PJ7 attached composer, phone dark | 0 of 3 | 3 of 3 | Regression | Fixed in `f47b314f` (Decision 919); passes 3 of 3 alone after the fix |
| LJ2 desktop light and desktop dark, PJ5 phone light | 3 of 3 | 3 of 3 | Load-sensitive | None |
| J8 and J11 mesh journeys, four layouts each | 0 of 3 each | 0 of 3 each | Pre-existing | None. `/` opens the first project since `4af16084` (before the baseline), so the journeys never reach the conversation form. The first runs stopped after one failure; they were completed to three and three later, keeping the first receipts |
| Packed installation, phone dark | first group 2 of 3 (overlapped); quiet group 3 of 3 | 3 of 3, then 3 of 3 quiet | Load-sensitive (quiet conforming group) | None; see below |

### Packed installation, phone dark

The first main group, 12:45 to 13:15 UTC, passed, passed, then failed with "Update did not reach the running-work wait" after 120 seconds. It overlapped this run's own full backend at `de5bb8ce` and its vision runs, so it was not a run alone. That procedural defect is kept and disclosed: the receipts are retained and gate.json lists each attempt's overlaps.

The conforming quiet group ran at the same commit `025d44e4` with nothing else of this run in parallel, at load 6 to 8:
- main: three alone, 15:07 to 15:25 UTC, all passed;
- baseline: three, 15:25 to 15:41 UTC, all passed.

By the brief's table, a case that passes three of three alone at main is load-sensitive.

The update path is unchanged since the baseline apart from named-installation plumbing, and the packed application grew from 1,140 to 1,177 MB unpacked. In timed direct runs of the same spike, the update reached its running-work wait 71 seconds after the previous step at `dbfaf8a0` and 82 seconds at the baseline.

### Superseded full backend at `de5bb8ce`

The release-candidate backend run, 12:47 to 13:32 UTC, recorded 2,387 passed, 10 failed and 5 skipped. Later source fixes followed, so it is not a final-commit run. Its seven new failures were classified the same way:
- five Conversation timeouts: pre-existing, failing alone at both commits;
- one member outage case: load-sensitive, 3 of 3 alone;
- the Codex runtime contract: its single main run overlapped other runs; a quiet group at `4379b1ae` passed 3 of 3 at main and 3 of 3 at baseline, so load-sensitive.

Every group was completed to three runs at each commit.

Many early attempts overlapped other heavy runs of this session. Each attempt's overlaps are listed in gate.json. Where the class depends on isolation, quiet conforming groups decided it: the installation journey and the Codex contract.

### Vision on the parity journeys (live judge, simulated product)

With `JEVELLAN_TEST_CLAUDE_TOKEN` loaded only in the browser-test shell, `npx playwright test --project '*-projects' -g PAR` ran repeatedly. PAR6 ran separately on installed Chrome (Decision 921).

Blocking findings, each a defect fixed and rerun:
- PAR1 notification radios misaligned;
- PAR3 expected only four Overview tabs (stale);
- PAR5 usage headings broke mid-word, then the table clipped on phones;
- PAR7 chat chips rendered empty containers;
- PAR7b the phone toast covered the composer;
- PAR8 the placement fields hid under the sticky dialog actions;
- PAR9 a fixture step replayed (Decision 923).

One run used the wrong tool PATH; that environment error is recorded and its run discarded.

Latest passing evidence per journey, in all four layouts:
- PAR1 to PAR6 at `dbfaf8a0`;
- PAR7, PAR7b and PAR8 at `b831ed04`;
- PAR8 and PAR9 at `73c99e35`.

Earlier timeouts in the same journeys (login, library and Edit requests under load) are in the receipts.

### Final full runs at the final source revision `c82c371e`

- Backend, 16:45:28 to 17:26:45 UTC: 2,394 passed, 3 failed and 5 skipped of 2,402. The three failures are the umask-dependent cases already classified pre-existing. There were no new failures. The five skips are not run: four live decision-selection cases need `JEVELLAN_TEST_JEV_KEY`, which is unset, and the opt-in `live-sandbox-node20` case needs `JEVELLAN_TEST_NODE20`.
- Browser, vision off, started 17:26:49 UTC at `1e9e4074`, which is source-identical to `c82c371e` and differs only in docs: 17:26:49 to 18:34:38 UTC, vision off, at `1e9e4074` (source-identical to `c82c371e`). Result: 237 passed, 12 failed, 127 not run of 376; the not-run cases are the serial `projects.spec.ts` chain after its first failure in each layout. All four packed installation journeys passed. Failures: J8 and J11 in four layouts each, the same pre-existing cases; LJ2 desktop-light and desktop-dark, already classified load-sensitive at `025d44e4` with no change to their code path since; and two new cases, PJ4b phone-dark and LJ2 phone-light. Their classification ran alone after the matrix:
- PJ4b phone-dark passed 3 of 3 at main and 3 of 3 at baseline (18:34 to 18:39 UTC), so it is load-sensitive.
- LJ2 phone-light passed 3 of 3 at main (18:39 to 18:41 UTC), so it is load-sensitive. Its baseline runs passed, failed with `ECONNRESET` on a fixture request, then passed; the last run ended at 18:43:46 UTC.

### Vision evidence gap

After each vision run the canonical screenshots and vision records were restored to their committed versions. The images judged in the passing runs, and the judge's individual records and cosmetic notes, were therefore not retained. Playwright's pass/fail results (private JSON) and failure traces remain. The final browser's fresh captures are kept privately as simulated recaptures, not as vision-judged images.

### Gate result

**Passed by the brief's rule at 18:43:46 UTC, less than a minute before the clock, so no release followed.** Every regression the gate classified is fixed. The full backend and browser ran at the final source revision after the last fix. Their new failures are classified:
- PJ4b phone-dark is load-sensitive: 3 of 3 alone at main and at baseline.
- LJ2 phone-light is load-sensitive: 3 of 3 alone at main. Its baseline runs passed, failed with `ECONNRESET` on a fixture request, then passed.
- LJ2 desktop-light and desktop-dark keep their earlier load-sensitive classification at `025d44e4`; nothing in their code path changed since.
- J8 and J11 are the same pre-existing cases.
Every PAR journey has passed with vision in all four layouts.

Caveats: the judged images and vision records were not retained; several early attempt groups overlapped this run's own heavy jobs, as listed per attempt in gate.json; and the one closing review did not cover the last two fixes.

The single closing serious-issues review was one pass by the builder at about 15:25 UTC. It covered the source diff `2e3f4fd1..b831ed04` and found no serious problem. The later fixes `73c99e35` (a fixture step) and `c82c371e` (usage figures and the PAR5 assertion) were not reviewed.

## Second run, 18 to 19 October

A fresh run of the revised brief: one mesh first on the installed versions, then release 0.5.0, then the live journeys. It does not resume the first run's clocks. Times are UTC; every result is labelled live, simulated or not run.

### Clocks

- Started: 2026-10-18T19:42:09Z on dev-madrid, `main` at `6ff46c1c` (source 0.5.0, gate complete at `c82c371e`). The phase 0 start starts the clock.
- Phases 0 and 1: four hours, not counting any wait for the owner pause; nominal deadline 2026-10-18T23:42:09Z.
- Phase 2: four hours from its start. Phase 3: three hours from the moment both machines report 0.5.0.
- The full test gate does not run again unless the source changes.

### Phase 0: fresh cold backups (live)

Before the copies, no service had admitted work (each home's lifecycle activity list was empty) and no agent process ran under any of the three services. Each copy held the installation's lifecycle gate until no admitted work remained, stopped the service, copied the stopped home, then restarted it and waited for health.

| Machine | Source | Stopped | Method | Destination |
| --- | --- | --- | --- | --- |
| Pro | `/Users/ggomes/.jevellan`, `dev.jevellan.daemon.plist`, `~/.local/bin/jevellan` | 19:43:00–19:44:16 | APFS clone (`cp -a -c`) | `/Users/ggomes/.jevellan-build/one-mesh-050/backup-pro-2/` |
| dev-madrid | `~/.jevellan-hub`, `jevellan.service`, `~/.local/bin/jevellan` | 19:44:48–19:50:03 | `cp -a` | `~/.jevellan-build/one-mesh-050/backup-madrid-2/hub/` |
| dev-madrid | `~/.jevellan-member`, `jevellan-member.service` | 19:50:40–19:54:47 | `cp -a` | `~/.jevellan-build/one-mesh-050/backup-madrid-2/member/` |

Each service answered its previous version again afterwards (0.3.6, 0.4.1, 0.3.6).

| Copy | Size | Files in SHA-256 manifest | Symbolic links |
| --- | ---: | ---: | ---: |
| Pro state point home | 17 GB | 312,772 | 331 |
| Madrid state point home | 37 GB | 497,102 | 1,776 |
| Madrid old member home | 25 GB | 430,598 | 1,731 |

Manifests, unit-file and command hashes stay private beside each copy. The Madrid manifests ran 19:55:36 to 20:03:30 as the only heavy job (load 2.8 at its start).

After the restarts:
- Pro: `jevellan doctor` (0.3.6) nine checks OK, Accounts WARNING "3 of 3 enabled accounts last reported ready on this device. 3 status checks need refreshing in Settings", exit 1. Free disk 40 GiB of 460 GiB; load 7.7 on 10 cores.
- Madrid state point: `jevellan doctor` (0.4.1) nine checks OK with the same Accounts WARNING, exit 1. Free disk 251 GB; load 2.7 to 3.4 on 16 cores.
- Madrid old member, doctor run from a shell with its home and Node 22 but without the service's full PATH: Daemon, Hub and Jev OK; Basic Memory, Claude and Codex reported missing on that shell's PATH; exit 1. It is retired in phase 1 step 2, so this is recorded as is.
- `tailscale serve status` on Madrid listed the same routes before and after the copies (order differs only). Root `:443` → 9772 and the `:8500` folder share were still in place.

Procedure deviations, recorded as they happened:
- The Pro's 0.4.1 archive build (npm ci and build, 19:53:53 to 19:54:20, phase 1 preparation) overlapped the Madrid member copy. From then on heavy jobs ran strictly one at a time across both machines.
- Phase 1 steps 1 to 3 on Madrid (19:58 to 20:00) started while the phase 0 manifests were still hashing the finished copies, before this phase 0 commit. The copies themselves were complete and untouched by those steps.
- Phase 0 ended with its commit at 20:12:39, about 30 seconds past its 30-minute budget (the secret scan ran twice because the first run's exit status was not captured).

### Phase 1: one mesh on the installed versions (live)

Madrid's installed 0.4.1 was built from `e2a32342` ("Release 0.4.1"): all 2,434 tracked files that the installation ships are byte-identical to that commit, and it was installed four minutes after it.

**dev-madrid**

1. 19:58: `sudo -n tailscale serve --https=8500 off` removed the folder share. To re-add it: `sudo tailscale serve --bg --https=8500 /home/ggomes/Documents/Codex/2026-09-03/so-i-used-to-play-this`.
2. 19:59: the old member (restored by hand on 16 October, not a managed installation) was retired. Its daemon had no admitted work; this run's own restart had started it at 19:54:45. `systemctl --user disable --now jevellan-member.service` stopped it. The unit file moved to `backup-madrid-2/member/unit-moved/`, and `~/.jevellan-member` is kept.
3. HTTPS root. A hand-added `:443` route to 9771 (20:00) served health but not the application: 0.4.1 accepts only its recorded address as a request origin, and the state point was installed without HTTPS. So every other request answered 403 "Unknown request host". The address was then set through the normal installation path:
   - The manual route was removed, and the installed 0.4.1 command ran `jevellan install --https` from a byte-identical copy of itself (20:15:13 to 20:15:24). It reused the installed application, recorded the `:443` route in the installation, set the state point's address to `https://dev-madrid.tail31efa.ts.net` and restarted the service once while idle.
   - Tailscale refuses non-root route writes on this machine while another route serves a path (`:8497`, belonging to other work and left alone). That one install therefore ran with a temporary `tailscale` shim first on PATH. The shim sent only `tailscale serve` writes through `sudo -n` and was deleted right after. The service's PATH keeps that now-missing directory until the 0.5.0 update rebuilds it.
   - An earlier attempt with `--from` pointed at the installed folder failed at its build step, before touching the service. It left one empty, not-ready distribution record.
4. Confirmed:
   - HTTPS health reports 0.4.1, and the owner UI loads over HTTPS (Settings → Devices, no request errors).
   - The vault synced at 20:15:26 with no error. ekoa-code and `jevellan-live-sandbox` are listed.
5. Owner pause: not needed at this step. The dedicated harness owner state from the 15 October run (private, mode 600) still authenticates. A private copy bound to the HTTPS address authenticates too (`/api/auth` true). Both serve the live harness and the join invitation. No passphrase or token was handled.

**The Pro**

6. Notebook:
   - The Pro's ekoa-code notebook (revision 41, last updated 04:46) was read from the phase 0 clone. After the stop it was confirmed unchanged in the stopped database, opened read-only.
   - Madrid's notebook lacked its owner instructions, plan and gotchas. A revision-checked write (17 → 18) appended the whole Pro notebook under "From the Pro's coordinator, until 18 October", with its headings demoted one level.
   - Thread history and memory were not migrated. The Pro's 33 ekoa-code memory notes are copied privately into `backup-pro-2`.
7. Retirement: the installation's own `jevellan uninstall` (0.3.6, no `--purge`; 20:17:10 to 20:17:27) ran on the idle state point (daemon started by this run's own restart at 19:44:09, no children, no admitted work).
   - It removed the launchd service, its plist, the `jevellan` command and the Tailscale `:9443` route (recorded as removed).
   - It then stopped with "An installed application changed outside Jevellan. Its files were preserved". The eight old application folders therefore remain inside the retained `/Users/ggomes/.jevellan`.
   - The Mac mini drops out with this state point. It was not touched.
8. Join:
   - A Darwin archive was built on the Pro from a fresh clone at `e2a32342` (`jevellan-0.4.1-darwin-arm64.tgz`, 380,272,702 bytes, SHA-256 `8fe6febcc68426730bf4cff73a264706038990736370e418d2e50e109216777f`). It was extracted in an empty folder: 2,434 tracked files match the commit, and the actual CLI reports 0.4.1. The native terminal addon ran.
   - The invitation was created on Madrid with the owner state. The Pro joined from that archive into the fresh home `/Users/ggomes/.jevellan-member` with `--https` and the default name (20:20:15 to 20:20:55).
   - The Pro member runs at `https://goncalos-macbook-pro.tail31efa.ts.net` under launchd `dev.jevellan.daemon`.
9. Codex: the Pro's old isolated Codex login was moved, not copied, into the new member's home for Madrid's "Ekoa Codex" account, on the same volume. Its ChatGPT account id matches that account's login on Madrid (compared by hash only). Claude accounts arrived from the state point. After the product's own device switch from the state point, all three accounts report Ready on both machines.
10. Project clones:
    - The old Pro clones were idle and clean. They were moved aside, not deleted, to `/Users/ggomes/jevellan-projects/{ekoa-code,jevellan-live-sandbox}.before-one-mesh-2026-10-18`, keeping their local-only branches. The sandbox clone's four linked-worktree registrations were already prunable and are unchanged.
    - Fresh clones are at `/Users/ggomes/jevellan-projects/ekoa-code` and `/Users/ggomes/jevellan-projects/jevellan-live-sandbox`.
    - The Pro protects `/Users/ggomes/dev/ekoa-code`, the owner's actual checkout. The old registration's `/Users/ggomes/Projects/ekoa-code` no longer exists.
    - The Pro's per-device limit is 4 on both projects; nothing else in either project's settings changed, and autoMerge stays off.
    - Sandbox: one stale in-review test thread from 15 October was stopped. Its pull request #19 stays open. Then the Pro path was added and both devices were allowed.
    - ekoa-code: **blocked**. 0.4.1 refuses any change to a project's paths while a thread is open (D92), even adding a new device. ekoa-code has five owner-held threads in review, which were not touched. Its Pro path and device permission wait for the correction in phase 2 and the 0.5.0 update.
11. Disk: the Pro has 38 GiB free (guard 20 GB). Nothing was reclaimed.
12. The Mac mini is unchanged; see the handoff.

**Phase 1 result: the one-mesh baseline works on the installed versions (live), with one blocked item.**

- `jevellan doctor`: ten of ten OK, exit 0, on both machines (20:30). One Madrid run a minute earlier reported Accounts MISSING "2 of 3", while Gmail's automatic status probe was mid-refresh. The rerun was clean.
- Settings → Devices lists dev-madrid (state point) and the Pro (member) Online, both 0.4.1, both on HTTPS.
- Every enabled account (Claude Gmail, Claude Ekoa, Ekoa Codex) is Ready on both machines.
- Throwaway task:
  - Created on `jevellan-live-sandbox` with its device fixed to the Pro, at 20:33:42, after four refusals while the Pro's five-minute load was above twice its cores (owner desktop apps, not this run). Placement: Claude Code, Claude Opus 5.5, medium, worktree, on the Pro, Gmail account.
  - It opened [sandbox pull request #20](https://github.com/gongiskhan/jevellan-live-sandbox/pull/20) at 20:34:40 (README and CHANGELOG, `result` check passing). The thread was Ready for review at 20:35:53.
  - #20 was closed unmerged at 20:37:10; the sandbox's autoMerge stayed off. The stopped 15 October test thread's pull request #19 is untouched and still open.
- **Blocked: ekoa-code on the Pro.** No supported operation adds a device path while a project has open threads, and ekoa-code's five owner-held threads in review were not stopped. Decision: correct the guard in 0.5.0 so it allows a pure addition of a new device's path, then register the Pro through the normal API after the verified update (phase 2).
- Clock: phase 1 work ended at 20:37. No owner pause was sent and no waiting time is excluded.

### Phase 2: release 0.5.0

Clock: started 2026-10-18T20:40:50Z, after the phase 1 push; deadline 2026-10-19T00:40:50Z.

**Source correction (Decision 924, simulated evidence).** The parent agent decided to correct the open-thread path guard on main for 0.5.0 instead of stopping ekoa-code's threads.
- A regression test (`tests/project-settings-guard.test.ts`) first failed exactly at the pure addition, while the three mixed changes it also tries were refused.
- `packages/mesh/src/state.ts` now allows a write whose existing paths and Git policy are all unchanged and which only adds a path for a device that had none. Changing or removing a path, or changing the Git policy, still answers 409 while a thread is open.
- Build, typecheck and lint pass. The guard file passes 2 of 2, and the related backend files (project settings guard, mesh state, project context service, ekoa-code setup, mesh devices, member application, project work API) pass 178 of 178 tests in 7 files.
- Committed as `fd115cc7`. The earlier gate does not cover this change; the full suites below do.

**Vision on the parity journeys (live judge, simulated product), at `fd115cc7`.** `npx playwright test --project '*-projects' -g 'PAR'` ran with the whole `.env` loaded and `JEVELLAN_VISION_EVIDENCE_DIR` set to [vision/](vision/). PAR6 ran separately on installed Chrome (Decision 921). The `-g 'PAR'` pattern also selects PJ3b, as in the first run.
- 21:09:28: 46 passed, 1 failed, 1 not run (48 cases). The failure was PAR8 desktop-dark: `apiRequestContext.get` timed out after 15 s reading the fixture's `/hub/config`, with no vision verdict involved. PAR9 desktop-dark did not run because the spec is serial.
- PAR6 on Chrome, 21:26:01: 4 of 4 passed.
- PAR8 and PAR9 desktop-dark then ran alone at main three times, with vision (21:30 to 21:42). Each attempt passed 2 of 2, so the PAR8 failure is load-sensitive. The baseline `da6a9bc9` has no PAR8 or PAR9, so the baseline half of the rule is not comparable.
- The failing attempt's trace was lost: the PAR6 run reset `test-results/` before it was copied. Its error text is kept privately.
- Result: every PAR journey passed with vision in all four layouts, with no blocking finding, so no source fix was needed.
- Retained evidence:
  - 176 judged records with their exact PNGs for the first runs, plus 12 and 12 per rerun attempt in `vision/attempts/attempt-2` to `attempt-4`.
  - `images.sha256` maps each image to its source path and record. A copier saved each image as soon as its record appeared, because the records point at `test-results/`, which the next run clears.
  - The canonical parity screenshots in the repository are those judged captures.

**Full backend at the final source (simulated), one run.** 21:42:49 to 22:15:49 UTC at `65cc8f8b`, which is source-identical to `fd115cc7`. The whole `.env` was loaded, with six workers (Decision 916) and the gate's tool PATH.
- Result: 2,402 passed, 0 failed, 1 skipped of 2,403 tests in 228 files.
- The skip is the opt-in `live-sandbox-node20` case.
- The umask-dependent installation-file and runtime-packaging cases, pre-existing failures under the first run's umask 077, passed under this shell's umask 002.
- **Step 2, Jev-key cases (live Jev, simulated product):** with `JEVELLAN_TEST_JEV_KEY` loaded, all 23 cases of `tests/decision-selection.test.ts` passed. That includes the four that skipped in the first run: three live operational action regressions and the live dedicated Jev smoke of Call A and Call B with effort. No case in that file skipped.

**Full browser at the final source (simulated), one run.** 22:15:50 to 23:25:37 UTC at `65cc8f8b`, with vision off, the whole `.env` loaded and four workers.
- Result: 242 passed, 12 failed, 122 not run of 376.
- The 122 not-run cases are the serial `projects.spec.ts` chain after the first failure in each projects layout. They are not failures; each one's vision-judged parity journey is covered above.
- All four packed installation journeys passed.
- Failures:
  - J8 and J11 in four layouts each: the same pre-existing cases.
  - LJ2 desktop-light and phone-light: already classified load-sensitive at `025d44e4` and `c82c371e`. `fd115cc7` does not touch their code path.
  - Two new cases, classified below: LJ2 phone-dark, and "Thread history folds while current work and thinking stay expanded" desktop-dark.

**Classification of the new browser failures (simulated).** Each new case ran three times alone at main, then three times at the baseline `da6a9bc9`, serially (23:27:48 to 23:36 UTC):

| Case | Main alone | Baseline alone | Class |
| --- | --- | --- | --- |
| Thread history folds while current work and thinking stay expanded, desktop-dark | 3 of 3 passed | 3 of 3 passed | Load-sensitive |
| LJ2 native setup remains visible and merge routing explains its ask-owner choice, phone-dark | 3 of 3 passed | 3 of 3 passed | Load-sensitive |

A first classification attempt (23:27:10) was stopped after a few seconds, before any case finished: its filter had taken the 122 not-run cases as failures. Only this run's own verified process group was stopped.

The browser runs rewrote 337 tracked canonical screenshots and added new captures, none of them vision-judged. They are kept privately as simulated recaptures. The repository's canonical screenshots stay at the judged captures of `65cc8f8b`.

**Gate result: passed.** There is no regression. Every failure at the final source is either pre-existing (J8, J11) or load-sensitive (LJ2 in three layouts, Thread history folds desktop-dark, and PAR8 desktop-dark in the vision run). Every PAR journey passed with vision in all four layouts.

**Closing review (one pass, serious issues only).** The builder read the source diffs of `73c99e35`, `c82c371e` and `fd115cc7` at about 21:17 to 21:21 UTC, during the first vision run. Notes were written at 22:27. The final source after the gate is still `fd115cc7`, so the review covers it.
- `73c99e35`: test fixture only. The PAR8 step now matches only the owner's own line.
- `c82c371e`: the last three usage cells (turns, tokens, cost) no longer wrap. Larger figures scroll inside their box rather than clip.
- `fd115cc7`: an addition cannot move a running thread, because a thread's device always had a path. Changes and removals are still refused.

No serious problem was found, so there is no second pass.

**Release revision:** `f212c3d3`, the latest main containing `c82c371e` and the correction `fd115cc7`. Everything after `fd115cc7` is documentation and evidence.

**Archives (live build, verified).** Each was built from a fresh clone at `f212c3d3` (Linux on dev-madrid, Darwin on the Pro), extracted in an empty folder and checked:
- all 3,544 tracked files the package ships are byte-identical to the commit;
- the extracted `jevellan --version` reports 0.5.0;
- the native terminal addon ran.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| jevellan-0.5.0-linux-x64.tgz | 572,116,654 | 97d28d834e185d9ad1031b18d9eb5a1e74773d4d8373e6614469e12aff206fa1 |
| jevellan-0.5.0-darwin-arm64.tgz | 440,888,012 | 3ee448bd1dfc6ac6e34745a869996acca11bce011f6bc9a3fd87485b3fb06287 |

**Order adjustment, agreed with the parent agent.** ekoa-code's nightly window opens at 00:00 UTC on Madrid. So Madrid's snapshot and update ran right after the Linux archive was verified, before the Darwin build and the publish. Heavy jobs stayed one at a time.

**Pre-update rollback state (live, cold).**
- Madrid (23:43:24 to 23:44:30, service stopped through its lifecycle gate): 7.8 GB copy of `~/.jevellan-hub` with its SHA-256 manifest, plus the unit file and command, at `~/.jevellan-build/one-mesh-050/second/pre-update-hub/`.
  - Excluded: `worktrees/` (23 GB), `cache/` and `tmp/`. They stay in place, and the update does not migrate them.
  - The copy covers the state, configuration, vault checkout and homes as they were on the working one-mesh 0.4.1.
- The 0.4.1 Pro member cannot read the 0.5.0 documents. It was therefore fenced before Madrid's update: its lifecycle gate was held with no admitted work at 23:44:50, and its launchd job was booted out and not restarted.
  - Process check: the job's PID 42994 matched the member installed by this run at 20:20:55, seen with that PID at 20:21. The fresh start-time re-check before the stop failed on a parsing error, and that gap is recorded.
  - The stopped home was then cloned cold (APFS, 2.0 GB, 68,536 files hashed), with its plist and command, at `/Users/ggomes/.jevellan-build/one-mesh-050/pre-update-member/` on the Pro.
- Rollback: `jevellan rollback` restores the 0.4.1 application only, because the 0.5.0 data (settings v4, accounts v2) cannot be read by 0.4.1. A full rollback stops the service and restores these copies over the home, leaving the worktrees in place.

**Publish (live).** Tag `v0.5.0` at `f212c3d3`, pushed after the pre-push secret scan. The [GitHub release v0.5.0](https://github.com/gongiskhan/jevellan/releases/tag/v0.5.0) carries both assets at the sizes above.

**Updates (live).**
- Madrid: `jevellan update --from` the Linux archive, 23:45 (service up at 23:45:43, 0 restarts).
  - It ran with the state point's original service PATH, so the rebuilt service PATH no longer lists the install-time shim directory.
  - Previous version 0.4.1 is kept.
- Pro: `jevellan update --from` the Darwin archive, 00:01:03 to 00:01:24. Previous version 0.4.1 is kept.

**Confirmed (live):**
- doctor ten of ten OK, exit 0, on both machines, after fresh account checks;
- Settings → Devices lists both on 0.5.0, Online;
- both projects' settings migrated from v3 to v4. `threadRules` became `instructions` with identical text, and only new defaults were added; ekoa-code's other values, autoMerge off included, are unchanged;
- the vault synced at 23:45:51 with no error.

Both machines reported 0.5.0 at 00:01:40 UTC, which starts the live clock.

**ekoa-code on the Pro (live, Decision 924).** At 00:03 the normal project write added the Pro's path (`/Users/ggomes/jevellan-projects/ekoa-code`) and allowed the Pro, while the five owner-held threads were still open. Result: 200; the existing path, Git policy and every other field are unchanged. ekoa-code's nightly window had started its own work at 00:00 (three threads running at 00:03); none of it was touched.

Phase 2 finished at about 00:05 UTC, within its clock.

### Phase 3: live journeys (live clock 00:01:40 to 03:01:40 UTC)

These ran on `jevellan-live-sandbox` with real Claude and Codex accounts, real Jev and real GitHub, against the published 0.5.0. The harness is driven through the owner UI, with the dedicated owner state on the HTTPS address. A read-only preflight confirmed the 0.5.0 contracts:
- settings v4, start mode Start, at most 6 running threads, autoMerge off;
- the sandbox test command contains `TZ=UTC` and `SANDBOX_DATA_DIR`;
- no open sandbox threads, and no endpoint account.

Receipts are in [live/](live/). Every changed setting was restored and is listed in its receipt.

| Id | Result | Evidence |
| --- | --- | --- |
| LP1 Chat and cards | **Failed** | The owner message was sent through the composer at 00:08:28. No card appeared within 3 minutes: the sandbox coordinator never started a turn (see below). Ready for review and the test-command question were not run. |
| LP2 Propose mode | Blocked | Needs a coordinator turn; not sent. |
| LP3 Settings from chat | Blocked | Needs a coordinator turn; not sent. |
| LP4 Automatic fixes | Blocked | Needs LP1's pull requests and coordinator turns. |
| LP5 Limits | **Blocked / failed** | First check blocked: the other Claude account, Ekoa, was over its weekly ceiling (91% against 90) and so not eligible. Second check, rerun alone with both Claude ceilings at 1: Jev placed the automatic-model task directly on Codex (gpt-6-astra, reason `start`) with no wait and no "Moved from…" notice, so the required transition was not observed. That task opened [sandbox #21](https://github.com/gongiskhan/jevellan-live-sandbox/pull/21), whose checks pass. Ceilings were restored to 90 and re-read. |
| LP6 Library | **Passed** | A PNG uploaded through the Overview Library, then attached to a message to a thread fixed to the Pro (Claude Fable). The report described it exactly (400×200, left half red, right half blue). The attached file is mirrored on the Pro with mode 400 and the same SHA-256. |
| LP7 Notifications | Not run | The one automated context tried, installed Chrome headless on dev-madrid, could not subscribe to the real push service: "Registration failed - permission denied". The physical iPhone check is the owner's. |
| LP8 Compatible endpoint | Blocked | No endpoint account exists in Settings; no credential was given. |
| LP9 First run | Blocked | Suggest setup is answered by a coordinator turn. |
| LP10 Two devices | Blocked | Needs a coordinator turn. |

**The coordinator stall (live, 0.5.0, unexplained).** After LP1's owner message at 00:08:28, the state point entered its lifecycle activity "Interpreting a project request" for that event at about 00:08:31. It was still there at 00:51.
- Before that step, the turn's memory context returned: the activity is entered only after it.
- No outcome file was written. On 0.4.1 such files appeared within seconds.
- No `coordinator-turn-start` followed.
- The Jev request in that step is bounded (two attempts of 4 seconds), so the wait sits elsewhere in it, in settings, configuration or credential retrieval. Which one was not identified without intrusive debugging.
- Meanwhile Jev answered placement decisions normally (LP5, LP6), ekoa-code's coordinator ran turns, and doctor reported Jev reachable.
- One owner-UI Fresh session at 00:35:34 did not clear it. There was no daemon restart, hot patch or internal write.
- ekoa-code's nightly window ran heavy Codex work on Madrid from 00:00. A causal link is not established.

Other live notes:
- The harness was stopped twice by this run, each time its own process group verified by PID, parent and start time:
  - after LP1's failure was established, so later journeys would not queue behind the stall;
  - during LP5's first attempt, once its precondition had failed, so the shared ceilings could be restored at once.
- Thread `thread_01M58SA1R0VMBK3JSMYH06E9KG` ("Add a README line about Node 22", Gmail) started after the ceiling was restored. It now waits for the owner with a question, because the sandbox targets Node 20. It is left for the owner.
- No live journey changed ekoa-code. Its ceilings were lowered only during LP5, while it had no running work. Ekoa Codex was never changed.
