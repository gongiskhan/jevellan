# Phase 8: compatible endpoints

Source and affected verification are complete, with the blocked checks below. No installed service, owner project or native agent home has changed.

## Source behavior

Account-v1 reads as account-v2 while preserving its values. Compatible endpoints use the Claude runtime, shared vault credentials, declared model ids and an explicit billing policy. An ordinary account never claims an endpoint model. Metered accounts use the existing paid-use rule; free and plan accounts rank with subscriptions and unknown usage. Known local endpoint availability is kept per device, while an unprobed device can use the shared credential observation. Native shared logins retain their existing behavior.

Saving an endpoint adds source-tagged menu choices. Native discovery preserves them; disabling or removing their source disables them with the prescribed reason. The menu limit is19 enabled choices, retaining at most200 saved definitions. Disabled definitions stay available in Settings and history, rather than being deleted to free capacity. This is Decision892's explicit refinement of the earlier19-total-row bound; project allowed-model lists still cap at19.

The existing launcher delivers only the endpoint URL, auth token, three background aliases and the nonessential-traffic switch for this account kind. Normal accounts keep their existing auth allow-list. Secret values remain vault-only and are registered with the redactor on each resolution. Endpoint discovery uses the declared models; its bounded Messages probe makes one request and reports Ready, Key refused or Unreachable, with no usage windows.

The account form supports billing, models, efforts, descriptions and an optional background model. The new browser journey follows a task from its automatically chosen endpoint model/account into Why, and exercises real HTTP probe responses from the fake provider. Model behavior and Jev choices in that fixture are simulated.

## Verification

- Simulated:191 affected backend cases pass across14files; four dedicated Jev decision-selection checks are skipped for the missing test key, not passes. The batch includes normal project admission/placement on the endpoint, mesh credential delivery, native-account compatibility, strict schemas, menu limits, source disabling, probes and launch environment.
- Simulated: the real Agent SDK and its bundled CLI complete one turn against a fake Messages server. The macOS network guard permits only the fixture's loopback port, the proxy records no outside destination, and both fixture native homes remain byte-identical. `cli-contract.json` is the structured receipt. Linux uses a connect trace when available and records not run without its tracer.
- Live, local inspection only: `cli-capabilities.json` binds the actual SDK CLI2.1.281 by hash, confirms its effort flag and all six environment names, and records the official documentation references. The check uses a disposable home with networking denied. The separate global CLI2.1.19 is unchanged.
- Simulated: typecheck, lint and production build pass. The final typecheck and lint are repeated after the last fixture changes.
- Simulated browser: PAR8 passes all four layouts with32 screenshots and no HTTP headers-sent crash. verification.json records each exit status.
- Not run: dedicated vision lacks its test credential. Direct screenshot inspection is separate.
- Blocked: optional real-provider LP8 needs an endpoint credential entered in Settings after installation. It was requested once; no credential is collected in chat. Source is not installed and the live clock is unstarted.

The final backend command names `endpoint-accounts`, `endpoint-menu-cap`, `endpoint-cli-contract`, `accounts`, `account-service`, `mesh-accounts`, `core`, `ui-account-availability`, `decision-selection`, `projects-placement`, `projects-placement-app`, `runtime-adapters`, `runtime-contracts` and `native-setup` test files. Its private log is `/private/tmp/jevellan-parity-p8-complete-backend.log`.

## Failed-before and unsuccessful attempts

- `/private/tmp/jevellan-parity-p8-before.log`: all10 initial endpoint cases fail on the old account schema/behavior.
- `/private/tmp/jevellan-parity-p8-device-status-before.log`: a remote Ready observation incorrectly overrides a known local endpoint outage. Decision890 repairs it without changing native saved-login behavior.
- `/private/tmp/jevellan-parity-p8-first-browser-selected.log`: Background model's help is part of its accessible name. Decision891 links the help separately; the exact label assertion and deadline stay.
- `/private/tmp/jevellan-parity-p8-disabled-slot-preserved-before.log`: disabling a choice still leaves the old total-row cap full. The corrected test preserves the disabled definition as well as every enabled choice; Decision892 changes the active-choice bound.

Initial test setup selected the obsolete global CLI, whose lack of --effort is not a failure of the engine Jevellan uses. The first network profile used an unsupported numeric-host spelling; the supported localhost spelling then passed. One anchored browser grep selected no tests and is not run. A new placement fixture initially omitted its Jev key, correctly producing fallback; it now supplies a scripted Jev transport and keeps the no-fallback assertion. After the cap changed, its overflow fixture still had disabled seed choices; it now explicitly enables19 choices before testing the refusal. No product assertion, timeout or no-fallback requirement is waived.

Decisions888–892 are in the run log. Full suites, the known fixture-startup/cleanup findings, release installation and LP1–LP9 remain closing gates. No provider or owner acceptance is claimed here.

The initial full PAR8 selector matched both the chat and Overview cards; it now scopes the same assertion to the chat, as the other card journeys do. A later attempt stopped in workspace bootstrap before reaching the form (accounts read pending); its private trace and `/private/tmp/jevellan-parity-p8-bootstrap-loading-attempt.log` remain unsuccessful evidence. The unchanged deadline is retained for the quiet rerun.

The next attempt reached the completed endpoint task but did not expand Session information before opening Why. The final journey uses that existing control, retaining the same Why/account/model checks. The task had run correctly; this attempt is not a browser pass.
