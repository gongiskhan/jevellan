# Indexed thread streams — 13 October 2026

Decision 794 refines decision 737's authenticated thread stream. A remote thread's hub index can arrive before its local file; owner routing already validates the project and device, so subscribe to its existing ledger immediately instead of requiring the full thread view. Unknown and other-project ids still return 404. The regression fails before repair; all 27 affected API/coordinator/harness/proxy cases, typecheck/lint/build pass. First C passes C1–C3 with one Claude compaction, the same session and the preserved invoice title rule, then C4 fails on that real 404 race. Its original failed receipt and separately recovered completed usage remain live evidence. Rerun C from the start on the documented private overlay; production stays unchanged, and the original ten-hour clock and queued cache/journal gate remain.

- **Live:** real Claude C1–C3 pass; C4 fails on the 404 before its member thread arrives. Retain the original failed receipt and separate bounded usage recovery. No full C pass or owner acceptance.
- **Simulated:** API regression reproduces 404 before the repair and then receives the later event through the same open stream; unknown and other-project ids remain refused. Nineteen API/coordinator/harness cases and eight proxy cases pass. Typecheck, lint and build pass.
- **Not run at this checkpoint:** exact C rerun and D layouts. Stage only the compiled API module in both owned uninstalled test copies after push; preserve immutable releases and installed services.
- **Clock:** prior stop2026-10-14T04:15:59.903Z; cache/journal clocks unstarted and release0.3.4 remains queued.


## Delayed index correction — decision795

Decision795 completes decision794's remote stream repair. Second C passes C1–C3 again, then C4 returns404 before even the hub thread index arrives. A stream now waits up to ten seconds for the index only when an existing queued/active task in that project already names the thread. Unknown and other-project ids retain404; an unarrived known start gets an explicit409 instead of an unbounded wait. Once the owner index arrives, normal owner routing and the earlier ledger subscription apply. The new delayed-index regression fails before repair; all35 affected API/coordinator/harness/proxy/queue cases, typecheck/lint/build pass. Retain both failed C receipts and their bounded usage recoveries. Stage only the API and project-work modules in the private development copies after push, then rerun exact C. The original prior deadline and queued cache/journal clocks remain unchanged.

The initial fix covers index-before-local-file; the second exact run exposes task-before-index. Both stages now have separate failing-before regressions. Completed-turn costs recovered through the original receipt end total USD7.150713 for the second C; missing/in-flight costs stay unknown. Current AC sleep is0. No extra review or acceptance waiver.


Decision795 verification checkpoint: main5bffe23f is pushed after its mandatory history scan. The affected PJ5 member-thread browser journey passes4/4 in desktop/phone light/dark; all four dedicated live vision judgments report no blocking findings. Browser behavior is simulated, not real-provider or physical-phone acceptance. Both private applications verify the new API/project-work module hashes and actual /api/health documents; installed services/releases remain unchanged. Exact third C is in progress in the owned test profiles, with the original clock and unstarted cache/journal gate retained.
