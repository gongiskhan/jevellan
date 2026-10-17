# Projects parity, October 2026

## Clocks and scope

- Orientation started: 2026-10-17T14:51:52Z.
- Build clock: 2026-10-17T14:59:21Z to 2026-10-18T04:59:21Z, from first commit 3d8e975b. No new feature phase starts after 2026-10-18T02:59:21Z (03:59 Lisbon).
- Live clock: not started. It starts at installation of 0.5.0 and ends three hours later.
- Baseline: da6a9bc96c9b963bb5b9bb2de609dbcddfa5dd06, main, source 0.4.1.
- Machine: Goncalos-MacBook-Pro.local. The actual local doctor identifies its Pro hub on 0.3.6. The separate Madrid 0.4.1 hub and Pro's retained Madrid member are distinct installations. Installation scope will follow doctor and the brief's current-machine rule; no unrelated installation is updated.
- Specification: root BRIEF.md, saved in full and ignored by Git. It supersedes conflicting older brief/plan decisions; untouched behavior stays.

## Phase log

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Reference, inventory, plan, roadmap and clocks | Pushed | Live checkout and local doctor; no product code changed |
| 1 | Settings v4, page, pause/archive and daily cap | Pushed 15d0a138; vision blocked | Simulated: 429 distinct backend cases, 8 browser journeys across 4 layouts, typecheck/lint/build and working-tree secret scan pass. See phase-1/. Full suites remain phase 10 gates. |
| 2 | Coordinator instructions, answers, cards, proposals and settings | Pushed a03f98af; vision blocked | Affected backend cases, eight unique four-layout browser journeys, final PAR2 repetitions, typecheck/lint/build pass. See phase-2/. |
| 3 | Overview, resolution and thread actions | Pushed6d15b8f9; vision blocked | Affected backend/API/remote cases pass. Seven unique journeys pass in every layout across recorded runs; final settled Overview captures pass. Typecheck/lint/build/secret checks pass. See phase-3/. |
| 4 | Automatic pull request fixes | Pushed28efaecf; vision blocked |92 affected backend cases and8 browser journeys pass across four layouts; see phase-4/. |
| 5 | Account waits, placement bounds, escalation and usage | Pushed bfb9dc8a; vision blocked |193 affected backend cases and4 browser layouts pass; see phase-5/. |
| 6 | Web push | Source verified; pushing |142 affected backend cases and all4layouts pass; vision not run. See phase-6/. |
| 7 | Library, attachments, environment and scoped rigging | Not started | Not run |
| 8 | Compatible endpoints | Not started | Live credential optional, not requested yet |
| 9 | First-run setup | Not started | Not run |
| 10 | Docs, cleanup, suites, review, release and LP1–LP9 | Not started | Not run |

## Orientation evidence

Live: checkout clean on main at the specified baseline; fetch confirms origin/main matches. AGENTS.md and the required Projects, loop, decisions and Madrid acceptance documents were read. PRD.md, PLANING.md and TASKS.md are absent. CodeGraph is present and is used before code exploration. Native memory registry has no matching Jevellan entry. Existing shared handoff was read without modifying Basic Memory.

Live: local doctor reports Node22, APM, Basic Memory, Claude, Codex, daemon, hub and Jev available. Installed Pro version is 0.3.6. Accounts are historically Ready but need freshness checks; this is not live provider acceptance. Doctor's Git check is missing with shell AppleGit2.39.5; compatible Git must be available for release readiness. No runtime/service/account or other repository was changed.

Simulated: documentation-only phase checks validate roadmap JSON, the required phase/out-of-scope entries, ignored brief and whitespace. Backend/browser/vision suites are not run for this documentation checkpoint; changed behavior and full-suite evidence follows in its phase. No owner acceptance claimed.

## Decisions

846. The 17 October Projects parity brief becomes the authority for this run, replacing the older phase sequencing and delivery scope, rather than redoing completed unrelated work. The run follows ordered phases, a 14-hour build clock from its first commit, a separate 3-hour live clock and one closing crucial-issues review. Pro is the observed current machine/hub; the brief's Madrid installation description is historical. Release target 0.5.0 is unchanged.

847. Appendix A is a frozen owner-supplied parity reference. The new reference document restates it in plain prose and does not claim an independent current product audit. No new source behavior is delivered by orientation.

848. Settings v4 replace threadRules and the old modal; v1–v3 settings/v1 vault definitions migrate without resetting unrelated choices. Project instructions now store up to16,000 characters. Execution of the later placement/fix/environment/notification settings follows its own phase.

