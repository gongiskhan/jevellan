# Without GitHub: run log

## P0 orientation

Live: release-051 is closed by its pushed handoff. Both active devices report Online on 0.5.1. The complete brief, repository instructions, decisions attachment, continuity handover, Projects, loop, mesh and release handoff were read before implementation. PRD.md, PLANING.md and TASKS.md are absent on recheck.

Live: read-only inventory is complete in private `snapshot.md`, with raw receipts in `preflight.json`, `orientation.json`, `open-pulls.json` and `branch-protection.json`. The actual daily inventory route is `/dailies`; the earlier singular route returned 404. Branch protection was refused by the API and remains unknown. Existing work and settings were not changed.

The exact attachment source-location difference is recorded privately in `snapshot.md`. Older continuity rules superseded by the decisions are recorded there. The brief adopts the decisions document's proposals; no additional disagreement was found.

CodeGraph's existing SQLite symbol index was queried read-only first. It predates Projects, so implementation uses targeted source reads. No reindexing, agents, delegation, native-home changes or reference-repository changes.

Tests: not run for this documentation-only phase. The previous release's live journeys and cleanups remain not run. Their clock is closed.

## Clocks

P0–P9 build: 18 hours from the first new commit. Its exact time and deadline are recorded before that commit below and in private `clocks.json`. Release/install has a separate three-hour clock; live checks have three hours from both devices reporting 0.6.0. Neither later clock has started.

First new commit time: `2026-10-19T13:43:10Z`. P0–P9 deadline: `2026-10-20T07:43:10Z`.

## P1 health checks

Implemented versioned health definitions and run receipts, settings v5 migration from v1–v4, a project editor, Run now, and `jevellan health run <project> [<check name>] [--file <path>] [--json]`. Members relay to the state point. Requests use no agent, job, checkout or placement. Steps stop on the first failure, refuse redirects and sign-in headers, inspect at most 64 KiB, and retain only result metadata. The hub keeps 500 runs per check.

Choices: the editor can explicitly run a draft definition before Save, and shows its five latest receipts. Saving still uses the project's single revision. Duplicate check ids and credentials embedded in a URL are refused. No background health polling was added. The deploy display and automatic scheduling follow in P5.

Simulated: **145 backend checks in five files passed**, including settings migration, every refusal and failure reason, bounded bodies, retention, CLI exit codes/file handling, member routing and the real local control route. The exact API refusal fix was first reproduced by a failing regression test, then passed. Typecheck, lint and build passed.

Simulated browser journeys: **four passed**, desktop 1440×900 and phone 390×844, light and dark. Live vision: **eight checks passed**, using `tests/e2e/vision.ts` and its documented dedicated credential. Evidence is private in `p1-vision` and `p1-browser.log`.

Live: **the ERP check passed**. Discovery and coverage are in private `erp.md`; the definition and CLI result are `erp-check.json` and `erp-check-result.json`. The active project's settings are unchanged; application is reserved for the release switch. Production was not deployed, restarted or modified.

## P2 project environment and command placement

Command jobs now declare device tags and checkout or retained workspace execution. Code selects an eligible online work device by resources and active work, reserves the project and device at the hub, and relays only the receipt reference. The executing device fetches its environment from the encrypted vault. Waiting runs retry on sweeps and skip at the nightly deadline or after six hours outside a window. Receipts identify the executing device; remote execution survives coordinator placement changes.

Choices: retained workspaces remain isolated git worktrees until cleanup; per-project job caches live in the installation home. Commands receive pinned-run metadata. Provider credential names are accepted for command jobs and filtered from managed runtime environments so they cannot replace account authentication. Environment configuration allows 200 variables and 100 secret names to accommodate the complete inventory. Vault-to-vault imports return only a saved summary.

Live inventory and value-source receipts are private in `inventory.json`, `secrets.md`, `production-read.json` and `vault-stage.json`. The single authorized read-only production environment read is complete. Missing values remain not set. Exact secret-name promotion and the remaining configuration wait for the release switch because the installed release predates the new schema.

Live staging repair: nonsecret configuration was initially staged as vault credentials, causing the installed release's redactor to over-redact API responses. The values were moved into project variables through revision-checked APIs and their staging entries removed. Genuine credentials remain encrypted. Fresh cold backups preceded normal restarts of the two named Jevellan services with no active turns. Existing threads were retained; no production service changed. Private `staging-incident.md` records the repair and device checks.

The required project task for nightly script entrypoints was created through Jevellan. Its result is recorded privately; this session does not edit or push that project's checkout.

