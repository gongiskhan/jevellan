# Hub HTTP, member sign-in and registration — 2026-09-24

**Actual local HTTP servers, SQLite transactions, scrypt/HMAC operations and private temporary files. Simulated member devices, credentials and failures. No live second machine, provider login or cross-device conversation acceptance is claimed.**

The real hub application now exposes versioned device endpoints for joining, roster/heartbeat, shared sign-in, revocation checks, invitations and switching. The browser and device boundaries are separate: device operations require a bearer token, while browser invitation/switch controls require the UI cookie. Explicit credential-exchange responses deliver only their validated protocol shape; normal Settings responses remain redacted. A device revoked while scrypt runs is checked again before its session is returned.

The member client validates response schemas and device identities, refuses redirects, bounds response bodies and applies a deadline through body completion. It distinguishes a hub outage from a malformed response. Shared signing material proves the local signature, but accepting a signed session still requires the hub's revocation check. Logout remains effective after reconstructing the member authentication object.

The hub's switch endpoint was exercised through HTTP: a member requested a grant for the hub, the browser exchange set a device-bound cookie, and HTTP 303 preserved the local Settings route without another passphrase. The reverse direction uses the actual member client to consume its grant and validate its new session. A reused grant fails. This is protocol evidence, not a second running product daemon.

`joinMember` now writes mode-0600 device/authentication files in an isolated home and keeps the retry identity without storing the join code. A deliberately lost HTTP response leaves a recoverable pending join; retry receives the same registration. A deterministic crash-state fixture removes the final files after the token was saved, and recovery obtains the remaining material through authenticated hub calls even with an invalid old code. It preserves the token and device identity. No hub database is opened or created in the member home. An active daemon home, unsafe authentication permissions or different pending settings are refused.

## Verification

- Initial protocol/core-registry/sign-in/Settings run: **35 passed in four files in 7.09 seconds**.
- A lint-only unused test import was removed. No runtime behavior changed for that correction.
- After member-file recovery was added: **38 passed in four files in 7.79 seconds**, including twelve HTTP/registration cases. The tests use real local listeners and isolated homes. The never-ending response test reaches the real HTTP timeout and cleans up its listener.
- Final typecheck, lint and production build passed.
- Existing Settings, account login, Rigging and configuration browser workflow: **four layouts passed in 34.6 seconds**, covering desktop/phone and light/dark with simulated providers. There were no page errors or horizontal overflow. Refreshed phone runtime and dark desktop Rigging captures were visually inspected. The separate Claude SDK vision check remains credential-blocked.

The existing read-only Tailscale progress report was not changed or restarted. No provider keys, native logins, dependencies or services were installed or modified. Temporary test servers were closed. Commit approval and GitHub authentication remain their previously recorded blockers; neither was retried unchanged.

## Still required

The member application constructor still refuses to open a hub database, correctly. It needs an asynchronous shared-data boundary for configuration/accounts, launch credentials, ownership/publication and indexes before real member conversation execution can be wired. This checkpoint does not solve that boundary using an authoritative offline cache. Heartbeat scheduling and collection, owner HTTP/SSE routing, remote per-device provider login, the device UI, external-session sensing and full two-daemon J8/J11 remain phase 4 implementation and acceptance work. CLI `join` will be exposed with the usable member lifecycle, not with this component alone.