849. Pause/archive fence new work while retaining queued events/messages; resume sweeps it. Calendar-midnight admission counts durable starts and exempts replacements. Project environment secrets extend encrypted envelopes to the specified namespaced keys, with member-only credential fetches and metadata-only owner responses. See phase-1/README.md for regressions and evidence.

## Verification and live acceptance

Each feature phase requires backend regressions, typecheck, lint, affected four-layout browser journeys and tests/e2e/vision.ts. Dedicated missing credentials are recorded as blocked; real provider sessions and physical-phone acceptance remain distinct. Full backend/browser/build/secret suites and the one permitted closing review belong to phase 10. LP1–LP9 use only jevellan-live-sandbox, restore changed settings and retain sanitized receipts here under live/.

## Local run prerequisites

Live: Homebrew Git 2.56.0 is installed for the missing compatible Git capability. No shell profile or login was edited. A temporary AC-only caffeinate process keeps this run awake; system power preferences are unchanged, and the process is stopped at closing. Source/test operations use Node 22.22.0. The installed Pro service remains on its existing version until phase 10.

## Phase 1 push and readiness refresh

Live: phase 1 is pushed as 15d0a138. Its normal pre-push history scan passed. The first attempt waited in Homebrew Git's macOS Keychain helper; the retry used the already signed-in GitHub CLI as a command-local credential helper, with no global Git or login changes. The required scan stayed enabled.

Live: the installed Pro UI refreshed both Claude accounts and the Pro Codex account to Ready. Madrid's Codex status still says Needs login. This is account readiness metadata, not a provider-turn acceptance result. Ekoa work, pull requests and settings were not changed. The installed service is still the earlier version.

850. The brief's thread-auto-fix event uses kind both for its event discriminator and for checks/conflicts/comments. Those cannot coexist in one discriminated document. The event keeps kind=thread-auto-fix and names the latter field fixKind. This replaces only that conflicting field name; the trigger rules and copy stay as specified.

851. Project instructions now lead the coordinator's fresh context and are snapshotted on new threads in their system append, replacing the old task-text rules append. Existing task text is preserved. Quick-answer outcomes invite an answer in chat. The launcher puts its stable journal hint before the session append so the owner's instructions remain last.

852. Propose mode is enforced when owner-request tasks are created. Owner-message-only bridge tools release proposals and change the listed settings. Settings changes retain a versioned original request before applying it, so retries do not append twice. Chat Undo compares and restores just its field through a field-only owner request and the existing hub revision check. This replaces notebook-only enforcement for the supported owner preferences.

## Phase 2 checkpoint

Simulated: instructions/snapshots, answer routing, live cards, Propose, owner-turn fences, retry-safe settings and field-only Undo are implemented. The broader154-case run passes153 with one new-record expectation failure; that unchanged PJ2 case passes after its explicit task-id expectation is updated. Final settings/tools/prompts/UI run:62 pass; further UI run:43 pass (overlap). Eight unique browser journeys pass in four layouts, with another final PAR2 pass in each. Typecheck, lint, build and whitespace checks pass. Model vision is not run for the missing dedicated credential;24 receipts say so. The fixture process-cleanup warning remains a closing-check concern. Source is not installed and the live clock has not started.


## Phase 2 push

Live: phase 2 is pushed as a03f98af10615ead5b85062167b027534b4b4aa3. The normal pre-push history secret scan passed. No source installation or live clock start occurred.

## Phase 3 decisions and work in progress

853. The six Overview groups replace the Running/Concluded presentation in Decision52. Resolution preserves thread identity, branch and worktree, withdraws open thread questions and records the owner or inactivity reason. Reopen and accepted messages clear the resolution. Decision834's existing continuation remains. Landing and fixable facts use the existing owner-local thread sidecar and a new ledger event for each changed index, preserving immutable event-id publication.

854. Owner pull request actions need review-comment reads before automatic fixes can be implemented. The three read-only GitHub reads and the versioned comment batch therefore land as phase3 prerequisites. They share GitHub's request budget and the awareness cache. A changed PR is re-read after the cache window, so a cache hit cannot permanently hide a new comment. Read failures preserve the check/conflict event path. Automatic rounds, quiet-window triggers and give-up decisions remain phase4 work.

855. Publish uses the existing admission, pending-turn, verification and managed publication paths. A versioned owner action receipt binds its client id to the request. Accepted work actions atomically retain their request digest with the pending turn, so a restart between acceptance and the HTTP receipt cannot publish twice. No agent merge tool or direct agent push path is added.