Simulated: **75 backend checks in five files passed**. They cover local and member execution, project/device admission, guards, waiting and expiry, paused projects, retained workspaces, inventory parsing and summary-only credential copying. Typecheck and lint passed. The self-admission, paused-project and credential-name defects each had a failing regression before correction. No screen changed in this phase; the job editor follows in P3. Release and live clocks remain unstarted.

Live repair verification: doctor returned **10/10 on both devices**, each still on 0.5.1. Normal account checks succeeded; the first refresh helper used the wrong empty-request schema and was corrected. Private doctor receipts are `staging-doctor-madrid.txt` and `staging-doctor-pro.txt`.

## P3 nightly command programme

Configured order now governs the nightly window. A scheduled Memory dream finishes or reports its blocker before command jobs start; jobs precede the review in the replacement programme. Review fix tasks use the ordinary queue and never bypass the publication hold. Command jobs pin their main commit at reservation and continue after a prior nightly failure. Weekly items can select weekdays; no selection means every night.

New GitHub workflow jobs and explicit runs are refused. The scheduler-variable switch, watch chains and dispatch operations were removed from execution. Historical schemas remain readable and the UI labels them “GitHub workflow (retired 19 October)”. Existing unfinished workflow receipts conclude skipped without contacting Actions. Command editors expose device tags and retained workspaces; nightly editors expose weekdays.

A command can return `project-job-findings-v1` in `project-job-findings.json`. The coordinator records its bounded, redacted findings on the receipt and creates goal-linked fix tasks with stable request ids. Remote cancellation is durable and observed by the executing device. These use the existing task autonomy and goal rules.

The revision-checked programme migration preserves goal and daily identifiers, moves the review under Resilience, marks the prior review goal done, activates the legal goal, keeps Security paused, disables old workflow jobs and adds the disabled Monday model check. It does not recreate a nightly deploy. The full workflow translation and area map are private `workflows.md` and `area-map.json`. Live configuration and manual night results remain pending the release switch and the required project script task.

Simulated: the affected backend sets passed for command pinning, ordering, weekdays and clearing them, findings, remote cancellation, shared memory, preserved goal/daily identifiers, retired history and all 39 legacy merge cases. The obsolete workflow merge hold first failed its new regression, then passed after removal. The device test was updated to expect the required waiting receipt. Typecheck, lint and build passed.

Simulated browser journeys: **eight passed**, two journeys in all four layouts. Live vision: **20 checks passed** through the dedicated vision credential. Evidence is private in `p3-vision`, `p3-screenshots`, `p3-screenshots.json` and the `p3-*.log` receipts. This is affected verification; the full release gate remains P10.

## P4 threads land on main

New project settings default to land delivery and migrate automatic merge to automatic landing, dropping the retired isolation and required-check settings. Existing threads default to pull-request delivery and retain it. Landings run configured path checks and the smoke check after rebase, record Jev's l-v1 route, optionally run detached verification, then squash or preserve commits under the hub publication lease. The candidate receipt precedes the exact leased push, and the remote backup is removed only after landing. Work stays in isolated worktrees.

Owner actions provide Land now and Land instead. Conversion requires the thread's own publication ledger and the current token's pull-request author; it synchronizes the latest head before closing. Branch continuation checks origin and refuses another author's open pull request. Settings, Overview groups, cards, branch input and landing Why use these records.

Choices: old merge corrections remain canonical history and are translated into the landing packet's last-eight correction context, rather than rewriting old records. Fixture defaults can explicitly exercise pre-switch delivery; production defaults remain land. Historical vault workflow definitions restore disabled, while new workflow jobs remain refused. A private source-state discrepancy and the script task's publication receipts are recorded in `workflows.md`.

Simulated: **21 landing cases passed** across the affected sets, including check selection, exact repair messages, three failures, rebases and moved-main loops, two-device lease serialization, squash and merge commits, backup deletion, lost acknowledgements, continuation, both branch refusals and owner conversion/override. The other affected schema, settings, vault, preset and legacy merge sets passed. Receipt reuse, stale questions, early night holds, the final night fence and command credential filtering each first failed a regression, then passed after correction. Typecheck, lint and build passed.

Simulated browser journey: **four layouts passed**, including settings, Why, owner overrides, conversion, landed groups and the branch form. Live vision: **20 checks passed** through the dedicated test credential. Evidence is private in `p4-*.log`, `p4-vision` and `p4-screenshots.json`. Initial fixture and selector failures were corrected. A Claude fixture refusal in the unchanged rigging path is retained for P10 classification; the final journey uses the Codex fixture. This is not a full release gate or the owner's acceptance.

