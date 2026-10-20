# Bridge Codex pass

Current checkpoint, 20 October 2026: 0.6.0 was released and installed before bridge integration; 0.7.0 was released and installed on both devices; essential 0.7.1 is published from `498701ab` and installed on both with doctor **10/10 each**, verified at **10:47:15 UTC**. Its full backend selected 2,604: **2,589 passed, zero failed, 15 not run**. Managed bridge authentication remains externally blocked; status/push and owner acceptance are unpassed. The 11:00 daily-use goal was not fully met. Optional UI/intake/parity/engine work remains planned.

The latest owner plan and Decision 25 supersede the earlier clocks, classification, integration procedure and review timing. Essential 0.7.1 has no 10:30 hard cutoff. Entries below preserve chronological checkpoints; their older pending states and superseded deadlines are historical.

Initial orientation (historical): main started at c1248ab2 and origin/bridge was ac98492f. Neither release was published at that checkpoint and both devices were on 0.5.1; current verified versions are recorded above. The full required authority documents and the complete bridge surface map were read before implementation. PRD.md, PLANING.md and TASKS.md are absent.

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

## Stage 2.1: initial checkpoint (historical)

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

Revised full backend gate (simulated): **2,547 passed, zero failed, one skipped**, six workers. The skipped fixture remains not run. Desktop light selected exactly 100 journeys across the ordinary, improver and projects groups and is now running once. No release or installation is claimed yet.

Desktop light, simulated: **60 passed, three failed, 37 skipped** of 100 selected. J8 and J11 still navigate to the project home before looking for the new-conversation form; LJ2 asserts the retired `autoMerge` field. These noncore cases are rerun once and recorded, without fixes in this release stage. The serial Projects file skipped later core journeys; settings save, Overview and the deploy message get fresh first attempts. Typecheck and lint pass. All 88 generated documentation images were retained privately before only generated outputs were restored.

