# Madrid hub run, October 2026

Run log for moving Jevellan to a fresh hub on dev-madrid. Times are UTC on 2026-10-15.

## Timeline

| Phase | Start | End |
| --- | --- | --- |
| 0 Preflight | 05:35 | 05:40 |
| 1 Fresh hub | 05:40 | blocked at step 4 (Tailscale) |
| 2 Readiness bugs and suites | 06:00 | |

## Environment

- Checkout HEAD at start: `41d7a2b` (version 0.3.6, after `ef2c3cab`).
- node v22.23.2 (nvm; v20 is the shell default, so builds and the service use v22), npm 10.8.2, git 2.43.0 (merge-tree --write-tree available), claude 2.1.300, codex-cli 0.153.4, gh logged in as gongiskhan, tailscale 1.98.8, uv 0.11.28, bubblewrap read-only bind works.
- Disk 481 GB free on `$HOME`, 16 cores, 62 GB memory, load about 4. Linger already on.
- Old member: `~/.jevellan-member`, role member, version 0.3.6, hub `https://goncalos-macbook-pro.tail31efa.ts.net:9443` (health ok, 0.3.6).
- ekoa-code: `NIGHTLY_SCHEDULER` not set; 13 open pull requests including 208.

## Decisions

- The Pro hub had no shared GitHub token, only the ekoa-code project token; it seeds both the shared and the project token on the new hub.
- Phase 2's build installs as 0.3.7, not 0.3.5: the checkout was already 0.3.6.
- While Tailscale blocks the install, Phase 2 and the Phase 5 code and test drill go first; tests use the old member's toolchain path read-only.
- Disk allows the preset's six concurrent worktrees (481 GB free), so `maxRunningPerDevice` keeps the preset value.
- The session may not run `sudo`; Tailscale changes go to the Owner list instead.
- Vault layout: one working copy and branch (`main`), git root above the notes folders, commits scoped to the project folder; dreams and imports copy the whole working copy. No branch per project was needed.
- The vault remote is `<login of the shared GitHub token>/jevellan-vault` (override `JEVELLAN_VAULT_REMOTE`); the root commit is identical on every hub so two hubs share history.
- Restore and the Ekoa Code preset match goals, jobs and dailies by name; the memory dream daily is one per project under the shared request id.
- Restore runs on the hub only (`POST /api/projects/:id/vault-restore`); a member's add-project form does not offer it.
- Tests written before commit 41d7a2b (classified owner follow-ups, threads kept open) were updated to that behavior instead of reverting it.
- The owner terminal drops other terminals' integration variables (VTE, WezTerm, iTerm, VS Code); inherited `VTE_VERSION` broke exit status capture on Linux.

## Live results

- Seed read from the Pro hub (live, pass): Jev key, ekoa-code project GitHub token, Claude subscriptions Gmail and Ekoa (shared), Codex subscription Ekoa Codex (per-device auth.json present), workflowPull 208.
- Pro stood down over SSH (live, pass): launchctl disable and bootout; `dev.jevellan.daemon` no longer listed; Pro `/api/health` returns 502.
- Member uninstall (live, fail): service stopped and disabled, then Tailscale refused to remove the `:443` route. Tailscale's operator is already `ggomes`; the refusal comes from the `:8500` folder share, since tailscaled only lets a user who can run `sudo tailscale` write a serve configuration that contains a folder. Unit file, wrapper and route remain; `~/.jevellan-member` intact.
- Vault repository (live, pass): `gongiskhan/jevellan-vault` created private; the visibility list before and after differs only by that new private repository.
- Vault drill by hand (live, pass): two disposable vault homes against GitHub pushed, pulled and kept both versions of a note edited on both; the scratch folder was removed again; the token never entered the repository configuration.

## Owner list

- Run `sudo tailscale serve --https=8500 off` on dev-madrid. Tailscale refuses every route change by a non-root user while any route serves a folder, and `:8500` serves `~/Documents/Codex/2026-09-03/so-i-used-to-play-this`. Re-add it afterwards, if wanted, with `sudo tailscale serve --bg --https=8500 /home/ggomes/Documents/Codex/2026-09-03/so-i-used-to-play-this` (that again blocks later Jevellan route changes).

## Open problems

- The old member is half uninstalled until the `:8500` folder share is removed; the hub install, Phase 1 from step 4, and Phases 3 and 4 wait on it.
