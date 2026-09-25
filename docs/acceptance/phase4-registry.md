# Device registry components — 2026-09-24

**Phase 4 in progress. Actual SQLite, encrypted vault and temporary files; simulated devices and clock. No member daemon, cross-device UI, remote provider login or J8/J11 mesh pass is claimed.**

The hub registry now issues eight-character join codes valid for ten minutes. Registration atomically creates a member, its encrypted device token and the consumed-code receipt. An identical retry during the code's lifetime returns the same credential; a changed request cannot consume it again or replace an existing device identity. Codes and switch tokens are represented by hashes in documents. Device bearer credentials remain encrypted in the vault. Revocation retains device history while removing its token and refusing authentication, old join retries and outstanding switches.

Heartbeat records bind to the authenticated device identity passed by the future HTTP layer. Metadata and the hub's receipt timestamp commit together. Presence uses receipt time rather than the device's clock: online below ninety seconds, stale below ten minutes, offline afterwards. Missing, invalid or future receipt timestamps do not imply online. Running conversations and external-session metadata remain in the last report when it becomes stale; a later empty report replaces them.

Switch grants preserve a validated local route and target device, expire at sixty seconds, and can be consumed once. A request to the wrong target does not consume the grant. Offline targets cannot receive a new grant, and revoked sources or targets cannot complete it. Origins preserve scheme and port, normalize path/query/fragment away, and reject embedded credentials. HTTPS is supported, along with HTTP on loopback and Tailscale IPv4 for the daemon's direct listeners and local fixtures.

The hub document store now supports synchronous transactions with nested savepoints. This groups document and vault writes without partial joins or heartbeat receipts. Configuration's existing revision transaction remains separate; the new grouping method is not an asynchronous network transaction.

## Verification

- The initial registry/core/authentication run passed **33 checks in three files in 3.49 seconds**.
- A lint check found the control-character regular expression. It was replaced by explicit character-code validation, with NUL and DEL added to the route regression.
- Final typecheck, lint and production build passed. The affected registry, core, UI authentication, checkout ownership, Settings HTTP and account-service run passed **65 checks in six files in 6.77 seconds**. It used isolated homes, temporary repositories and local HTTP; existing APM delivery was exercised without installing dependencies.
- Registry cases cover durable identical retries, different requests, exact expiry, existing identities, malformed versions, injected database failures, two hub database connections, nested rollback, revocation, heartbeat identity and atomicity, freshness boundaries, switch restart/single use/expiry/target, and local route/origin handling.

Read-only reference: Garrison's `src/lib/mesh/staleness.ts` and the applicable `tests/mesh-self.test.ts` cases supply missing timestamp and freshness-precedence regressions, adapted to the brief's thresholds. `src/lib/node-switch.ts` and `tests/node-switch.test.ts` supply route preservation, origin normalization and scheme/port distinctions. No historical node vocabulary, terminal behavior or runtime imports were ported. Join atomicity and one-time switch requirements come from BRIEF.md §14.

## Remaining integration

The subsequent [HTTP and registration checkpoint](phase4-http.md) exposes the registry through bearer-authenticated HTTP, adds shared UI signing material and mode-0600 member authentication files, and checks the device identity at that boundary. Member application construction and execution remain unfinished; members must use the hub API and cannot open its SQLite database.

The synchronous local document store is not an offline hub authority. Account/configuration access, credential fetch, ownership, publication and indexes need explicit remote boundaries and outage behavior. Next work also includes heartbeat scheduling, the aggregate conversation list, owner HTTP/SSE proxying, remote per-device login, Devices/header switching, native session metadata and two isolated-daemon acceptance journeys.