16. Parent operational authorization permits the normal managed bridge interactive login for an existing browser SSO attempt after installation. Authentication is labelled blocked only if that normal path genuinely cannot complete; no native credential files are copied. The separate OAuth integration remains deferred.
17. Darwin cache reuse is optional and conditional: the official archive digest, all external lock entries/integrities and dependency edges, Node ABI, unchanged external file bytes, current source/shared compiled bytes and an extracted CLI/native-PTY smoke must match. It is never reported as a native build. npm supports packaging existing [bundled dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bundledependencies); Node documents its [module ABI check](https://nodejs.org/download/release/latest-v22.x/docs/api/process.html#processversions). The preflight matches 444 external entries and ABI 127 on both devices; candidate verification is pending.

The three noncore failures repeated on their single rerun (three selected, zero skipped); they remain recorded failures. Fresh core checks pass settings save and the deploy-message journey. Overview failed twice, exposing a stale synthetic index: the fixture used retired `landing` string values, which the current schema discards, instead of `landingStage`. Three fixture records now use the current field. The original Overview journey then passes with all assertions unchanged; lint and the focused readiness test also pass. Production code did not change in this correction. Thread-list and thread-page journeys passed in the full desktop-light run. The revised owner gate is accepted with these explicit noncore failures and skipped follow-up journeys; version 0.6.0 is prepared next.

### Verified 0.6.0 archives and publication

Live packaging and publication: `v0.6.0` was published at 2026-10-20T07:14:31Z from `075cbec2dbb140bb0f10a705da747a1416a8bf82`, with no bridge ancestry. The GitHub asset digests match both verified archives. Linux source, extracted CLI and native PTY checks passed. Darwin source and all shared built files match that exact Madrid build; all 444 external dependency lock entries and workspace dependency edges match official 0.5.1, both machines use Node ABI 127, and every extracted external dependency file matches the official Darwin archive. The extracted Darwin CLI and native PTY passed on Pro at 07:10:48Z. This is verified dependency-cache reuse, not a new Darwin native build; peer tests were left running.

18. **Cold-stop continuity:** installed 0.5.1 retained lifecycle activity for background publication of a previously merged managed pull request. Fresh process proofs showed no native turn, no held thread and no active Git child. Its thread, worktree and publication state were preserved, and only the named service was stopped normally for the cold backup. The exclusive lifecycle reservation was unavailable for that background operation; this was not treated as evidence of a running native turn. Exact private proofs record the condition and stop. Installation and final doctor results remain pending until verified.

19. **Darwin packaging:** installed npm 10.9.8 invoked `prepare` despite `npm pack --ignore-scripts`. The private release helper used the same installed npm packlist and tar-create implementation directly to archive the already verified tree. All source and dependency byte comparisons were repeated after extraction, followed by the live Pro smoke. No manifest or product lifecycle script was changed to bypass a check.

### 0.6.0 installed; ordered switch recorded

Live installation: both active devices run 0.6.0 and pass doctor **10/10**. Both are Online, vault sync completed after installation with nothing pending, and no project-request classification remains open (verified 2026-10-20T07:24:13Z). Fresh cold backups and retained prior applications are available. Normal managed-account status refreshes resolved the initial doctor freshness warnings.

The prescribed sequence involving the ERP check, coordinator handoff, preset 3 and nightly configuration has private receipts. Project-specific live results, environment inventory and configuration remain private. No production deployment, rollback or additional IAP preflight was run. Production rollback remains unavailable without actual VM/image attestation. Ekoa OAuth remains deferred and blocked, with its exact owner step first in the private handoff.

20. **Journal recovery:** the installed journal rebuild command regenerates read-only projections from the authoritative ledgers. Recovery retained a separate copy of the earlier projection and verified every earlier canonical ledger byte unchanged. Mixed-version reconnect and projection recovery need expanded coverage in 0.7.1; no raw transcript is included here.

21. **Setup migration:** an older preset's goal name can conflict with its stable create-request ID before the rename migration runs. A revision-checked edit preserves the existing identifier and history. Automating that ordering and its regression is planned for 0.7.1; no receipt or goal history was reset.

The 0.6.0 phase is complete before the owner deadline. Next is one fetch of the bridge branch, freezing that exact commit and merging it into main. Later bridge commits belong to a later merge.

### Frozen 0.7.0 source and revised gate

22. **Frozen merge:** one fetch at 2026-10-20T07:46:49Z selected `ac98492fe78ea0ecf583e716ab50c1206997f571`, the same commit read during orientation. It merged cleanly into main on `f847881f`. The branch was neither checked out nor pushed, and later commits will not be chased. The latest owner instruction replaces the older bridge-to-main push procedure. All workspace manifests, internal references, the lockfile and core version are now 0.7.0.

Simulated gate: typecheck, lint and the production web build pass. The complete backend run selected 2,602 tests: **2,584 passed, three failed, 15 not run**. All three exact failures passed on one corrected-harness rerun each, with exactly one executed test per rerun. The backend gate is accepted under the owner's one-rerun rule; this is not an unqualified claim that the original full run had zero failures. Thirteen model-eval cases and the full bridge Journey B were not enabled; the generated Node20 sandbox case lacks its documented runtime. None is counted as passed. Installed bridge status/push proof remains separate.

23. **Reporter and harness corrections:** the first full attempt's `/dev/stdout` JSON ended with EPIPE and is invalid; its partial header is never used as a pass. A regular private output file produces a complete report and is filtered before evidence reads, then removed. The first regular-file wrapper incorrectly applied `umask077` to the whole suite, changing executable bits and command-recovery behavior. The corrected wrapper preserves inherited `umask0002` and precreates only the private report at0600. Product source, assertions and timeouts were unchanged. The three exact permission/recovery cases passed once after that correction. Both fixture-close cases also passed their one file rerun and the complete regular-file run.

Desktop-light rewired-screen smokes: **5 selected, 5 passed, zero skipped**, covering Overview, thread list, thread page, deploy message and settings save. Five isolated fixture projects ran with five workers after the backend job; screenshot bytes were retained immediately. Only two existing web views changed, with no new screen, so the owner plan requires no new-screen vision check. The four-layout matrix and expanded parity remain planned0.7.1.

Live publication: `v0.7.0` was published at **2026-10-20T09:13:25Z** from `ba983982d21c0ec40a8b64310e67f73a9fe2c28c`. Both GitHub asset digests match the verified archives. Both archives match 3,676 tracked source files, with zero source mismatches. Linux CLI/native PTY checks pass. Darwin external dependency metadata and file bytes match the official 0.5.1 cache, Node ABI is127 on both devices, and the actual extracted Pro CLI/native PTY smoke passed at09:07:53Z. No new Darwin native build is claimed. Cold backups, installation and managed interactive bridge authentication are proceeding. The single closing review remains after readiness.


### 0.7.0 installed on both devices

Live: both devices run0.7.0 and pass doctor **10/10**, are Online, have synced the vault after installation and have no open project-request classification (verified2026-10-20T09:24:41Z). Fresh cold backups and retained earlier applications are available. A transient process-table child initially stopped the Madrid backup guard; a fresh proof passed without changing the guard. The initial account freshness warnings cleared through normal managed-account checks.

24. **Isolated runtime availability:** the member's existing native Codex launcher became unavailable during the update window. Its native home and launcher were left untouched. The same0.153.4 public package was installed under Jevellan's isolated runtime-tools directory and linked only into its existing managed tool path. Normal account checks and doctor then passed; no peer process was stopped.

The normal managed bridge start reported missing interactive authentication. A normal installed account login was started in an owned hidden prompt. The supervisor's existing browser SSO attempt uses a temporary private loopback password form that forwards only the code in memory to the existing account-login API. The form has a one-use nonce and same-origin checks, stores no code and logs no request bodies. It has no terminal-control or arbitrary-command capability. Authentication and actual bridge status/push proof remain pending; token checks are not remote-control acceptance.

A live launch attempt exposed a provider-variable boundary defect before runtime execution. A failing-first regression reproduces it: project provider variables intended for command jobs reached the stricter native-runtime input schema. Launch preparation now applies the existing runtime environment filter before validation; command jobs retain their original project environment. Typecheck, lint, build and36 affected cases pass. This repair is source-only while its full backend gate runs; the installed0.7.0 release does not contain it.


25. **Clock clarification:** the10:30UTC deadline applies to the published/installed0.7.0 milestone. The essential0.7.1 blocker repairs have no10:30 hard cutoff. Their daily-use target is11:00UTC; a miss must be reported honestly. Optional UI/intake/engine work remains planned. Old cutoff helpers do not govern these repairs.

26. **Single closing review:** one scoped crucial-issues review of immutable released0.7.0 is complete, before0.7.1 publication. External first-party browser verification blocks managed bridge authentication; it does not block this authorized repair work. No second review is run. The review records three serious issues: provider variables blocking runtime launch; an already saved deployment approval unable to acknowledge under a fresh request; and remote MCP deployment responses reaching the normal engine despite the remote prohibition. Each repair has a failing-first regression. The latter covers approve, retry and rollback with remote writes both off and on. Source-only repairs remain subject to the complete current-source backend gate before publication. No real production action was exercised.


Essential0.7.1 candidate: typecheck, lint, build and **89 affected simulated cases pass**. All three exact regressions failed before their fixes. The full gate now selects2,604 cases with six workers; two earlier incomplete repair gates were superseded when additional serious source fixes became necessary. Their owned processes were stopped only after PID, parent, start and process-group proof, and neither incomplete run is a pass. The current complete gate runs without the superseded10:30 cutoff.

Managed bridge authentication is **externally blocked** by first-party browser verification. The normal company email path was attempted through the private in-memory helper, with no personal-account switch or challenge bypass. No OAuth code or completed interactive login was obtained. Bridge status, a fresh transcript push and remote-control readiness remain unpassed. Installation health is a separate verified result.


### Essential 0.7.1 release gate

The complete current-source backend gate passes: **2,589 passed, zero failed, 15 not run**, exactly2,604 selected with six workers and no reruns. The15 not-run cases retain their documented opt-in/runtime constraints; they are not passes. Typecheck, lint, build and89 affected cases also pass. All three repairs have failing-first evidence. The five core desktop-light smokes passed for0.7.0; these repairs introduce no web screen. The single scoped closing review is complete, with no second review. Exact-source packaging, publication and safe installation follow; installed versions are still0.7.0 at this checkpoint. Authentication remains externally blocked.


### 0.7.1 published and installed

Source `498701ab6b703afec7371354d85fd89ac66be9f3` was [published as 0.7.1](https://github.com/gongiskhan/jevellan/releases/tag/v0.7.1) at **10:35:59 UTC**. Both published asset digests match the verified archives. Linux was built from the exact committed source. Darwin contains the current common build with unchanged official 0.5.1 external dependencies: all 444 lock entries and dependency edges, external bytes, current owned bytes, source files and Node ABI 127 matched. The actual extracted Pro CLI and native PTY passed. This is dependency-cache reuse, not a new Darwin native build. Both extracted archives also passed scanning against the loaded sensitive environment values.

Both active devices now run **0.7.1**, with doctor **10/10 each**, Online status, vault sync and no open project-request classification verified at **10:47:15 UTC**. Fresh cold backups and prior applications are retained. All 19 saved legacy thread/PR references and their pull-request delivery were preserved.

27. **Maintenance and recovery:** the expired temporary login form and its parent-owned forward were closed after identity proof; no code or human completion existed. Only the verified owned pending managed login was ended for the essential daemon update. The company browser state remains held. A controller PATH mistake selected older system Git on the member, so the normal updater refused before changing the installation. The first cold backup was retained, the verified service PATH restored, and the original fresh idle/held guards and a new cold backup passed before retrying the normal update. No guard was weakened, native configuration changed or peer process stopped. Initial stale account observations cleared through normal managed-account status checks; they do not prove interactive bridge authentication.

The complete 0.7.1 gate is **2,589 passed, zero failed, 15 not run** from exactly 2,604 selected, six workers and no reruns. The not-run cases are 13 opt-in model evaluations, one opt-in journey and the unavailable Node 20 fixture. Typecheck, lint, build and 89 affected cases pass; each repair was failing-first. The five core desktop-light smokes passed for 0.7.0 and these repairs change no web screen. Exactly one scoped closing review of released 0.7.0 is complete; no second review was run.

Managed bridge authentication remains externally blocked. No status reply, fresh transcript push, remote-control readiness or owner acceptance is claimed. The configured bridge account already matches the intended account; no owner configuration chore remains. Native plugin/statusline actions are optional owner actions, not prerequisites for basic bridge use. Exact owner steps and project-specific live receipts remain private. Optional UI migration/parity, intake, remaining engine work and expanded live/browser coverage remain planned after the essential repair release.


11:00 UTC goal record: the essential patch was published and both installations passed doctor before the daily-use target. The full goal remains unmet because actual bridge authentication/status/push are blocked; no owner acceptance is inferred. Authorized scoped verification continues without interrupting valid checks, and detailed project receipts remain private. No optional feature phase was started.


### Final scope closure

The latest owner wrap instruction ends further investigation/retry, source, release, optional feature and review phases. The remaining real scoped live case is **blocked**, with its work preserved; no deploy-message pass is claimed. Its exact project-specific setup and check evidence is private. The documented checks retain the project environment and their original commands, selection and guards. No special-case environment removal, unowned-process stop, weakened check or forced landing was used. Other live results are recorded with their actual live/simulated/not-run labels privately. The full daily-use goal remains partial, and managed bridge verification remains blocked. Optional work stays planned. No production deploy/rollback message was answered.
