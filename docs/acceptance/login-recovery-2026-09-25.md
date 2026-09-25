# Claude sign-in recovery

The user reported that submitting the browser authorization code removed the input field, left the dialog open and never connected the account.

## Findings and change

The live pilot's affected Claude account had no saved credential. Jevellan hid the paste field once submission was accepted, even while the native login remained pending. Claude can display `OAuth error:` and stay running at `Press Enter to retry`; the driver watched for a token or process exit and missed that error. Browser polling errors also appeared outside the modal and could stop further polling.

The driver now recognizes Claude's terminal sign-in error, returns a fixed safe message and terminates that failed login process. Expiration also has an explicit message. Code submission separates pasted text from Enter by 250 ms, matching Garrison's read-only reference implementation. Cancellation during that interval prevents the delayed Enter.

The dialog now shows progress after submission, renders request errors inside the dialog, resumes polling after a connection failure, and offers **Start again**. Restarting a login cancels its old process and requests a fresh link with an idempotent request identifier. A failed attempt no longer presents its old link as usable. Account readiness still requires the normal credential capture and provider check.

## Evidence

- **Live diagnostic, deliberately invalid credential:** installed Claude 2.1.282 reported an OAuth error while its terminal remained open. The patched driver returned `failed` and the safe restart message promptly, with zero credential captures. A separate URL check found all expected authorization parameters. No actual successful account login is claimed.
- **Simulated terminal regression:** a terminal form that must render pasted input before Enter timed out with the previous implementation. The patched test passes. The installed CLI did process the combined write in the deliberately invalid-code diagnostic, so timing is not proven to be the cause of the user's original rejection.
- **Simulated providers, actual local processes/storage/HTTP:** all 54 tests in the login, account-service and remote-login selections passed in 15.27 seconds. Cases include delayed input, cancellation, native OAuth failure, safe error propagation, fresh login, secret capture, readiness, hub-loss recovery and per-device routing.
- Workspace typecheck, lint, build, secret scanning and whitespace checks passed. All **12 browser checks passed in 1.5 minutes**, covering new recovery cases and the existing Settings workflow on desktop/phone in both themes. The phone recovery capture was visually inspected. Provider approvals and successful credentials are simulated in those browser tests. The initial browser launch used an unavailable bundled Chromium; rerunning with already-installed Chrome required no installation.

The original attempt's precise provider rejection cannot be recovered: its terminal transcript was not retained. The missing credential is not treated as a successful login. A new user sign-in is required to verify successful authentication.

## Pilot patch

A separate patch copy is prepared at `~/.jevellan-build/pilot-login-fix-2026-09-25/`. It retains the frozen phase-5 application and changes only login handling and its tests; deferred phase-6 features are excluded. The prepared copy builds independently and all 54 focused login/account/remote tests also pass there in 11.26 seconds. Its versioned `patch.json` records source checksums and the evidence limits. It reuses the existing pilot data home and Tailscale URL. No native agent home or user login is changed.

The user explicitly approved applying the patch and briefly restarting the pilot, overriding the daemon restriction for this update. Activation completed at 2026-09-25 17:34:51 UTC. The lifecycle maintenance lock confirmed the old pilot was idle before graceful shutdown. The replacement owns the same data home, and the Tailscale response matches the patched UI. All three accounts, one project, the passphrase record, vault key and one conversation’s ledger hashes were preserved exactly. No work was relaunched. Private activation/process/preservation receipts are saved alongside the patch. Successful Anthropic authentication still requires the user to refresh and complete a fresh sign-in. The staged checkpoint and earlier commit/publication blockers remain unchanged.
