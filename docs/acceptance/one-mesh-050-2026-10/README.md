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
