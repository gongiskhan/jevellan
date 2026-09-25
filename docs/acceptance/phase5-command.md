# Phase 5 — Installed command

Status: component verification and the fresh packed check passed. The completed phase-5 browser and installation results are consolidated in [J9](J9.md).

Installation writes an executable `jevellan` launcher under the user's home. It uses `~/.local/bin` or `~/bin` when either is already on PATH; otherwise it uses `~/.local/bin` and prints the full command path. The installer never changes shell profiles or creates commands in system/package-manager directories. If another executable takes precedence on PATH, it reports the full path instead of claiming that the bare command is ready.

The launcher binds `JEVELLAN_HOME`, the recorded Node executable and the installed version's CLI. Arguments are forwarded unchanged. Update leaves the current command in place while work is running, then switches it with the application; rollback restores the preceding version's command. The launcher does not read files from the development checkout or an `npx` cache.

The versioned installation manifest records the exact command definition, content digest, pending write and created directories. Writes are atomic, and a lost receipt can recover without replacing a completed file. An existing file, link or aliased parent is preserved. Missing owned commands can be repaired without restarting a healthy service; an edited command refuses update or removal before stopping that service. Uninstall removes the listed command, retaining unrelated files and pre-existing directories. Purge requires external command removal before renaming the data home.

## Verification

- **53 tests in four suites passed in 19.77 seconds**, covering installation, file ownership, distribution and diagnostics. New cases execute the launcher with spaces, quotes, dollar signs and backticks in paths; forward literal arguments; select and retain a user bin folder; detect a shadowing executable; recover lost write/removal receipts; preserve existing files and links; and preserve a destination claimed after preparation.
- The installer tests execute the same command before update, while update waits, after update and after rollback. They verify missing-command repair without service restart and refusal to stop a service when its command was edited externally.
- Typecheck, lint and production build passed. Native service calls remain replaced by the injected fake manager; fixture homes and child processes are disposable. The earlier complete-suite counts remain historical.
- The fresh packed check passed. It invoked `jevellan --version` by its PATH name with no Node executable on PATH, ran actual installed diagnostics through the launcher, checked both local devices, and followed the command through update, rollback and removal. Doctor reported eight OK checks and correctly marked Accounts/Jev as missing. Receipt: `/private/tmp/jevellan-install-commands-WALJcu/result.json` (`installation-command-check-v5`); log: `/private/tmp/jevellan-command-packed.log`. All owned daemon/listener processes exited, both disposable homes were purged and native-home/profile/Garrison fixtures were unchanged. Package preparation, dependency downloads, child processes and HTTP were real; the second device, activity lock and newer release were simulated. No native service was invoked.
- Worktree secret scanning and whitespace checks passed.

Optional HTTPS is covered by [HTTPS evidence](phase5-https.md). The complete first-run browser walkthrough and combined J9 running-conversation update journey remain unfinished. This checkpoint does not establish successful live Jev classification, a physical second device or user acceptance.