Live: the required project night-script task is now published through Jevellan. Its normal merge request timed out, and a subsequent read confirmed done/merged. No direct project push was made by this session. Read-only source verification found remaining adapter integration work, recorded privately in `night-integration.md`; live activation and actual nights remain pending. Installed devices remain on 0.5.1, and the release/live clocks have not started.

## P5 approved deploys and health rollback

Implemented the versioned deploy registry, coordinator-only CAS writes, an in-place owner message, exact commit/revision approval, Not now, failure/retry, and confirmed manual rollback. Command jobs require an internal approved deployment reference. The selected application and its trusted command driver have separate pins, so an older rollback target can predate the driver. Jobs use isolated homes, command-scoped Git authentication and the normal machine identity.

The before-health baseline is taken after actual job admission. Durable monitors check at one and five minutes, repeat a failure after 30 seconds and count only that repeat. A before-pass/after-fail transition requests rollback; migration-path changes require the urgent owner decision. Already-failing checks do not trigger rollback and do not resolve unhealthy work. Unknown release completion remains unknown and monitored. Outcome delivery, questions, thread resolutions and mirror updates recover from interrupted acknowledgements without repeating a release.

Choices: a retry needs fresh production evidence after an uncertain release. A later open message absorbs a rollback's work instead of creating duplicate open questions. A missing Resilience goal is created with propose autonomy; existing goals retain their choices. Desktop eligibility is disclosed before approval, supports alternative signing groups, and builds after the primary health checks pass. Rollback cancels an optional desktop job holding the project slot. An explicit suite job id supplies exact-pin status. Unchanged messages fetch neither main nor HTTP health. Deploy lines keep their line breaks and use the project timezone; urgent push text has a bounded larger payload. The command timeout ceiling is 600 minutes for explicitly configured multi-pass jobs; the nightly window still bounds night work.

Simulated: **186 affected backend cases passed** in the final set, including schema, hub/member, job, notification, mirror, landing and nightly compatibility. Typecheck, lint and build passed. The final browser journey passed in **four layouts**, with **16 live vision checks**. Earlier local fixture/selector failures were corrected. A relay retry loop was interrupted only after proving the test processes' ownership, then corrected; the final placement cases passed. Dedicated regressions reproduced admission timing, missing release evidence, continued-thread landings, failed-work carry-forward, duplicate approval, desktop disclosure, durable outcome delivery, goal linkage and fresh image/baseline evidence before their fixes.

Private evidence: `p5-close-backend.log`, `p5-layout-last.log`, `p5-vision-last`, the `p5-*-red.log` receipts, `deploy-preflight.json`, `deploy-baseline.json` and `deploy-baseline-source.json`. Working-tree secret scanning and the private identifier diff check passed before the checkpoint.

Live integration is **blocked, not passed**: the private executor task was published through normal project work; its IAP preflight failed after local setup checks and registry authentication. There was one VM contact invocation and no production change. A locally identified executor argument correction is proceeding through the same project task. The VM check will not be repeated in this run. Installed devices remain 0.5.1; release and live clocks are unstarted. Runtime/vision credentials are not borrowed from native homes, and no owner acceptance is claimed.

## P6 coordinator handoffs and session reset

The coordinator-only `jevellan_handoff_write` validates bounded versioned input and refuses a save until every unaccounted owner message is listed, including late events forwarded from another device. The hub writes immutable JSON and Markdown beside the journal days and lists them in INDEX. Idempotent tool retries return the same handoff; changed replays and other devices are refused.

Nightly and context triggers wait for idle with no owner work queued. The coordinator threshold defaults to 70 percent and migrates independently from the previous compaction setting. Native coordinator compaction is 95 percent; thread compaction and checkpoints retain their settings. A completed handoff rotates the next native session. New owner work postpones rotation until another valid handoff covers it; a missing save retries rather than silently completing. Durable metadata recovers an interrupted rotation. The coordinator cold-checkpoint launch path was removed.

Fresh context contains the full latest handoff, numbered Waiting on you items, the live thread registry and open deploy message, the memory brief and note titles, then searchable earlier transcript paths. Choices: those paths are the project journal day files, which remain available after device moves. Owner instructions and the notebook follow the required context sequence. Receipt digests bound local recovery metadata without storing another unbounded owner-message list. A closed authenticated coordinator route requests an idle save for the release switch.

