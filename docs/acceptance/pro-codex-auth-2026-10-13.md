# Pro Codex and Git authentication checkpoint

Evidence: live, 13 October 2026. Source/runtime remains 0.3.1. No real acceptance scenario or ten-hour clock started; owner acceptance is not claimed.

The owner selected goncalo@ekoa.io. OpenAI's ordinary device-sign-in consent names that identity, the normal device code completes, and its callback says Signed in to Codex. Jevellan shows the existing account Ready, with a fresh weekly reading of 1%; the five-hour value is unknown, not zero. The account is labelled Ekoa Codex, with its existing ID and 90% ceiling retained. Madrid has no completed Codex login yet. No password, device code, OAuth callback query or native identifier is recorded here.

GitHub browser confirmation reaches token settings. The default, sandbox and Ekoa vault scope views each say Not set. The GitHub account has no fine-grained tokens and only an expired classic token. The repository-only draft is not generated: the picker has no Checks permission. GitHub's [token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations) explicitly say fine-grained PATs cannot call the Checks API; the [Checks REST reference](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28) nevertheless includes those token types. Preserve this inconsistency as observed, with no claim of live API success. A classic-token draft with repo + workflow and thirty-day expiry is prepared, and its broader access is awaiting the specific owner approval. Generate token has not been pressed. If approved, the recipient is Jevellan's encrypted project-scoped sandbox and Ekoa vault entries, with the default left unset. No grant or token is inferred from the completed browser authentication.

Jevellan's sandbox Git read check fails with publickey denied under the imported SSH preference. Switching only Jevellan's per-device choice to the machine configuration makes the same check Connected through the unchanged HTTPS origin. Native Git configuration, credentials and logins are read but not written. Push permission remains not run until publication.

Private screenshot paths, all outside Git:

- /Users/ggomes/.jevellan-build/loop-owner-2026-10-11/pro-codex-ekoa-ready-2026-10-13.jpg
- /Users/ggomes/.jevellan-build/loop-owner-2026-10-11/github-token-approval-2026-10-13.jpg
- /Users/ggomes/.jevellan-build/loop-owner-2026-10-11/pro-git-connected-2026-10-13.jpg

Blocked: new token grant/entry, member grants/join, retained Ekoa checkout decision, Ekoa MCP authentication, live gate/provider/mirror/phone scenarios. Not run: a new complete source test matrix or review; source and assertions do not change in this operational checkpoint. Documentation verification: whitespace, roadmap parsing, typecheck/lint and working-tree/history secret scans.


## Sandbox preparation and fixture correction

Decision 766: the real invoices/customers sandbox is published at 61fc71abcf86d4cd14a127bb47ff473fddece17b with sandbox-baseline; loop-pilot-baseline retains the original pilot. Only the sandbox NIGHTLY_SCHEDULER is set to jevellan. Its original Vitest 5 pin requires Node 22 and fails the new actual Node 20 install/run regression before the fix. Pin Vitest 4.1.11; ten affected harness/regression cases pass, including real engine-strict npm installation and generated-app execution on Node 20. The actual app passes lint, three unit tests and eight page cases in phone/desktop light/dark layouts. Dedicated vision credentials are unavailable, so those eight vision checks are blocked. The installed Pro daemon stays 0.3.1; the corrected harness runs from current main. No formal scenario/clock or new review started.

Run the reproducible Node 20 regression from the Jevellan checkout with JEVELLAN_TEST_NODE20 pointing to the installed Node 20 executable: `npx vitest run tests/live-sandbox-node20.test.ts tests/live-scenarios.test.ts --maxWorkers=1`. It installs only into a disposable test folder and removes that folder afterwards. This check downloads public package dependencies; it does not use provider credentials or native account homes. Failed-before evidence is the private 145-sandbox-node20-before.log; passing evidence is 146-sandbox-node20-after.log. Actual app logs are 148-sandbox-ci.log, 151-sandbox-lint.log, 152-sandbox-units.log and 153-sandbox-browser.log. Screenshots and retained browser diagnostics are under the private sandbox-browser-results folder. No new complete backend/browser source matrix or review was run for this fixture correction; all existing real acceptance assertions are retained.
