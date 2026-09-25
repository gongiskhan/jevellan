# Phase 1 Settings UI evidence

The browser matrix passes at 1440×900 and 390×844 in light and dark themes. Each case uses its own disposable Jevellan home and daemon. HTTP, SQLite encryption and APM are real; provider readiness and authorization-code acceptance are simulated. No native account or test-provider credential is used by this matrix.

Each workflow signs in, adds an API-key account with an explicit paid-use policy, completes a subscription login panel, creates and edits a local skill, checks its rendered preview, confirms Safety cannot be disabled, and previews/applies a configuration import. It checks horizontal overflow, mobile navigation, the standalone web-app manifest and absence of private API entries in the service-worker cache. JavaScript page errors fail the workflow. Metadata changes and stale revisions have separate HTTP integration tests.

| Screen | Desktop light | Desktop dark | Phone light | Phone dark |
| --- | --- | --- | --- | --- |
| Runtimes | [Image](screenshots/phase1-runtimes-desktop-light.png) | [Image](screenshots/phase1-runtimes-desktop-dark.png) | [Image](screenshots/phase1-runtimes-phone-light.png) | [Image](screenshots/phase1-runtimes-phone-dark.png) |
| Rigging | [Image](screenshots/phase1-rigging-desktop-light.png) | [Image](screenshots/phase1-rigging-desktop-dark.png) | [Image](screenshots/phase1-rigging-phone-light.png) | [Image](screenshots/phase1-rigging-phone-dark.png) |

The images contain only fixture labels and masked suffixes. Desktop/light and phone/dark Runtimes, plus desktop/dark and phone/light Rigging, were inspected for clipping and legibility. This does not replace the specified Claude SDK vision checks, which remain blocked by ENV-CLAUDE, or Gonçalo's acceptance. Native installation onto a phone home screen has not been tested.

Two initial workflow attempts stopped on overly strict label-text locators for a select and an already-populated textarea. Their accessible roles and names were present; the tests were corrected to select those controls by role. The subsequent full matrix passed, followed by another passing matrix with manifest/cache checks.

The conversation screen is still a shell. Projects, memory, full loose/parked Rigging management, live Jev decisions, remote device login/switching and Improver pages belong to the remaining phases and are not claimed as completed here.


## Dedicated Codex account through the UI

**Live Codex readiness with simulated browser approval.** scripts/spikes/live-settings.mjs added a Codex subscription account through the real browser, temporarily moved the prepared dedicated login into its disposable account home, then used the real account probe and model discovery. The UI showed Ready, models were discovered, and a local skill added through Rigging appeared in that account home. The whole login home was restored to its source after account operations drained. Native browser approval was simulated; it is not claimed as tested.

[Ready account screenshot](screenshots/phase1-live-codex-ready.png) was inspected for clipping and legibility. The login panel was closed before capture so no provider identity is displayed.

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/spikes/live-settings.mjs --root "$HOME/.jevellan-build/live-home" --account acc_test
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

The four viewport/theme workflows passed again with installed Chrome. A prior attempt could not launch the absent Playwright browser; selecting the installed browser resolved it without installation.
