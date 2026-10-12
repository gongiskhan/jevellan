# Projects loop activation handoff

## Remaining owner steps, in order

1. Retry the corrected hidden-passphrase [Pro import](/Users/ggomes/.jevellan-build/loop-owner-2026-10-11/2-Pro-import.command) with the same migration passphrase. The Mini export is complete and its copied archive is verified; do not repeat it. The first Pro attempt preserved its data and refused background records from its initial daemon. The retry saves the entire original Pro home as a backup and creates a fresh destination without starting its daemon. Failed attempts restore that backup. Retain the pilot backup and original Mini app files/URLs; never put the passphrase in chat. [Recovery evidence](hub-import-recovery-2026-10-12.md) separates the completed export from the pending retry.
2. After import, activate the verified 0.2.1 Mac archive on the Pro with the retained rollback; complete the readiness, HTTPS and migration checks before using its new Settings pages. The live AC setting is sleep=0, so no power command is needed (2026-10-12 read-only pmset checks). Settings → Devices warns if a hub's AC configuration allows sleep; Jevellan never changes power settings.
3. Complete imported Codex sign-in in Jevellan UI on the Pro, and provide eligible isolated Claude/Codex accounts for the real cross-provider journeys.
4. Enter sandbox and Ekoa GitHub tokens in project Settings and the Ekoa bearer token in Ekoa Settings. Ekoa GitHub permissions: Contents, Pull requests and Actions read/write; Checks, Commit statuses and Variables read.
5. Join the Mini to the Pro as apps-only and verify its retained app URLs, files and former-hub fence. Complete the isolated Madrid join/sign-in using its Linux 0.2.1 archive and dedicated Ekoa clone; configure Pro/Madrid limits 6/8 and project limit 12. The Mini remains excluded from project work, including fixed-device requests.
6. With isolated accounts and scoped tokens ready, complete the live sandbox gate journeys with autoMerge on: merge; other-provider verification pass; other-provider verification failure delivered to the author, followed by repair and a passing verification; ask-owner. Record actual routes/reasons and head commits. Their own sandbox PRs may merge. These are blocked until steps 1–4 are ready.
7. Apply the Ekoa preset with autoMerge off, requiredChecks [result], six goals/two active/Propose tasks and the 01:00 Lisbon window. Approve one real proposed finding for LJ9; its real Ekoa PR must end with a recorded shadow route. Automatic merge remains your choice.
8. Review and merge Ekoa PR 208. Merging preserves the GitHub chain while NIGHTLY_SCHEDULER is unset/github. No runner hook reinstall is needed. It remains open and mergeable at the 2026-10-12 checkpoint.
9. Keep Ekoa in watch mode for two clean nights after merge, then set NIGHTLY_SCHEDULER=jevellan yourself. Setting it back to github restores the GitHub chain from the next night.
10. Enable Ekoa automatic merging yourself when ready; confirm live activation separately from automated evidence. Credentials and missing owner actions remain blocked checks.

This handoff does not claim activation or owner acceptance. Parts 1–3 are pushed (Ekoa 30dffb6c; Jevellan f916302/f11b6cd). The final complete backend passes 1,902 tests in 171 files; all 272 unique browser cases have passing coverage through the full run and targeted reruns, with 488 clear live vision judgments and retained screenshots. Typecheck, lint, build and the final review correction pass. The permitted second review found no additional serious issue. Both platform archives pass actual packaged command, terminal addon and private-path inspection checks; final documented payload checks and mandatory secret scans gate publication. Live owner inputs remain blocked. [Release 0.2.1](https://github.com/gongiskhan/jevellan/releases/tag/v0.2.1) is the activation target. Evidence is in REPORT.md. The [hosted-minute report](github-hosted-minutes-2026-10-12.md) records 19,469.68 observed hosted minutes, including 33.72 on macos-15, for the specified fourteen-day interval. No unrelated CI changed.

## Owner input checkpoint

The Mini export is complete; its encrypted archive has the same checksum on both Macs and its former-hub fence is present. The corrected Pro retry terminal awaits the same hidden migration passphrase, which was deliberately not saved. Enter it there, never in chat or command arguments. The retry retains the entire original Pro home and restores it if import fails. The original Mini app files and recoverable pilot backup remain retained; app URL and membership checks remain pending. Do not start the fresh destination daemon before import.

After import, complete the imported Codex account sign-in in Jevellan Settings on the Pro. Enter the sandbox and Ekoa GitHub tokens in their project-scoped Settings pages and the Ekoa OAuth bearer token in Ekoa Settings. The Ekoa GitHub token needs Contents, Pull requests and Actions read/write; Checks, Commit statuses and Variables read. Ekoa MCP capability/authentication testing must pass before live mirroring; expired or unsupported authentication remains a blocker.

## Release and devices

After the clean closing gates and import receipt are present, update the existing Pro installation using the verified Mac archive:

```sh
PATH="/Users/ggomes/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/opt/git/bin:$PATH" /Users/ggomes/.local/bin/jevellan update --from /Users/ggomes/.jevellan-build/loop-owner-2026-10-11/jevellan-0.2.1-darwin-arm64.tgz
```

This selects Node22 and Homebrew Git2.55. Apple Git2.39.5 lacks the required merge-tree capabilities; the installer checks these capabilities before changing a service. The user LaunchAgent and HTTPS route are retained; verify the returned version and readiness before proceeding. `jevellan rollback` retains the preceding application. Application rollback does not undo an imported hub or erase its data; use the migration's recorded rollback procedure for that boundary.

Packed archives contain native dependencies for the build platform. Use the verified Mac archive on the Pro; prepare the Madrid distribution on Madrid from its dedicated Jevellan source copy so the Linux terminal addon is built and included. Do not use a Mac-only archive for a Linux join.

Join the Mini to the Pro as apps-only, retaining its original static-app files and routes. Confirm that it cannot become eligible through tags or fixed-device requests. Join dev-madrid with its dedicated clone and isolated Codex sign-in, preserving its owner checkout and native home. Configure Ekoa allowed devices as Pro and dev-madrid, limits 6 and 8, project limit 12. The Mini has no working allowance.

Apply the owner-only Ekoa preset through the authenticated setup operation after its repository, scoped token and account models are available. Check the six goals, two active goals, Propose tasks, exact thread rules and risky areas, worktree isolation, fast checks and 01:00 Europe/Lisbon Nightly window. Run the live sandbox Claude and Codex journeys and LJ9, recording actual routes, commits, workflow run IDs and mirror IDs in sanitized evidence.

## Ekoa workflow handoff

[Ekoa PR #208](https://github.com/gongiskhan/ekoa-code/pull/208) is for the owner to merge and always routes to ask-owner. Ekoa starts in watch mode and watches the real GitHub chain while NIGHTLY_SCHEDULER is unset or github, including after PR merge. No runner hook reinstall is needed: Ekoa dispatch uses main and the existing hook already permits these workflows. After owner merge and two clean watch nights, the owner may set NIGHTLY_SCHEDULER=jevellan. Jevellan never sets this variable. At window open Jevellan reads the variable; a failed read stays in watch mode. Nightly shows who runs the night. Jevellan then dispatches Legal, Full suite and Deploy on main, with Deploy carrying that window's passing suite commit as its sha input. A skipped test suite is not a pass. Security remains disabled and parked.

Complete live rollback, retained Mini URL, membership, resource-heartbeat, scoped credential, native provider, GitHub gate, mirror and Nightly checks before reporting activation. Missing inputs remain blocked checks. Automated evidence never substitutes for the owner's acceptance.
