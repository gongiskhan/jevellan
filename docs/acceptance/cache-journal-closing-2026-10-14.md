# Cache and journal handoff — 14 October 2026

## Remaining owner steps

No repeat sign-in, token, membership, migration or power command is needed. The separate Ekoa actions remain ordered at the top of [the activation handoff](loop-activation.md): specific draft approval; PR208 refresh/owner merge and two clean watch nights before the owner changes the scheduler; the owner's automatic-merge choice; physical-phone and owner acceptance. These are separate from this cache/journal delivery.

## Delivered

Parts1–3 are pushed on main: passive cache receipts and UI; a deterministic, ledger-derived Markdown journal with authenticated read-only member mirrors and CLI rebuild; cold checkpoint prompts, durable history and earlier-transcript links. The actual live mirror check also found and fixed historical calendar replay and cross-project sweep starvation. A real timezone change preserves earlier journal bytes, rebuild is byte-identical, and Madrid receives the change automatically in2.451seconds. Both private test daemons are stopped normally, with their homes and histories retained.

The release source is8474079ac63915185270b3a415e747b86140ee86. Its runtime source is identical to834a258d; the later commit updates six strict regression fixtures and documentation. Checkpoints ship **off**, minimum **40000**. Cache windows remain **provisional Claude60/Codex10minutes**: live calibration established no replacement. No Conversations, memory/dream, merge-gate or Ekoa CI behaviour changes.

Affected simulated checks pass:220 Part1 cases,220 Part2 cases,158 Part3 cases,86 overlapping final cases,26 journal-repair cases and112 cases in the six corrected fixtures. These overlap and must not be added as a unique full-suite total. Each part has four-layout browser coverage with12,20 and12 clear dedicated live vision verdicts respectively. Typecheck, lint and production builds pass. The one closing crucial-issues review ran; no second review ran. The journal defect was found by subsequent live verification. Complete-home rollback/recovery fixtures pass on Mac and Linux; live rollback is not run.

## Live outcome

The original live clock is06:36:41.379–09:36:41.379UTC. It is not reset or extended. The initial L1 fixture produced sub-60000 contexts and cannot calibrate defaults. The corrected fixed-input attempt records these valid follow-ups:

| Idle minutes | Claude hit ratio | Codex hit ratio |
| --- | ---: | ---: |
|3|38.73%|Startup failed|
|15|38.33%|58.40%|
|55|38.33%|18.80%|
|70|3.21%|Startup failed|

Every valid initial context exceeds60000 native tokens. All six ratios fall below0.8, and two follow-ups are missing, so **L1 fails**. One Codex startup reports a model-cache EOF; its cause is unestablished. These results do not support a cache-lifetime or shared-prefix explanation.

**L2 fails before the checkpoint steps.** Its CSV seed times out after two Madrid launches fail on the private driver's omitted Codex path. After repairing only that test path, an unchanged-clock retry runs the CSV thread but ends on ECONNRESET before checkpoint steps. The original failures and wrapper failure remain evidence.

**L3 fails the checkpoint assertion.** Its initial context is32352tokens and actual idle gaps are4.443,34.296,25.097 and3.296seconds. An intervening coordinator turn keeps these resumes warm. The card answer25 is delivered, real [sandbox PR15](https://github.com/gongiskhan/jevellan-live-sandbox/pull/15) passes checks and is merged through the authorized owner UI; its thread reaches Done. That completion does not convert L3 to a checkpoint pass.

The [cold receipt summary](cache-live/2026-10-14/cold-summary.json) covers53 passive turn records from22 sessions identifiable in the three receipts: Claude13 cold starts/739013 recorded cold-write tokens; Codex3/0 recorded cold-write tokens. All use the one-minute test override. These classify idle thresholds; they do not establish provider cache expiry or billing. Four other cost-receipt sessions have no matching passive records and remain uncounted here.

[Usage](cache-live/2026-10-14/usage-summary.json), deduplicated by opaque session key: Claude12sessions,484499input/98555outputtokens, reported estimatedUSD15.9425704; Codex14sessions,6425566input/37413outputtokens, all costs unknown. Summed session time is10.9004Claude/28.2518Codex minutes; sessions overlap and idle wall time is excluded. Vision and infrastructure costs are unknown. **Checkpoint-versus-cold-resume savings are not measured**, because no qualifying live checkpoint occurred.

## Closing verification and release

The first full backend on4c4301b8 fails:2113passed,16failed,7skipped. Six failures are outdated cache/journal fixture expectations, seven are Pro resource-guard refusals, two are process-command timeouts, and one is a move handover assertion. The latter differs from the earlier baseline's missed-heartbeat assertion; no unsupported claim that it is the same failure is made.

The first production-built full browser run onb22c5fc6 fails:199passed,40failed,65notrun. Its313 fresh dedicated vision verdicts are clear, but later project cases, including cache cases, have no fresh vision evidence in that run and cannot be called passes. [The exact failure list and evidence hashes](cache-journal-full-browser-first-2026-10-14.json) are retained. Earlier port-collision and test-mode build attempts are separate failed driver evidence.

The corrected834 full backend is interrupted after its six fixtures become superseded; its partial failures and SIGINT receipt remain. Madrid's private Basic Memory test link was broken; pinned0.22.1 is installed in a new test-only folder and the link is repaired without changing native homes. The unchanged real Basic Memory hub suite then passes all9cases in475.85seconds. The final834 full browser closes failed at10:00:12UTC:195passed,44failed,65notrun; all307 fresh dedicated live vision verdicts are clear. Its actual source identity is retained in [the final browser receipt](cache-journal-full-browser-final-2026-10-14.json). All484 tracked runtime/build/dependency/browser-spec files match847 exactly, as recorded in [the source qualification](cache-journal-browser-source-2026-10-14.json). Cache cases remain unverified by this broad run because their project group skips them. The direct847 CACHE1/CACHE2 run closes passed at10:06:34UTC: all8 cases pass across4 layouts, with24 fresh clear dedicated live vision verdicts. [The exact receipt](cache-journal-browser-final-affected-2026-10-14.json) binds48 newly copied screenshot/verdict artifacts in a separate folder, preserving the earlier dirty evidence. Two earlier bootstrap failures start no journey and remain retained; assertions and timeouts are unchanged. The current847 full backend is still running; its final verdict remains pending.

Both847 platform archives pass103 selected source/compiled/manifest hashes and10 web-asset hashes, actual0.3.4 CLI/native PTY and zero prohibited paths. The owned unpublished034 draft is staged with both complete platform files and matching published-asset digests. The first Linux upload began before its local transfer finished and GitHub rejected the changing request body; after the transfer completes, Mac/Madrid SHA256 match and the same draft upload succeeds. Published releases are untouched. Publication and normal-service activation are pending until closing checks finish. Pro remains033 and members032. Fresh Pro readiness shows no running project threads and AC sleep0. Complete cold snapshots and prior versions will be retained during update. Pro disk space is below the unchanged20GB thread-placement guard; no guard is relaxed. Madrid remains available for placement.
