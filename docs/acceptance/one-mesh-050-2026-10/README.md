# One mesh, release 0.5.0 and live journeys, October 2026

Run log for the 18 October 2026 brief: release 0.5.0 with a gate that blocks only on new failures, make dev-madrid the only state point with HTTPS, put the Pro on 0.5.0 as an ordinary member, and run the parity journeys live on `jevellan-live-sandbox`. Times are UTC. Every result is labelled live, simulated or not run.

## Clocks

- Preflight started: 2026-10-18T09:27:58Z on dev-madrid, source `2e3f4fd19d05a85aed8e5736c8dd68bde84ceb3c` (0.4.1), clean, equal to `origin/main`.
- Build clock (phases 0 to 3): first commit `4b21ee84` at 2026-10-18T09:44:42Z; deadline 2026-10-18T18:44:42Z.
- Live clock: three hours from the moment both machines report 0.5.0 in `jevellan doctor`. Not started.

## Phase log

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 Preflight | Complete, 09:27–09:44 | Live; below |
| 1 Release gate | Not started | |
| 2 Release 0.5.0 | Not started | |
| 3 One mesh | Not started | |
| 4 Live journeys | Not started | |
| 5 Closing | Not started | |

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
