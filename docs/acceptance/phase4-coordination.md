# Checkout ownership and publication over hub HTTP

**Live:** local HTTP and Git operations in isolated test homes. **Simulated:** member devices and providers on this machine. **Not run:** model calls and live second-device acceptance.

Checkout ownership and publication now have asynchronous hub interfaces that the conversation service can use. The existing hub application uses those same device-bound implementations locally. A full member application still needs the other shared-state connections before it can run a conversation.

Checkout requests bind the authenticated device to the hash of its device identity and absolute checkout path. Revision checks choose one winner when claims race. The hub timestamps accepted records, and the local ownership file mirrors the returned claim. Kept or unsettled work retains ownership. Losing a successful acquire reply leaves the hub reservation intact; retry reconciles it. Losing a successful release reply can remove the lingering local file only when the recorded device, path, conversation, work and process still match. A later owner's reservation is never cleared by that retry.

Publication uses acquire, renew, assert and release operations executed on the hub. The hub clock governs the existing 120-second lease and 30-second renewal interval. Stored owners are scoped by device and work, so another member cannot use the same work identifier to operate the lease. Client-supplied expiry times do not extend authority. A failed renewal remains a barrier to pushing even if transport recovers later in the same publication attempt.

The real Git publication path can use member HTTP ownership and leases without a member hub database. An injected outage after fetch prevents the push and preserves the verified local checkpoint. These checks establish that boundary; they do not establish complete conversation wait/resume behavior during a hub outage.

## Verification

- Typecheck, lint and the production build passed.
- **29 checks passed in three files in 8.55 seconds:** the eight new coordination cases, existing checkout/publication ownership tests and hub HTTP tests. They exercise concurrent claims, interrupted replies, revision conflicts, actor and path binding, hub-clock expiry, outage recovery, actual Git publication and failed renewal.
- **67 checks passed in two files in 140.25 seconds:** the complete affected Git-policy and memory-conflict suites, using actual local repositories.
- **Eight selected application checks passed in two files in 62.99 seconds:** verified manual publication, concurrent checkout ownership, Keep/Discard settlement, restart recovery, two published-undo cases and two context-merge cases. The other 81 cases in those files were excluded by the selection, not counted as passes. Provider execution is simulated.
- **12 browser workflows passed in 1.6 minutes:** manual planned work, context merge and composer choices across desktop/phone and light/dark. Providers are simulated; these workflows check page errors and horizontal overflow as well as the user-visible behavior. Refreshed phone Changes and desktop Why captures were visually inspected.
- These are **104 affected backend checks across three sequential commands**, followed by the browser matrix, not a new full-suite result. History/worktree secret scanning and whitespace checks passed. The existing private Tailscale report returned HTTP 200; its earlier recorded UI and real Codex demonstration remain available.

## Remaining work

Configuration, rigging, projects and slim conversation/decision indexes still need asynchronous shared access. The application is still hub-only. Member construction, heartbeat scheduling, owner HTTP/SSE routing, remote provider-login UI, device UI, the external-session sensor and two-daemon J8/J11 remain phase 4 work. Dedicated Jev/Claude credentials, commit approval and GitHub authentication retain their previously recorded blockers.

The unchanged commit-approval and GitHub authentication failures were not retried. No dependency, installed service, native agent home or reference repository was changed for this checkpoint.