Simulated checks are in progress. The first valid regressions demonstrate missing grouping/projection/actions, the cache-window comment loss, the accepted-Publish retry gap, and comment-read errors suppressing check events. One initial decision fixture had only one option and was corrected to the supported two choices. One initial error-injection fixture used a string instead of the required regular expression; the corrected regression also fails before the repair. An initial PAR3 setup waited for unrelated global activity and was stopped; it now waits, with a deadline, for its own preparation thread. These stopped or invalid attempts are not passes.

## Phase 3 checkpoint

Simulated: affected backend, schema/API, GitHub budget and two-daemon owner-action checks pass as recorded in phase-3/README.md. Seven unique browser journeys pass in each of the four layouts across affected runs, with final settled Overview repetitions. All88 vision receipts say not run for the missing dedicated test credential. Typecheck, lint, build, whitespace and working-tree secret checks pass. Harness output-folder, interception and initialization failures remain recorded, along with the existing process-group cleanup warning. No installed release, live-provider acceptance or owner acceptance is claimed. Phase4 has not started.

## Phase 3 push and phase 4 start

Live: phase3 is pushed as6d15b8f9. The normal history secret scan passed. Phase4 starts with the same-thread checks-to-fix-to-publication regression, before implementation. No installed source changed and the live clock is unstarted.

## Phase 4 decisions

856. Decision68's coordinator-led checks/conflict response becomes the brief's code-driven automatic loop. Existing PR update events remain, while the coordinator is instructed to message about PRs only on the owner's request, when automatic fixes are off, or after the limit. One eligible fix is queued at a time in the same thread and uses existing admission, verification and publication. Owner actions do not spend automatic rounds.

857. Attempts have durable ids, queued provenance and stable event ids. A round and its comment delivery are charged when a runtime accepts the turn, so disabling a queued, unstarted fix cancels it without spending a round. Internal verification keeps the same origin and round. The daemon supplies provenance; the model's report input cannot forge it. Comment turns take at most15 records to stay within the40,000-character pending text allowance. Existing cached reads and the500-id cursor remain; same-timestamp batch coverage confirms they retain the remaining comments. Recovered CI withdraws an obsolete cap question; a stored question sequence permits a later failure to ask again.

858. The earlier coordinator-abilities brief's unconditional failed-check-log instruction also yields to BRIEF.md P4.4. Its older GitHub-awareness sentence is removed so it cannot contradict the new automatic-fix rule. A prompt regression fails before that removal.

859. The simulated backend harness uses two workers and a60-second default test/cleanup allowance. This makes the phase1 command-line allowance explicit after the four-turn owner-action case also exceeds15seconds in isolation and then passes unchanged in35.91seconds. Explicit120/300-second integration bounds stay; no product timeout, safety guard, request-budget assertion or browser/live deadline changes.

860. A phase4 navigation regression exposes the PWA's eight-second navigation fallback leaving a recovered hub on the manual-only reconnect page. The public offline page now probes transport health without reading or caching owner documents, retries at5–30seconds only while visible, and retries immediately when shown or the network returns. It reloads once when reachable and keeps Try again. Three regressions fail before the repair and pass afterwards. The clock is unchanged.

## Phase 4 checkpoint

Simulated:92 affected backend cases pass across eight files. Both browser journeys pass in every layout (8/8), including settled chat/publication and automatic recovery from one503 navigation without an online event or owner click. All20 dedicated vision receipts are not run for the missing test credential; selected final captures are directly inspected. Typecheck, lint and build pass, with the existing bundle warning. Failed attempts and the recurring fixture cleanup warning remain recorded. The final working-tree secret scan passes; the mandatory history scan gates publication. No installed source, Ekoa work, native home or other installation was changed; the live clock is unstarted.

## Phase 4 push and phase 5 start

Live: phase4 is pushed as28efaecf after the normal history secret scan. The checkout is clean before phase5; no installed release changed. Phase5 starts with bounded placement and account-wait regressions. The existing coordinator already re-evaluates an unavailable plan on sweeps; that path will receive coverage rather than a claim of a new repair. Build and live clocks are unchanged.


## Phase 5 decisions

861. BRIEF.md P5 replaces unconstrained automatic placement with the owner's allowed models, a mapped minimum effort and project guidance. Owner-fixed fields win their matching constraints. The ephemeral packet is placement-state-v3; optional reason and constraints extend placement-v1. The 12,000-token bound still redacts first, then drops reserved paths, trouble and active threads in that order.

862. The old failed/synthesized-blocked result for an account gap becomes a durable admission wait. No runtime acceptance means no turn consumed and no owner message removed. Existing pending turns and owner messages survive sweeps and restarts. A known expected reset is the earliest known account's latest applicable cooling/usage boundary; unknown or expired usage still requires a fresh account observation, never assumed quota. The existing coordinator unavailable-plan sweep remains and is covered rather than presented as new.

