# Shared accounts over hub HTTP

**Actual local HTTP, encrypted SQLite storage and isolated runtime homes. Provider probes, models and member devices are simulated. This is account-component evidence, not a completed member daemon or live second-device acceptance.**

AccountService now awaits a shared account-data interface. The hub implementation owns metadata, encrypted credentials, per-device status, model discovery and recent-use records. The member implementation sends versioned requests through the authenticated hub client. Provider login, probing, model discovery and runtime preparation remain on the requesting device. A member does not open a hub database or treat cached account data as authority.

Credential replacement is one hub transaction: check the expected revision, encrypt the new credential, replace its reference, clear the old identity, invalidate every known device status and remove the previous secret. Injecting a failed status write rolls back the entire replacement, including the new secret. Probe and stream reports carry the credential reference they actually used. Reports for an old reference cannot change the replacement's readiness, identity or usage. Credential exchange requires the account's current shared reference and cannot retrieve an unrelated vault entry; status writes are bound to the authenticated member.

The local service waits for outstanding requests during shutdown. A delayed lookup or credential reply cannot start native login or preparation after closure, and preparation already queued behind another operation checks closure again before starting. Hub outages refuse new resolution, login and edits without falling back to an offline account database.

The conversation loop awaits account eligibility and confirms the current conversation generation before launching. Recent-use recording precedes the durable running-stretch record. Usage reporting is queued without blocking the runtime event stream; the completed local outcome is retained before a reporting failure can pause further work. Project-context requests recheck the observed files and revision after waiting for account eligibility. This does not yet implement the full member ownership/publication outage protocol.

## Verification

- Typecheck, lint and production build passed after the asynchronous call sites were updated.
- **43 passed in four files in 8.65 seconds:** member accounts, local account service, hub HTTP and Settings APIs. Eight new member-account cases cover actual HTTP, cross-device replacement, injected transaction rollback, scoped credential exchange, outage behavior and delayed shutdown.
- The first sandboxed test attempt passed the thirteen local account tests but could not construct HTTP applications because process inspection was denied. The rerun above used the normal test environment with disposable homes and local listeners. A widened test mock type was corrected before that successful run.
- **114 passed in three files in 755.42 seconds:** the complete automatic-conversation, manual-conversation and project-context service suites. New regressions prove that delayed usage reporting does not stall the runtime or erase its completed local outcome, an unavailable account authority cannot record a new running stretch, and changed instruction files invalidate a merge request while eligibility is pending.
- **29 passed, one missing-key live skip, two files, 384 milliseconds:** decision selection and decision-state/memory checks. A new delayed-eligibility regression prevents the model-selection call after the conversation changes. The skip is the existing real Jev smoke test, not a pass.
- **20 browser workflows passed in 2.1 minutes**, after the backend runs finished: Settings/account login/Rigging, manual planned work, context merging, automatic recovery and composer choices across desktop/phone and light/dark. The workflows assert no page errors or horizontal overflow. Refreshed phone account and dark desktop Why captures were visually inspected. Providers are simulated; the Claude SDK vision check remains credential-blocked.
- Final typecheck and lint passed; the production build passed. These are 186 affected backend checks across three sequential commands, with one separate missing-key skip, not a new full-suite result.
- History/worktree secret scanning and whitespace checks passed. The verified changes and refreshed captures are staged on main; the unchanged commit-approval and GitHub authentication blockers were not retried. No dependency, service, native home or reference repository was changed.

The existing private Tailscale progress report still returned HTTP 200. Its Changes & tests page was opened and visually inspected through the real browser, and the report tab was left available to the user. Its recorded UI and real Codex work remain the previous validated demonstration. No successful live Jev classification or Claude provider/vision result is claimed. Missing dedicated credentials, commit approval and GitHub authentication remain the previously recorded blockers.

## Remaining work

The product application is still hub-only. Configuration, rigging, project/index access, ownership and publication need asynchronous hub authority before a full member application can execute conversations. Heartbeat scheduling, owner HTTP/SSE routing, remote provider-login UI, device UI, the external-session sensor and two-daemon J8/J11 remain phase 4 work. The CLI join lifecycle remains unexposed until that member application is usable.