Simulated: **167 affected backend cases passed** across 12 files; typecheck, lint and build passed. The first two missing-message journal regressions failed before implementation, then passed. A later broad run exposed compatibility expectations for the new schema, prompt and retained PR fixture, which were corrected. The final browser journey passed in **four layouts**, with **eight live vision checks**. Its initial navigation selector failure is retained as a failure. Evidence is private in `p6-final-backend.log`, `p6-layout-label.log`, `p6-vision-label`, `p6-screenshots-label.json` and the earlier receipts. Installed devices remain 0.5.1; the first installed handoff is not run.

The executor SSH argument correction from P5 has also been published through its normal project task. Its fake/parser verification passed; the corrected live IAP connection remains unverified and was not repeated.

## P7 cleanup settings

Configuration now carries `cleanup-settings-v1`: log retention of 14 days/5 GB, evidence of 30 days/10 GB, landed or resolved worktrees of 3 days, job workspaces of 2 days, and a 50 GB free-disk floor. Choice: the two unspecified size caps default to 20 GB each. All limits are editable in Settings → Cleanup. The oldest eligible items are removed for age, capacity or the floor. Unlanded worktrees, running or attached work, process receipts needing recovery, uncommitted changes, registered checkouts and device-protected paths remain protected.

An idle device maintenance reservation covers inventory and deletion. Hourly attempts and Clean now retain a versioned per-device receipt; a bounded heartbeat summary keeps the last result available when a device is offline. The API forwards only the closed owner-authenticated operation, with no client paths or commands. Files are rechecked before removal. Git removes registered worktrees; current daemon logs are truncated in place. Native account homes, backups, vault, memory, ledgers and journal paths cannot enter this policy.

Choices: cleanup starts on its hourly timer instead of running at installation. Missing authoritative inventory defers removal. Command logs use bounded redacted local archives; durable receipt tails and journal history stay. Owner configuration save retries from before the additive defaults still recover their original result; they do not rewrite old revisions.

Simulated: **132 distinct affected backend cases passed** across the final sets (131 in the broader set, plus the member forwarding case in the final affected rerun). These cover the four categories, capacity, the floor, never-removed paths, running thread/job deferral, a 30-day unlanded tree, an old resolved tree, unchanged ledgers and checkout, rechecks, hourly timing, truncation, redacted member archives, protected paths and cross-device receipts. The corrected API regression first failed 404; the old configuration receipt regression failed before its fix. Typecheck, lint and build passed.

Simulated browser journey: **four layouts passed**, with **eight live vision checks**. Initial fixture URL/control-route and busy-device expectations were corrected and retained as failed receipts. The UI retries only after the fixture's active settings work releases its maintenance reservation. Private evidence: `p7-close-backend.log`, `p7-final-extra.log`, `p7-layout-complete.log`, `p7-vision-complete` and `p7-screenshots.json`. The two installed machines remain 0.5.1; actual-device cleanup is not run, and the closed release-051 cleanup was not restarted.


## P8 Worktrees, the global limit and preset 3

Current thread creation and restart accept Worktrees only. Main preparation/publication, mail and reservation execution, tools and controls are removed. Their versioned historical documents and ledger rendering remain readable. The retired feature suites were replaced by regression coverage for refusal, current tool scopes, history and untouched checkouts. Existing pull-request threads keep a separate saved automatic-merge choice when project settings switch to land delivery.

The global limit defaults to six and is editable from one to twenty in Settings → Projects. Hub transactions count all live indexes and short admission claims across projects and devices. The global-full sentence takes precedence over a project limit without claiming a refused slot. A receiving worker also checks current admission. Preparation, native turns and publication require the exact live-index acknowledgement; an unavailable authority leaves new work waiting. Lowering the limit preserves work already running.

Preset 3 prepares a durable settings snapshot before saving it, recovers a lost reply without rewriting later owner edits, preserves instructions, goals, daily identifiers, nonempty risk guidance and registered paths on both devices, and configures land delivery, the path checks and command jobs. Choice: existing per-device limits stay unless explicitly supplied. Area mapping and the private port integration receipts stay in `area-map.json`, `night-integration.md` and the task receipts.