863. A mid-turn usage limit cools the account and durably queues the brief's continuation, without a blocked report or coordinator alarm. Existing a-v1 account choice and session-home isolation choose another eligible saved account. The coordinator gets one uncounted retry per durable event batch before ordinary failure handling.

864. A long/unknown wait may ask p-v1 again, excluding the current model and fixing device/isolation; an owner-fixed model stays. A successful move marks that wait so it cannot move repeatedly. Follow-up routes already applied are not re-applied on retries, preserving the new model.

865. The third publication verification attempt and the next turn after a real blocked report ask for placement with bounded trouble and no lower effort. Model and effort both fixed prevent escalation. An unchanged model/effort retains its eligible current account and native session, recorded with the optional account-choice source session; a changed placement gets fresh context. This extends Decision16 continuity rather than recording a fabricated new account choice.

866. Usage is a replayable projection of canonical coordinator, thread and auxiliary-session ledgers. New starts freeze model/account labels; legacy auxiliary records without labels honestly say Unknown account. Each device writes only its own project calendar days and lifetime thread totals. The prescribed colon-separated document id is retained; the hub's IdSchema requires a SHA-256 storage key. An optional aggregate ledger watermark rejects older delayed snapshots. The API sums devices and project-time-zone calendar dates, including DST. Costs remain reported/estimated/unknown, with unknown turns explicit.

867. Phase5's wider schema check caught a stale Phase4 test derivation: ThreadReportFields now has daemon-only fix provenance. The derivation now explicitly omits fix, as the actual bridge input already does; the existing assertion refusing model-supplied fix metadata remains. No product guard was removed.

868. Two valid before-fix regressions exposed startup/launch recovery edges: account exhaustion during a-v1 selection returned no wait metadata; offline publication of rebuilt usage could reject Projects readiness. Both now retain their state for retry. Browser initialization under the concurrent full backend run exceeded the unchanged 60-second server deadline; it is not counted as a pass.


869. A failing three-day/2,000-rows-per-day member regression exceeded the mesh's existing2MiB reply guard. Usage reads now page under the existing1MiB page target, retaining all days and the2MiB guard; a single valid day is allowed as one page. Storage cursors use the hashed keys, while the document keeps its specified id. Large-payload regression passes after the change. This extends Decision866's projection without a new transport or a larger reply allowance.


870. The phase5 account-change regression also requires a reason account-limit and a coordinator event when the actual account changes. Recovery notices were historically ledger-only; the thread view now exposes its latest20 redacted notices, shown in the expandable session information area. This extends Decision866's visible recovery evidence. Timestamp text is localized in the owner browser. A repeated browser assertion found empty usage and remains a failing check under diagnosis; it is not dismissed as infrastructure or counted as a pass.


Phase5 environment correction: the initial broad commands supplied a shortened PATH that omitted /Users/ggomes/.local/bin. The installed basic-memory executable lives there. The focused failure explicitly reported spawn basic-memory ENOENT; browser usage was empty after its thread was blocked before producing usage. These are invalid-environment attempts, not a weakened assertion or a claimed product pass. The broad run is stopped and rerun with Node22 prepended to the existing PATH. The Basic Memory binary and the owner's home remain untouched; fixtures still use disposable homes.


871. A failing usage-limit continuation regression showed that the fresh account got the task but lost the last partial output. The optional partialText field on thread-turn-end-v1 keeps its redacted8,000-character tail. Recovery starts use the previous report, that tail and the existing bounded project journal when available, after Task/Project memory/Project now. This extends Decision94's minimal fresh prompt and Decision16 account continuity; it creates no separate transcript or memory store. A separate failing owner-follow-up regression showed reclassification could overwrite a blocked escalation; escalation now follows classification and preserves the earlier effort floor.

Phase5 browser correction: with the correct PATH, usage, its token/cost badge and waiting notice pass. The next assertion expected Fable, while the configured menu label is Claude Code Fable. The assertion now checks that exact menu label, as required by the brief. Existing process-group cleanup EPERM remains a separate recorded warning. No product value or timeout was weakened.


872. Two failing provider-reset regressions showed account-scoped resets were dropped and unknown usage defaulted to30minutes even when the provider supplied an hour. Projects execution now forwards that boundary. Shared account eligibility honors it while never shortening a known exhausted usage window. This refines Decision862's known eligibility time; model-scoped cooling and unknown-reset fallback remain. It changes no Conversation interface or routing policy.


