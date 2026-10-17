# Phase6: push notifications

Source verification is complete with the blockers below. Providers, subscription-network registration and hub delivery in these tests are simulated; real browser service-worker push dispatch is driven through CDP. No installed release or physical-phone acceptance is claimed.

## Source

The hub stores push-subscriptions, project-notifications and optional per-subscription push-delivery-v1 receipts in its existing database. Stable event ids and canonical ledger replay retry member delivery after outages/restarts. Questions are read from durable hub decision items. Keys are generated on first use in the existing encrypted vault. The owner API uses existing login and authenticated member forwarding.

The sender enforces levels,30-second coordinator coalescing, encrypted VAPID delivery with TTL3600, high urgency for needs-you/failures,404/410 removal and retries after10/60/300seconds. Seven-day retention includes delivery receipts. Finished deliveries are skipped; new subscriptions receive no sent history. The worker validates project-push-v1, suppresses a focused visible target path and handles click navigation.

Settings → Notifications offers device subscription, test, turn-off and removal, with HTTPS/iPhone guidance. Project settings hides its enable-device hint when this browser is subscribed. Localhost remains a standard browser secure context for disposable tests; ordinary insecure HTTP needs the HTTPS address. All copy is in project-work-copy.ts/copy.ts.

## Verification so far

Simulated:129 affected backend cases pass across5files, including real Web Push encryption/VAPID headers against a fake push service, per-device retries and410 removal, coalescing, levels, keys, owner authentication, actual member relay/offline retry, ledger triggers and restart deduplication. Four worker cases exercise the compiled real handlers for push validation, focused suppression, existing-client click navigation and opening a client. This click evidence is simulated, not an OS notification click.

The strengthened browser journey passes in every layout. It grants notification permission, simulates only the external subscription service, uses the real service worker/CDP delivery/getNotifications, waits for the actual handler's waitUntil promise for focused suppression, checks settings and turns off. All four layouts pass in the first matrix, and all four pass again after the initial capture waits for its control to be enabled. Dedicated vision remains not run for the missing test credential; selected captures are inspected directly.

Two regressions failed before repair: flush returned before queued ledger notifications were drained; stripping Markdown removed underscores/code and the greater-than sign. Initial invalid assertions for an empty-request schema, a configured fixture project name and the exhaustive hub-operation table were corrected to the existing contracts. Raw diagnostics stay outside the checkout.

## Dependency facts

web-push3.6.7 is MPL-2.0, not MIT; its unmodified package license is retained. Primary reference: https://github.com/web-push-libs/web-push/tree/v3.6.7. The runtime dependency has no reported advisory in this audit. npm audit reports two high advisories on pre-existing MCP SDK1.30.1 and source-map-js1.2.1; both versions match the phase5 lock. No blanket audit fix is applied. These remain closing evidence, not a security-review pass.

No native agent home, installed hub, Ekoa repository/settings or independent Madrid hub was changed. Live Chrome push and the owner's iPhone check remain later gates.


Final source check: a real member lost-reply regression failed before the test-notification POST stopped advertising safe replay. The endpoint-derived subscription/save and id-derived removal stay retryable. Temporary counter/flush diagnostics were removed. Selected final captures from all four layouts are directly inspected. The8 final screenshots and8 dedicated vision receipts are retained; every vision receipt is not run for the missing credential. The recurring fixture cleanup warning remains recorded.


A shutdown regression also fails before repair: close sent both queued notifications instead of finishing only the in-flight send. The sender now keeps the remaining queue durable for restart. The producer regression additionally asserts retrying=true on an actual coordinator usage-limit receipt. Final affected checks pass against this last source change.


## Phase gate

Simulated:142/142 affected cases in6files pass. Final typecheck, lint, build and whitespace checks pass; the existing bundle-size warning remains. The normal history secret scan gates publication. PAR6 passes twice in every layout; the final8captures wait for the initial control to be ready. All8vision receipts are not run for the missing credential. Selected final captures from every layout are directly inspected. The browser fixture cleanup warning remains a closing concern.

Live Chrome delivery through a real push provider and a real OS notification click are not run at this source checkpoint. The owner's physical iPhone check is not claimed. The dependency audit's unchanged-package advisories remain recorded.