Command jobs can emit a bounded versioned delivery outbox. The daemon imports dev files into Library, keeps private gate data in isolated job caches, publishes base-only continuation branches and creates ordinary goal-linked tasks idempotently. A saved task identity carries the required gate through restarts. The trusted pinned checkout receives a private input copy inside its own workspace, compares exact commits and produces a bounded result; rebases rerun it and gated deliveries preserve merge commits. Cache receipts contain observed task/run/delivery identity and keep the latest 1,000 entries; full history stays in ledgers and hub indexes. Recovery imports a completed outbox without rerunning the command. Ordinary agent read guards exclude private job paths; this uses the existing best-effort hooks, not an operating-system sandbox.

Simulated: affected backend sets passed, including atomic multi-device admission, stale acknowledgements, outage waits, removed tools/history, preset lost replies, legacy merge compatibility, outbox hash/path checks, crash recovery, gated landing failure and a restart preserving the required gate. Typecheck, lint and build passed. Broader checks exposed a legacy PR fixture that saved new land defaults; its explicit PR setting was corrected. A restart expectation now includes the required Worktree choice. Source-delivery receipt coverage first failed before its schema change. The final receipts are `p8-contract-close.log`, `p8-remote-receipt-red.log` and `p8-contract-green.log`; earlier failures are retained.

Simulated browser journeys: **eight passed** across the four layouts, with **eight live vision checks**. Images and judgements are preserved in `p8-screenshots`, `p8-screenshots.json` and `p8-vision`. The Ekoa adapter follow-up remains normal project work, with its publication and concrete contract checks recorded privately; actual legal measurement, installation and live activation are not passed by these fakes. Both installed devices remain 0.5.1. Release and live clocks are unstarted.


## P9 owner messages, prompts, quiet hours and OAuth

`jevellan project send` authenticates through installation control and durable owner delivery. Source labels survive forwarding, history and handoff accounting. A saved first request preserves its identity and time across retries; changed content or labels are refused. Waiting reads the hub journal and matches the completed consuming turn within its source device ledger. JSON has the specified keys; a timeout exits 2 while work continues. Choice: without waiting, turn and reply are null. Prompt-kind owner commands default old records to shell, render Copy only with the Claude app device sentence, and are refused by both terminal execution boundaries.

Notifications now carry a level and quiet hours, with migrations from older settings and vault definitions. Holds survive restart and produce one project summary when hours end or are disabled. Urgent production questions bypass the hold and the ordinary level. Preset 3 enables the requested Lisbon hours. Portable definitions use version 4 and retain the independent legacy PR policy. Default notification objects are fresh for each project.

The hub implements OAuth discovery, dynamic registration, PKCE S256, owner-bound expiring state, callback retry and an encrypted client/token record. Refresh rotation is serialized and saved before the access token is returned. A settings save during sign-in wins over the delayed callback. Invalid saved data blocks the connector and can be replaced through Connect; malformed response failures omit their bytes. Settings offers Connect to Ekoa, clears callback codes from the browser URL and retains existing token compatibility. The existing owner-authenticated relay and mirror markers keep task updates in place.

Integration choice: a successful job gate can return an absolute expiry. Routing persists it, rejects expired gated caches, reruns fixed gates after rebases or a later request, and checks again immediately before the main push. Owner approval does not extend it. An already-pushed candidate still recovers a lost acknowledgement before considering a new push. The required late-push regression first landed in a disposable repository, then passed after the fence; decision, pre-push and cached owner-wait cases now refuse expiration. The managed adapter publication is recorded privately; no project source was pushed directly by this session.

Simulated: **216 distinct affected backend cases passed** in the final sets across 14 files; typecheck, lint and build passed. These include actual local-command HTTP/coordinator waiting, arguments/JSON/timeout, idempotency, source labels, prompt refusals, quiet summaries/disable/urgent/DST, migrations, per-project defaults, fake OAuth discovery/registration/PKCE, concurrent rotating refresh, failed vault writes, callback retries and settings races. The portable policy and shared-default regressions first failed. Earlier fixture/default expectations and invalid fake session/id failures remain recorded. Evidence: `p9-final-backend.log`, `p9-deadline-green.log`, `p9-*-red.log` and earlier receipts.

Simulated browser journey: **four layouts passed**, with **16 live vision checks** and preserved screenshots in `p9-screenshots`, `p9-screenshots.json` and `p9-vision-settings`. The initial journey incorrectly reloaded the project page after Save; it was corrected to reopen Settings. Live OAuth metadata discovery succeeded. Actual registration, owner sign-in and live mirror updates are **not run**, pending installation and the sole owner step in `owner-step.md`. A private task diagnostic incident and its corrected test environment are recorded in `diagnostic-incident.md`; no diagnostic value is published here. Installed devices remain 0.5.1, and release/live clocks are unstarted.
