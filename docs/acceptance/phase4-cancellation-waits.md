# Hub outages during cancellation cleanup

**Live:** local Git, HTTP, SQLite, isolated homes and owned test processes. **Simulated:** providers, additional devices and hub outages. This checkpoint does not establish a real second-machine journey or successful live Jev classification.

Cancellation confirms runtime termination and closes the work locally before attempting checkout cleanup. If a typed hub outage prevents cleanup, the owning daemon retains a metadata-only continuation for that closed work. The cancellation response and closed history require no shared project or settings read; the response still names the cancelled outcome while cleanup waits. New HTTP requests still require authentication through the hub, so this does not yet solve requests that lose connectivity before admission.

On reconnect, cleanup checks the exact conversation and work owner. Unpublished commits, dirty files and incomplete undo keep the reservation. If a release reached the hub but its reply was lost, the existing idempotent release removes only the matching old local lock, even when files changed afterwards. A newer owner's lock is preserved. Cleanup never runs a model, changes Git or reopens the work.

Repeated Cancel acknowledges the already cancelled work without interrupting its pending cleanup. Shutdown aborts and drains that continuation; startup retains the interrupted evidence and never recreates it. Other operation types retain their existing cancellation behavior.

## Verification

- The original reproduction failed in **5.30 seconds**: the work closed, but the first offline project read rejected cancellation without registering a continuation.
- The first repaired run reached cleanup completion, then failed a fixture assertion that incorrectly required the conversation's update timestamp to remain unchanged after new ledger notices. The assertion now preserves every other field while allowing that timestamp to advance.
- The expanded matrix passed **12 cases in 56.73 seconds**, covering project/ownership reads, lost release replies, the final ownership read, repeated Cancel, later files/history, unpublished checkpoints, newer ownership and shutdown/restart. The first expanded typecheck found a test-only use of a nonexistent singular project accessor; it was corrected to the existing project listing before this run.
- The subsequent HTTP and compatibility selection passed **21 cases in 130.87 seconds** across three files. It upgrades six matrix cases to authenticated HTTP cancellation, proving a successful closed-work response when the hub disappears after admission. It also covers online/offline cancellation of an active writer, confirmed process termination, pending undo/discard, lost settlement releases, delayed choices, unpublished work and context cancellation.
- The complete wait and conversation-recovery suites passed **10 cases in 5.03 seconds**. Together with the matrix and compatibility selection, this is **37 distinct targeted backend cases**, not a clean full expanded-suite run.
- **Eight browser workflows passed in 1.0 minute** across desktop/phone in light/dark, covering saved-work settlement and context drafting, cancellation, reload and verified application. Phone-light Discard and desktop-dark context captures were inspected. Providers are simulated; Claude vision remains credential-blocked.
- Final typecheck, lint, the production build, secret scanning and whitespace checks passed. The checkpoint is staged on main. The recorded commit-approval and GitHub-authentication blockers remain unchanged; neither rejected action was retried.

## Remaining work

Earlier context boundaries, new UI requests, logins and settings writes, periodic configuration/APM synchronization, remote provider-login UI, device/header UI, network listeners and full two-daemon J8/J11 remain phase 4 work. Installation, the improver and final verification remain later phases. The fixed private progress preview remains unchanged and responded with HTTP 200 during this checkpoint. Successful Jev classification, Claude live/vision, commit approval and GitHub authentication remain separately recorded blockers.
