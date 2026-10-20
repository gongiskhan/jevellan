# Bridge Codex pass

Fresh run on 20 October 2026. Main starts at c1248ab2; origin/bridge is ac98492f. Neither 0.6.0 nor 0.7.0 is released or installed. Both active devices are reported on 0.5.1; fresh installation checks follow. The full required authority documents and the complete bridge surface map were read before implementation. PRD.md, PLANING.md and TASKS.md are absent.

## Numbered decisions

1. The current run brief controls order and clocks over the older specification: six hours for step 2.1 from this run's first commit; twelve hours for 2.2–2.6 after that stage; three hours for 2.7. Prior expired clocks provide no authorization and will not control this run. A failed prerequisite or expired stage prevents starting its successor.
2. Finish and install 0.6.0 on main before the bridge enters main. The only branch exception is the existing bridge integration explicitly authorized by the current brief. No new branches, worktrees or builder agents.
3. Missing interactive authentication is blocked evidence and an exact future owner step. Continue independent work without asking or waiting for sign-in. Production deploy approval remains with the owner.
4. The CodeGraph executable is unavailable in the current shell and standard tool paths. Query the existing symbol database read-only before source search, then verify current files; the index predates Projects. Do not reindex or modify native agent homes.
5. Reuse valid original full-gate and isolated receipts with their original source labels. Missing selection, unavailable released counterparts, invalid reporter attempts and missing images are not passes. Fresh screenshot/judgement pairs are retained immediately under unique run/layout paths.
6. The prior 0.6 closing reviews and their fixes remain recorded; do not add another build review. The bridge's single scoped closing review remains a later prerequisite.
7. The old continuity document's automatic production deployment and external contributor rules are superseded by the newer decisions and bridge intake specification. No production deployment or extra IAP preflight is authorized. The source map proposes many routes and still contains unmoved UI logic; proposed rows are not implemented evidence.

8. Preserve synchronous launch identity and its existing start representation to avoid losing quick child exits; Linux uses the individual proc entry, other platforms keep the existing process-table mechanism.
9. Journal durability stays intact for changed records. Idle sweeps avoid rewriting identical state and yield between projects so HTTP can progress.
10. Background heartbeat checkout discovery uses asynchronous Git with the existing root/path guards; it does not fetch or change a checkout.

## Stage 2.1: finish 0.6.0

In progress: first reproduce the fixture's periodic event-loop starvation, then fix its cause with a failing-first regression before trusting browser gates. Historical full results remain backend 2,501 passed/32 failed/1 skipped and browser 96 passed/100 failed/208 skipped. The fresh stage has not yet accepted a gate. Versioning, archives, publication, cold backups, installation, switch and live checks are not run.

Tests for this orientation checkpoint: not run (documentation). No owner acceptance is claimed.

First commit/start: `2026-10-20T05:39:58Z`. Step 2.1 deadline: `2026-10-20T11:39:58Z`. Later clocks are unstarted.

## Fixture starvation investigation

Simulated, failing first: a 100-second fixture probe recorded 1,320 HTTP requests, a maximum request delay of 1,146 ms and an event-loop pause of 1,804 ms. CPU profiles identified repeated synchronous process-table reads during command launches; the regression measured 128 identity reads blocking for 5,814 ms. Linux now reads the individual proc identity while preserving the existing UTC start representation. A read-only comparison matched 1,058 running process identities with the operating system, with zero mismatches and one already-exited process. The existing process-group checks still enforce reused-PID refusal and descendant termination. The Linux proc representation follows the [Linux process-stat documentation](https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

The first repeated probe remained red (maximum HTTP delay 767 ms): journal batches rewrote unchanged durable cursors/manifests and did not yield to requests, and heartbeat discovery synchronously resolved checkout roots through Git. Two journal regressions and one slow-Git heartbeat regression failed first. Journal batches now yield between projects, unchanged state avoids durable writes, and heartbeat discovery uses the same checkout boundary asynchronously. The first journal attempt exposed a batch reservation race; it was corrected before the final affected run.

Simulated: final affected run passes **39 cases across three files**, typecheck and lint. The final HTTP probe is pending; browser gates remain unaccepted until it completes. Screenshot capture now immediately preserves the exact image bytes in the private run/layout evidence folder before the next Playwright run can clear its temporary artifacts.

A readiness regression also failed: the final seeded project still had a busy context operation after the control listener announced readiness. The fixture now drains admitted startup work and the initial journals before binding that listener. Its focused readiness test passes. This is an actual startup-work barrier, without a fixed delay or relaxed HTTP assertion. The last responsiveness probe is running against this change.

Classification preparation: all 14 checked browser input files in the preserved original-main and v0.5.1 snapshots match their recorded revisions. The isolated harness starts exactly one fresh fixture and selects exactly one non-skipped test per attempt. It uses each snapshot's own Playwright dependency instance. Twenty-nine backend failures retain six valid historical comparisons; three have no released selectable counterpart and remain explicitly unavailable comparisons. Fresh full gates follow the fixture checkpoint.

Simulated, final responsiveness probe **passed**: 1,412 authenticated HTTP requests over 100 seconds, maximum 95 ms, zero slow or unanswered requests; owned fixture teardown confirmed exit 0. Exact CPU profiles, request summaries, source-diff hash and prior failed attempts are retained privately. The affected verification totals **40 passing backend cases across four files**, with typecheck and lint passed before the readiness-only fixture change. Full backend will deliberately use six workers on this 16-core machine with low load; heavy suites remain sequential. The optional Node 20 test runtime is absent and will be labelled blocked, not passed.

## Owner pivot: 20 October, 06:00 UTC anchor

11. Latest owner plan supersedes the earlier clocks, gate classification, integration order and review timing. Actual CLI evidence confirms version 0.163.0, GPT-6.1-Sol xhigh **Fast**, service tier priority; the requested Ultrafast label is not offered by this CLI. The supervisor used the actual /fast control. Private tier proof is retained; speed remains unchanged.
12. Owner deadlines: 0.6.0 published and installed on both devices with the project switch by **08:30 UTC**; 0.7.0 installed on both with bridge status/test push by **10:30 UTC**; daily use goal **11:00 UTC**. Earlier stage clocks are superseded.
13. Run the full backend with six workers when resources permit, then desktop light once. Rerun failures once. Only repeated core browser failures block; other browser failures are recorded for later. No further per-tag classification or four-layout vision matrix is required. New-screen vision is nonblocking.
14. After 0.6.0, fetch bridge once, freeze its SHA, and merge that SHA into main. Never switch to or push bridge. Missing intake, UI migration/parity and additional engine work move to planned roadmap items; they do not block this working bridge release.
15. Publish and install 0.7.0 directly, record readiness, then perform one scoped closing review while the owner can use it. Further UI work belongs to 0.7.1. Interactive authentication remains blocked with an exact owner step.

Checkpoint preserved at 04e41062: fixture probe passed 1,412 requests, maximum 95 ms; 40 affected backend checks passed. Full revised gates start next. No release or installation is claimed yet.
