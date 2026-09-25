# Hub outages while closing work

**Live:** local Git, HTTP, SQLite, isolated homes and owned test processes. **Simulated:** providers, additional devices and hub outages. This checkpoint does not claim a real second-machine journey or successful live Jev classification.

An admitted Publish, Keep or Discard request now waits if the hub disappears while it checks or acquires checkout ownership. The wait remains tied to that request's work and generation, including an already-closed work whose changes were retained. A fresh heartbeat wakes the existing operation; replaying the same request does not create another one.

Discard can also wait after saving its recovery ref and before resetting the checkout. It resumes only from the exact ref recorded by this settlement and checks that the ref still names the original checkpoint. Fresh ownership, outside-activity, generation, clean-tree, history and unpublished-commit checks still apply. A changed file, commit or saved ref prevents the reset. The recovery ref is checked again immediately before reset so later edits cannot remove the saved checkpoint unnoticed.

Closing the work and releasing ownership are separate boundaries. If a successful release loses its reply, recovery finishes that exact claim's local cleanup without reopening the work or repeating its Git operation. Cancellation interrupts the continuation; restart keeps the durable settlement and ref for inspection without resuming it automatically.

The wider regression also exposed a stopped-runtime checkpoint problem from the earlier hub-wait change. Once termination is confirmed, the daemon must still account for that writing step's finished files before undo. It now attempts that guarded checkpoint once with fresh authority and an unchanged-checkout check. If the hub is offline, cancellation does not wait: the files remain for review. An already-waiting checkpoint is still interrupted and cannot resume after cancellation.

Cancellation records its local closed-work outcome immediately after termination, before fetching project metadata or releasing ownership. Hub-dependent cleanup can remain pending without leaving terminated work logically open. Its remaining cleanup and request-retry behavior is not counted as complete section 14 support.

## Verification

- The initial real-discard reproduction failed in **6.35 seconds**: after recording its recovery ref it reported the outage but had no continuation.
- The repaired reproduction passed in **7.55 seconds**, returning to the original base, preserving the discarded checkpoint and releasing ownership without another native step.
- The first expanded run passed **25 cases**, including all 12 new outage scenarios, and failed one existing undo case in **122.46 seconds**. That failure identified the stopped-runtime checkpoint regression described above. A strict test-fixture typing error was corrected before this run; it did not exercise product behavior.
- After the repair, **32 cases in two files passed in 162.29 seconds**, with 106 unrelated cases excluded. Coverage includes lost admission for Keep/Discard/Publish, offline discard after saving a ref, previously closed work, intervening files/commits/ref changes, cancellation, restart, lost releases, existing discard protections and undo while newer work is running. Typecheck and lint passed.
- Two explicit online/offline cancellation checks passed in **71.30 seconds**, with process termination, preserved files and no restart launch. The first version of this additional fixture used whole-application shutdown and expected its online path to produce a checkpoint; that run had one failure and one pass. It did not establish the explicit cancellation behavior, which the final fixture tests directly. No claim is made that shutdown always checkpoints a running writer.
- The complete Git-policy, checkout-ownership and hub-wait suites passed **63 tests in three files in 151.90 seconds**, including exact-ref recovery and refusal of changed or mismatched recovery refs. These suites do not depend on the subsequent local cancellation-state ordering change.
- After moving the cancellation outcome before hub-dependent cleanup, **13 final cancellation/undo cases in two files passed in 117.62 seconds**, with 127 unrelated cases excluded. The online/offline member checks now require the closed-work record and verify it survives restart without a launch. The production build passed.
- A final discard case passed in **7.58 seconds**: a checkpoint published during the outage remains intact after reconnection, along with its recovery ref and ownership reservation. No reset occurs.
- **12 browser workflows passed in 1.5 minutes**, covering kept-work discard, corrections/redo and undo across works on desktop/phone in light/dark. Phone-dark Discard and desktop-light undo-across-works captures were inspected; Claude vision remains credential-blocked. Final typecheck and lint passed.
- Final secret scanning and whitespace checks passed. The checkpoint remains on main, staged rather than committed because the unchanged approval blocker remains. The fixed Tailscale preview has not been updated with this checkpoint.

## Remaining work

Earlier context operations, undo and cancellation cleanup still need waits. New UI requests, logins and settings writes, periodic configuration/APM synchronization, remote provider-login UI, device/header UI, network listeners and full two-daemon J8/J11 remain phase 4 work. Installation, the improver and final verification remain later phases. The fixed private progress preview is unchanged. Successful Jev classification, Claude live/vision, commit approval and GitHub authentication remain separately recorded blockers.
