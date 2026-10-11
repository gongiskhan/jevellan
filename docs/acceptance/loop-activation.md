# Projects loop activation handoff

This handoff describes the remaining live work. It does not claim activation or owner acceptance. The implementation follows BRIEF-loop-amendment-1.md, and the evidence is in loop-2026-10-11.md and REPORT.md.

## Owner input checkpoint

The prepared Mini export and Pro import terminals are waiting for hidden passphrase input. Enter the same migration passphrase in those terminals, never in chat or command arguments. The Mini must be stopped before export; its original app files, URLs and recoverable pilot backup are retained. Do not initialize an empty Pro hub over the pending import.

After import, complete the imported Codex account sign-in in Jevellan Settings on the Pro. Enter the sandbox and Ekoa GitHub tokens in their project-scoped Settings pages and the Ekoa OAuth bearer token in Ekoa Settings. The Ekoa GitHub token needs Actions and Contents read/write. Ekoa MCP capability/authentication testing must pass before live mirroring; expired or unsupported authentication remains a blocker.

## Release and devices

After the clean closing gates and import receipt are present, update the existing Pro installation using `jevellan update --from <verified 0.2.0 archive>`. The user LaunchAgent and HTTPS route are retained; verify the returned version and readiness before proceeding. `jevellan rollback` retains the preceding application. Application rollback does not undo an imported hub or erase its data; use the migration's recorded rollback procedure for that boundary.

Packed archives contain native dependencies for the build platform. Use the verified Mac archive on the Pro; prepare the Madrid distribution on Madrid from its dedicated Jevellan source copy so the Linux terminal addon is built and included. Do not use a Mac-only archive for a Linux join.

Join the Mini to the Pro as apps-only, retaining its original static-app files and routes. Confirm that it cannot become eligible through tags or fixed-device requests. Join dev-madrid with its dedicated clone and isolated Codex sign-in, preserving its owner checkout and native home. Configure Ekoa allowed devices as Pro and dev-madrid, limits 6 and 8, project limit 12. The Mini has no working allowance.

Apply the owner-only Ekoa preset through the authenticated setup operation after its repository, scoped token and account models are available. Check the six goals, two active goals, Propose tasks, exact thread rules and risky areas, worktree isolation, fast checks and 01:00 Europe/Lisbon Nightly window. Run the live sandbox Claude and Codex journeys and LJ9, recording actual routes, commits, workflow run IDs and mirror IDs in sanitized evidence.

## Ekoa workflow handoff

[Ekoa PR #208](https://github.com/gongiskhan/ekoa-code/pull/208) is for the owner to merge and always routes to ask-owner. Until it merges, Nightly watches the current GitHub order. After it merges, the owner installs the changed root-owned runner hook before pinned dispatch can run. Jevellan then dispatches Legal, Full suite and Deploy, with Deploy pinned to that window's passing suite commit. A skipped test suite is not a pass. Security remains disabled and parked.

Complete live rollback, retained Mini URL, membership, resource-heartbeat, scoped credential, native provider, GitHub gate, mirror and Nightly checks before reporting activation. Missing inputs remain blocked checks. Automated evidence never substitutes for the owner's acceptance.
