# Account and managed Rigging save recovery

Account creation, account edits, key replacement and managed Rigging saves now wait through a typed hub outage. The browser retains one request ID for the submitted value, displays the hub-wait notice and offers Stop waiting. Closing an editor cancels its pending browser request; it does not undo a save already received by the hub.

Account and managed Rigging mutations commit a versioned receipt in the same SQLite transaction as their public result. Receipts bind the requesting device, operation and payload with a keyed fingerprint. They contain no submitted key. A replay returns the current saved account or item without repeating the mutation, preserving later edits. Reusing the ID with another payload fails. Failure to store the receipt rolls back account and vault creation together.

Key replacement uses the existing credential-capture receipt, bound to its original revision and secret. Replaying a lost response preserves that credential reference; a later replacement makes the old request stale. A submitted Settings key does not inherit the provider-login flow's thirty-minute deadline. Checks and discovery can safely repeat; login itself retains its separate recovery rules.

Managed item autosave aborts on unmount. Explicit Close flushes a pending unsent edit, while closing during a waiting request cancels it. If a replay finds a later remote edit, the editor asks the user to reopen the item instead of overwriting that content in another autosave.

## Verification

- Final typecheck, lint and production build passed.
- Repository-history/worktree secret scanning and whitespace checks passed. Work remains on main, and BRIEF.md remains ignored and untracked.
- **88 tests in seven affected suites passed**: the account, mesh-account, shared-state, Settings API, Rigging and UI-wait selection passed 69 cases in 12.61 seconds; the account-service suite passed 19 in 912 milliseconds. These include actual HTTP lost replies, SQLite rollback, receipt persistence after reopening the hub, protection of later edits and a key-replacement retry after a simulated 31-minute wait.
- **12 browser workflows passed in 1.2 minutes**, covering ordinary Settings flows, abandoned requests and the new outage journey in desktop/phone and light/dark layouts. The final run followed the key-replacement deadline correction. Creating an account waits both before submission and after a committed response is lost, producing one account. Account edit, key replacement, managed item creation and autosave recover with identical request bodies. Closing a waiting editor prevents another request and preserves the saved content.
- The initial browser attempt used an unsuitable textarea label selector. The first wider matrix then found an old empty-sidebar fixture assumption and a wait assertion that ran before actual Rigging delivery had finished. The test now uses the textbox role, recognizes seeded conversations and waits for the intercepted save response before checking the outage notice. The corrected matrix passed twice, including the final build.
- Representative [phone-light](screenshots/phase4-settings-save-wait-phone-light.png) and [desktop-dark](screenshots/phase4-settings-save-wait-desktop-dark.png) captures were visually inspected. All four layouts have captures. The existing private progress preview returned HTTP 200; it remains the earlier fixed checkpoint.

HTTP, SQLite, encrypted vault storage, installed APM delivery and Chrome are real local execution. Providers, missing responses and hub outages are simulated. This is targeted verification, not a complete expanded suite, successful live Jev classification or user acceptance. Claude vision remains blocked by the absent dedicated token.

Project saves, Jev key saves, remaining account-local Rigging operations and device invitation/switch issuance still need their mutation-specific recovery checks. Installation and the improver remain implementation work. The recorded commit-approval and GitHub-authentication blockers were not retried.
