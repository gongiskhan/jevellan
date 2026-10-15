# Session details and turn 8 — 15 October 2026

The owner reported a long turn with no visible progress and an overcrowded header. Source baseline: 41d7a2b7. The live activation updates the web UI. Source also repairs admission retry after resource relief. The Pro remains on backend0.3.6; verified frontend assets are active with rollback at the private thread-header-2026-10-15/web-before directory. No daemon restart, credentials, Ekoa source, PR merge or project setting change.

## Live diagnosis and recovery

The turn8 native worker was alive. Its requested CI lane finished with gates, typecheck and builds passing, while the separately requested security unit runner continued for more than13minutes. The saved transcript ended in a polling command with timeout600000. The UI therefore showed “Working” without saying what it waited for. A focused owner message with Interrupt current turn cancels the polling tool and queues a diagnostic follow-up. The verified security-test process group in this thread's worktree was sent SIGTERM; unrelated processes were excluded by PID ancestry, group membership and cwd checks. Logs and all source changes remain. Cancellation is not a passing test. The queued follow-up encounters the existing Mac load guard; no guard was overridden.

Sanitized excerpts:

- `.ekoa-run/ci-lane-4.log`: `checks: gates passed`, `checks: typecheck passed`, `checks: builds passed`, `exit=0`.
- `.ekoa-run/security-unit-2.log`: failures in execution-isolation and secret-handoff; runner still active before the scoped stop. These are Ekoa test results, not Jevellan unit-test failures.
- Native transcript: `Poll the security unit suite until it finishes`, timeout600000, followed by the tool interruption and the queued owner recovery message.

## Changes

The header keeps state, PR/checks/conflict badges, model/account and device visible. Session information holds terminal/takeover, Why, Override, full placement, cache and earlier sessions. The takeover command is absent from the composer. Merge corrections remain available inside the merge route drawer. A pending tool's bounded description now appears under the live turn label; absent/incomplete native results are described as waiting, not as proof of process health.

## Verification

- **Simulated:**44 cases in project-work-ui and transcript-groups pass, including pending/finished/partial tool inputs and non-running threads. Typecheck, lint and production build pass.
- **Live:** real Pro page checked at1440×900 and390×844 in light/dark. Screenshots in `screenshots/` show compact and expanded states. Original System theme and viewport restored. Takeover is absent from the composer; warnings remain visible. No physical-phone acceptance claimed.
- **Simulated browser:** first two targeted Projects journeys pass. The thread journey initially reaches the new panel and interrupt assertions, then fails because its old navigation flow looks for Why without reopening Session after revisiting the page. The driver is updated to open the visible Session control; all business assertions/timeouts remain. Rerun passes (50.5seconds); three targeted journeys pass across the two final runs. Simulated screenshots and explicit not-run vision records are retained in simulated-browser/.
- **Not run:** full backend/browser suites, dedicated model vision. Prior full-suite failures remain historical failures. One closing crucial-issues inspection covers only this change; no serious issue found.

## Integration and limitations

Another node has pushed0.4.0 and its vault work to main during this run. Preserve those commits when publishing this UI change. Do not deploy those unrelated backend changes to the live Pro as part of this fix. The activated frontend is built against the Pro's0.3.6 APIs; an integrated-source build is separate verification. The test-project PR remains open, and the queued diagnostic is not reported as completed until its own report is observed.

Decision838 fixes a separately observed admission bug: resource refusal text did not carry the waiting marker recognised by sweepWaiting. Resource-denied turns now keep the standard waiting marker and the original reason, so periodic admission rechecks the guard after relief. The regression fails before the fix, then all54 affected cases pass. Existing slot/account/main/hub rules and resource limits stay enforced. Activation uses the exclusive idle maintenance gate; if it is held, the existing daemon is left alone.

Integration: the scoped commit was rebased onto the other node's main at2ade5652 (0.4.0), retaining its vault and runtime work. The Pro still serves the compatible0.3.6 frontend patch, not an unrelated0.4.0 backend upgrade. The admission patch is prepared with its two original modules backed by the unchanged0.3.6 APIs; activation is pending an exclusive idle maintenance gate. Two attempts correctly refuse while activity holds the gate; no force stop is used. A second ordinary UI message after load falls starts turn9 successfully.
