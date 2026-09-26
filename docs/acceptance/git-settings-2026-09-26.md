# Git connection settings — 2026-09-26

The user reported a blocked project operation: `git ls-remote` exited 128 because the macOS HTTPS credential helper could not obtain credentials in the background (`-25308`, terminal prompts disabled). There was no Git configuration page in Jevellan.

## Change and design choice

Settings → Git now offers the machine's existing Git configuration or SSH for GitHub, plus a read-only connection check for a registered project on the selected device. Projects also links directly to Git settings. Authentication failures explain where to change the connection method and retry.

The preference is a versioned, revision-checked document in Jevellan's isolated home. SSH mode supplies a command-scoped GitHub URL rewrite for Jevellan's Git operations. It does not edit repository remotes, global Git configuration, SSH files or native credentials. It uses an existing SSH identity with noninteractive authentication and existing host verification. The UI does not collect GitHub tokens. This bounded choice addresses the reported failure using the SSH identity already available on this machine.

The pilot launcher now preserves HOME, USER, LANG and SSH_AUTH_SOCK when present so background Git can access the existing machine identity; runtime account homes remain isolated. The replacement was built from the published checkpoint plus this fix. Deferred phase-6 work was excluded.

## Evidence

- **Live:** a read-only SSH probe of the affected project succeeded before deployment. After deployment, the authenticated Settings UI saved SSH mode and checked `sequoias` successfully, displaying **Connected** with the effective GitHub SSH remote. No project operation was resumed by this verification. Read access is verified; push permission is not claimed.
- **Live:** activation verified the replacement process, health and served application, preserving all three accounts, authentication, all three projects and all four conversation ledgers. The existing pilot home and Tailscale address were retained.
- **Local:** workspace typecheck and lint passed. The Git preferences, authenticated settings API and Git policy suite passed **71 tests** in three files.
- **Local:** the exact isolated release passed typecheck, lint and production build. Its focused Git regression selection passed **5 tests**, with 17 unrelated tests filtered out.
- **Simulated authentication / real Git:** regressions cover revision conflicts, isolated persistence, unchanged native configuration and repository remotes, rejected credentials in remote URLs, actionable errors, read-only checks and the workspace fetch/snapshot path. The SSH fixture serves a real local Git remote without requiring a provider account.
- **Browser fixtures:** the exact release passed the connection-settings flow in **four layouts**: desktop and phone, each in light and dark themes. Save, reload persistence, successful connection and horizontal overflow were checked. The phone capture was visually inspected.
- **Local:** the worktree secret scan passed. The pre-push scan remains a required publication gate.

The first typecheck caught an incorrect projects data source, which was corrected before the passing checks. The first browser launch could not find a bundled Chromium binary; rerunning with the already-installed Chrome passed without installing a browser.

## Limits

No new provider/model call, publication or full application test matrix was run for this repair. The previous blocked conversation retains its historical error until the user retries it. HTTPS credential management and creation of new SSH keys remain the machine owner's existing setup; this change exposes the connection choice and verifies its availability to Jevellan. User acceptance is not claimed.