873. Two failing usage regressions showed unchanged polls rereading ledgers and a time-zone change losing today's totals. The device now replays canonical ledgers once, consumes live events incrementally and writes only dirty days. Changing the project zone deliberately rebuilds the projection and clears obsolete own-device day rows. Pending dirty counters survive an offline hub. This refines Decision866 without another source of truth.

874. Two failing resource regressions showed a pending verification stranded when account admission lost the hub, and an owner-command report triggering model escalation. Account admission now retains the existing hub-wait reason and pending turn; a structured owner command is an owner dependency, not evidence for escalation. This narrows Decision865 to agent-written work failures as BRIEF.md P5 requires.


## Phase5 checkpoint

Simulated:193/193 affected backend cases in8files, typecheck, lint and build pass. PAR5 passes4/4 layouts with16 final captures; all16 dedicated vision receipts say not run for the missing credential, and selected captures from every layout are directly inspected. The existing fixture cleanup warning and bundle-size warning remain recorded. Additional provider-reset and verification-escalation checks pass. The diagnostic full backend run is interrupted after changing source, with five failures retained; three pass unchanged alone and two Git rewrite cases are still checked. Full-suite success is not claimed. See phase-5/README.md and failed-before.md. No source installation or live-clock start occurred.


## Phase5 push and phase6 start

Live: bfb9dc8a is pushed on main after the normal full-history secret scan. No installed release changed; the live clock is unstarted. Phase6 begins with source-grounded hub/mesh/ledger/PWA integration. Its dependency check finds web-push3.6.7 is MPL-2.0, not MIT as the brief states; the unmodified dependency's license is retained. Primary sources: https://github.com/web-push-libs/web-push/tree/v3.6.7 and its package.json/LICENSE.

875. Phase6 uses the requested web-push package with its actual MPL-2.0 license, replacing only the brief's mistaken MIT description. Keys remain encrypted in the existing hub vault; the existing hub document store, owner authentication, mesh and canonical Projects ledgers own subscription and notification delivery. Optional versioned per-subscription delivery receipts retain retries independently when another subscription already succeeded.

Closing diagnostics: the two Git rewrite regressions also fail alone on Git2.56; raw disposable Git output confirms a dropped middle commit is omitted from post-rewrite. Apple Git is not a supported workaround: it lacks merge-tree --merge-base. The first all-four-layout LJ5 attempt did not reach a journey because a fixture missed its60000ms startup deadline; it is not run. No guard or timeout changed.


876. Notification production extends the existing canonical ledger projection. A 7-day replay provides crash/offline retry with stable event-derived ids; private keys are lazy-created in the encrypted hub vault and never returned. An optional retrying field on coordinator-turn-end marks the existing uncounted usage-limit retry, so it cannot count toward the two-failure notification. Hub-created question records provide the durable needs-you trigger. The standard secure-context localhost exception remains available for disposable browser fixtures; nonsecure HTTP shows the brief's HTTPS guidance. This extends Decisions863 and875 without changing routing, merge authority or account selection.

877. Two failing phase6 regressions refine Decision876: an explicit flush could return before the ledger's queued subscribers were delivered, and Markdown stripping damaged code identifiers/comparisons. Flush now fences that delivery before draining; notification text preserves code and ordinary punctuation while removing formatting. Temporary status-only diagnostics were removed. The browser suppression assertion waits for the actual service-worker waitUntil promise, preventing an early empty notification list from falsely passing.


878. A failing lost-reply regression showed the new test-notification POST inherited a retryable flag despite creating a new send each time. Its errors now decline automatic replay. Subscription save/remove remain retryable through their stable endpoint/id. This refines Decision875's owner API without changing ordinary request handling.


879. A failing shutdown regression showed the sender drained its entire queued batch after close was requested. It now finishes only the in-flight request and retains later deliveries for the next hub start. This refines Decision875 so update/shutdown is not held by every queued send; delivery receipts and replay are preserved.


## Phase6 checkpoint

Simulated: final142/142 affected backend cases pass across6files. Typecheck, lint, production build, whitespace and working-tree secret checks pass. PAR6 passes all4layouts, then repeats all4 with settled initial-control captures. The8 final screenshots and8 dedicated vision receipts are retained; all vision receipts are not run for the missing credential, and selected final captures from every layout are directly inspected. The existing fixture cleanup warning and large-chunk warning remain recorded. Worker click navigation is simulated handler evidence; a real desktop notification click, real provider push and physical iPhone acceptance remain live/owner checks. The mandatory history scan gates the push. No installed source, native home, Ekoa work or independent hub changed; live clock unstarted.
