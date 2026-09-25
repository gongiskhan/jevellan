# Provider login during hub loss

**Live:** local HTTP, SQLite, fixture terminal processes and Chrome. **Simulated:** provider authorization, credentials, devices and hub failures. Successful live Jev classification and Claude provider/vision checks remain credential-blocked. These tests do not use the user's native agent homes.

An admitted provider login now preserves its pending credential capture when the hub is unavailable, including when the native login process has already exited successfully. It retries capture within the original login deadline. Cancellation stops the pending capture. A typed hub failure during readiness checking leaves the login checking; it no longer becomes an ordinary failed provider check.

Credential capture carries one request ID through the account service and hub. A transaction saves the credential and a versioned receipt together. The receipt binds the device, account, original revision and a keyed fingerprint; it contains no plaintext credential. Repeating a capture after a lost successful reply returns the current account view without rotating its credential again or overwriting a later label change. A newer credential invalidates the old receipt. The account service keeps the original revision for that capture in memory.

Login-start requests use stable IDs. Local metadata receipts prevent a browser replay from starting a new native login after a daemon restart. Concurrent submissions of the same authorization code share one native exchange; a different code cannot replace an accepted submission. Input validation runs before that submission is retained, so malformed input can be corrected. Browser repeat permission is granted only for the typed hub failure at the supported boundary.

The waiting notice and Stop waiting control now render in the login dialog's top layer. Closing an active login sends its cancellation independently of a waiting code submission. Navigation and unmount abort pending browser waits; stopping a browser wait does not undo a request already admitted by the daemon.

## Verification

- Initial account and terminal-login checks: **44 passed in two files, 4.56 seconds**.
- Expanded account, mesh, API and browser-request checks: **121 passed in nine files, 10.72 seconds**.
- After the final browser lifecycle edits and concurrent start-ID regression, the complete affected account/login/runtime suites passed **138 tests in eleven files, 23.81 seconds**. The earlier runs are overlapping checkpoints, not additional unique tests.
- **Twelve browser workflows passed in 50.7 seconds**, across desktop/390-pixel phone and light/dark. They cover ordinary account/login/Rigging/configuration flows, lost successful login-start and accepted-code replies, a stable credential after replay, reachable dialog wait controls, stopping polling and cancelling a pending login after hub recovery.
- Phone-light and desktop-dark waiting captures were visually inspected. Both keep the dialog and Stop waiting control visible without horizontal overflow. The dedicated Claude vision check remains not run.
- Typecheck, lint and production build passed. This is targeted verification, not a clean full expanded repository suite or completed acceptance.
- Repository-history and working-tree secret scanning and whitespace checks passed. Work remains on main, and BRIEF.md remains ignored and untracked.

The private Tailscale report returned HTTP 200 and was opened in Chrome. It remains the fixed earlier preview with recorded UI and the real manual Codex task; this checkpoint does not replace those assets or claim a live judge classification. No preview service, product daemon or Tailscale route was restarted or changed.

Account creation and other Settings writes still need their remaining mutation-specific reconciliation. Periodic synchronization, remote provider-login UI, device/header UI, network setup, two-daemon J8/J11, installer and improver remain implementation work. The existing commit-approval and GitHub-authentication blockers were not retried.
