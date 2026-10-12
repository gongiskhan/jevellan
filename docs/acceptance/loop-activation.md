# Projects loop activation handoff

This handoff describes the remaining live work. It does not claim activation or owner acceptance. The implementation follows BRIEF-loop-amendment-2.md, and the evidence is in loop-2026-10-11.md and REPORT.md.

## Remaining owner steps, in order

1. Complete the hidden-passphrase Mini export and Pro import. Retain the pilot backup and original Mini app files/URLs; never put the passphrase in chat.
2. Complete imported Codex sign-in in Jevellan UI on the Pro, and provide eligible isolated Claude/Codex accounts for the real cross-provider journeys.
3. Enter sandbox and Ekoa GitHub tokens in project Settings and the Ekoa bearer token in Ekoa Settings. Ekoa GitHub permissions: Contents, Pull requests and Actions read/write; Checks, Commit statuses and Variables read.
4. After the 0.2.1 release gates pass, activate its verified Mac archive on the Pro with the retained rollback; complete the readiness, HTTPS and migration checks. The current live AC setting is sleep=0, so no power command is needed (2026-10-12 read-only pmset check).
5. Complete the isolated Madrid join/sign-in using its Linux 0.2.1 archive and dedicated Ekoa clone. Keep Mini apps-only; configure Pro/Madrid limits 6/8 and project limit 12.
6. Apply the Ekoa preset with autoMerge off, requiredChecks [result], six goals/two active/Propose tasks and the 01:00 Lisbon window. Complete the sandbox owner decision/draft approval needed for real LJ9; its Ekoa PR records a shadow route.
7. Review and merge Ekoa PR 208. Merging preserves the GitHub chain while NIGHTLY_SCHEDULER is unset/github. No runner hook reinstall is needed.
8. Keep Ekoa in watch mode for two clean nights after merge, then set NIGHTLY_SCHEDULER=jevellan yourself. Setting it back to github restores the GitHub chain from the next night.
9. Enable Ekoa automatic merging yourself when ready; confirm live activation separately from automated evidence. Credentials and missing owner actions remain blocked checks.

## Owner input checkpoint

The prepared Mini export and Pro import terminals are waiting for hidden passphrase input. Enter the same migration passphrase in those terminals, never in chat or command arguments. The Mini must be stopped before export; its original app files, URLs and recoverable pilot backup are retained. Do not initialize an empty Pro hub over the pending import.

After import, complete the imported Codex account sign-in in Jevellan Settings on the Pro. Enter the sandbox and Ekoa GitHub tokens in their project-scoped Settings pages and the Ekoa OAuth bearer token in Ekoa Settings. The Ekoa GitHub token needs Contents, Pull requests and Actions read/write; Checks, Commit statuses and Variables read. Ekoa MCP capability/authentication testing must pass before live mirroring; expired or unsupported authentication remains a blocker.

## Release and devices

After the clean closing gates and import receipt are present, update the existing Pro installation using `jevellan update --from <verified 0.2.1 archive>`. The user LaunchAgent and HTTPS route are retained; verify the returned version and readiness before proceeding. `jevellan rollback` retains the preceding application. Application rollback does not undo an imported hub or erase its data; use the migration's recorded rollback procedure for that boundary.

Packed archives contain native dependencies for the build platform. Use the verified Mac archive on the Pro; prepare the Madrid distribution on Madrid from its dedicated Jevellan source copy so the Linux terminal addon is built and included. Do not use a Mac-only archive for a Linux join.

Join the Mini to the Pro as apps-only, retaining its original static-app files and routes. Confirm that it cannot become eligible through tags or fixed-device requests. Join dev-madrid with its dedicated clone and isolated Codex sign-in, preserving its owner checkout and native home. Configure Ekoa allowed devices as Pro and dev-madrid, limits 6 and 8, project limit 12. The Mini has no working allowance.

Apply the owner-only Ekoa preset through the authenticated setup operation after its repository, scoped token and account models are available. Check the six goals, two active goals, Propose tasks, exact thread rules and risky areas, worktree isolation, fast checks and 01:00 Europe/Lisbon Nightly window. Run the live sandbox Claude and Codex journeys and LJ9, recording actual routes, commits, workflow run IDs and mirror IDs in sanitized evidence.

## Ekoa workflow handoff

[Ekoa PR #208](https://github.com/gongiskhan/ekoa-code/pull/208) is for the owner to merge and always routes to ask-owner. Ekoa starts in watch mode and watches the real GitHub chain while NIGHTLY_SCHEDULER is unset or github, including after PR merge. No runner hook reinstall is needed: Ekoa dispatch uses main and the existing hook already permits these workflows. After owner merge and two clean watch nights, the owner may set NIGHTLY_SCHEDULER=jevellan. Jevellan never sets this variable. Jevellan then dispatches Legal, Full suite and Deploy, with Deploy carrying that window's passing suite commit as its sha input. A skipped test suite is not a pass. Security remains disabled and parked.

Complete live rollback, retained Mini URL, membership, resource-heartbeat, scoped credential, native provider, GitHub gate, mirror and Nightly checks before reporting activation. Missing inputs remain blocked checks. Automated evidence never substitutes for the owner's acceptance.
