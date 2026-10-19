# Decisions

The current Projects parity decisions are846–860 in the [run log](acceptance/projects-parity-2026-10/README.md#decisions). In particular,856 and858 replace the coordinator's unconditional PR-fix messages with the code-driven automatic loop;857 records durable attempt accounting and comment batches;859 records the simulated test harness budget;860 adds recovery from transient PWA navigation failures. Historical checkpoints below retain their original scope.

Jev decides what the work means and which action, model and effort fit it, and where each new project thread runs. Code enforces available resources, runtime permissions, user choices and work limits. The implementation is in `packages/decisions`; conversation guards are in `packages/conversations/src/guards.ts` and project limits in `packages/projects`.

Two question sets exist. Conversations use **q-v2**, declared in `selection.ts` and recorded with automatic decisions. Project thread placement uses **p-v1**, declared in `placement.ts` and recorded in every placement record; see [Placement (p-v1)](#placement-p-v1). The seeded configuration requests `jev-1.13.0`, uses a 4,000 ms request timeout and keeps the current eligible model at a probability of at least 0.6. Settings → Decisions can change the configured model, routing profile, model descriptions and effort guidance; the Configuration editor exposes the timeout and threshold. These are application defaults, not claims about the provider's latest models.

## State packet

`buildDecisionState` produces a redacted `decision-state-v1` JSON document containing:

- Routing profile, effort guide and up to eight recent correction sentences: five from this project and three from other projects.
- Original request, latest user message, bounded recent user/assistant exchanges across work boundaries, previous-question context when applicable, current state/next-work summary and the last three handoffs. Each handoff summary is limited to 400 characters and includes action, status, proposed next action, test outcome and blockers.
- Recorded facts: stretch/review counts, whether code changed, change size/files, risky areas, latest verification, publication conflict and whether the project has a test command.
- The current model's identifier, label, description and effort when available.

The packet includes at most 8,000 characters of recent conversation excerpts, with immutable source pointers and explicit truncation; it does not contain the full transcript. A new work does not inherit old constraints, blockers or next actions. Freeform messages after a question are context for Jev to interpret, not code-level proof the blocker was resolved. Its conservative size estimate is UTF-8 bytes divided by three, rounded up, with a 12,000-token cap. Old handoffs are removed first and their stretch numbers are recorded as omitted, then conversation excerpts shrink while the latest instruction remains intact. If the required request and rules still do not fit, the decision falls back to manual selection rather than truncating the user's intent.

After-the-fact overrides and applied composer choices contribute correction context. Pending or rejected composer choices do not become evidence of an applied correction.

## Questions and resolution

In q-v2, Call A determines the action. Call B determines model and effort after resource eligibility is known. Questions with a fixed answer are omitted; a call with no questions is not sent.

| Question | Type | When asked and how used |
| --- | --- | --- |
| `next_action` | Choice | Asked when multiple allowed actions remain and the user has not overridden the action. Only allowed actions appear. |
| `remember_request` | Noul | Asked for a new message. A probability of at least 0.7 enables explicit remembering for a `reply` action. |
| `keep_current` | Noul | Asked if the current model remains eligible and the model is not fixed by the user. The configured threshold decides whether to retain it. |
| `pick_eligible` | Choice | Asked when more than one model is eligible and the model is not fixed. Selects among runnable models if the current one is not kept. |
| `pick_any` | Choice | Asked when enabled candidates include ineligible models. Records which model would fit absent account constraints and can explain a missing-login preference. It cannot select an ineligible account for execution. |
| `effort` | Choice | Asked unless effort is fixed by a one-step choice or pin. Criteria come from the configured effort guide. |

Noul answers are probabilities of the stated proposition. Choice answers include the selected option, a distribution and confidence. The client validates the answer type, required option keys, probability bounds and distribution sum. It rejects missing or inconsistent answers. It does not accept arbitrary provider text as an action.

Resource filtering considers enabled runtime/model entries, required tools, enforceable read-only behavior, account readiness, device, cooldown, capacity and paid-use rules. Account ranking then chooses among eligible accounts for the selected runtime. No eligible model leaves the work waiting with recorded reasons. An unavailable pinned model is not silently replaced.

A one-step model/effort choice takes precedence over a conversation pin. Otherwise Jev selects them; a single eligible model needs no model-choice question. Requested effort is mapped to the nearest supported effort, with both values and the adjustment notice retained. A publication conflict forces the integration action through a guard. `done` requires no runtime and is unavailable until a completed response stretch has consumed the latest message; a routing-only decision or older in-flight response does not count. Failed, interrupted and undone steps leave it pending. Legacy records use launch chronology. Explicit user closure is separate; `ask-you` can use an existing question or obtain one through a reply stretch.

## Placement (p-v1)

Every new project thread is placed before it is prepared: isolation, model (and so runtime), effort and device. The coordinator decides what work exists; placement only decides where and how a thread runs. `decidePlacement` in `packages/decisions/src/placement.ts` implements question set **p-v1** with `askJev`, recording each call with `kind: 'placement'`. Placement never waits for the owner.

**Candidates (code, before Jev).** Devices qualify when they are online (the placing device always counts as online), have a path for the project that the project allows, and are below the project's per-device running limit. For main isolation a device also needs the project's Git policy to be Work on main and a free checkout on main, with no held checkout claim and no main thread of the project there that has not ended. Models qualify when they are enabled menu entries whose runtime is enabled, declares turns, MCP, editing and shell, and has an eligible account (`rankAccounts`) on at least one candidate device. Excluded models and devices keep their reasons, for example `offline`, `not set up for this project`, `main checkout busy: {title}` or `Codex needs login`. Fixed fields given by the coordinator or the owner remove the other options. When the running limits leave no candidate, candidates are computed without them and the thread is queued.

**Placement Call A** asks, each question omitted when its field is fixed or only one option remains:

| Question | Options and criteria |
| --- | --- |
| `isolation` | `worktree`: "Larger, riskier or multi-file change that should be reviewed as a pull request." `main`: "Small, contained change that is safe to land directly on main without review." Asked only when both are allowed. |
| `pick_model` | One option per eligible model; the criteria are the menu entries' descriptions. |
| `effort` | The efforts, with the configured effort guide as criteria. |

**Placement Call B** asks `device`, with one option per candidate device that has an eligible account for the chosen model's runtime (and satisfies the main rule when main was chosen), only when the device is not fixed and more than one qualifies. Each criterion reads `{deviceName}: {running} threads running here`, adding `this is the coordinator's device` and `project checkout is on {branch}` where they apply. A call with no questions is not sent, so a fully fixed start records `source: 'fixed'` without asking Jev.

**State packet.** Both calls carry one redacted `placement-state-v2` document: the routing profile and effort guide, the project name and default isolation, the thread title, its task (cut to 6,000 characters with a `[Task shortened.]` marker), the coordinator's note (at most 600 characters), the newest 50 active threads (title, isolation, device, model, effort and reserved paths) and task type, needs and goal motivation (at most 600 characters), and the newest eight same-type overrides followed by four other-type overrides, in the form `{field} changed from {from} to {to} for a {type} task '{title}' ({mode})` (at most 72 sentences). The packet is redacted before it is cut and uses the same size estimate and 12,000-token cap as `decision-state-v1`; when it is too large it drops reserved paths, then active threads, then override sentences, oldest first, and a packet still too large falls back.

**Resolution.** Each choice takes the option with the highest probability; an exact tie goes to Jev's own choice when it is among the tied options, else to the first tied option. The effort is mapped with `mapEffort` against the chosen model's supported efforts, keeping both the requested and the effective value. The account is the first eligible `rankAccounts` entry for that runtime, model and device. The `placement-v1` record keeps the source (`jev`, `fixed` or `fallback`), the fixed fields, the probabilities, eligible and excluded models and devices with reasons, the account, any error and the Jev calls.

**Fallback.** Any Jev failure except cancellation (a missing key, authentication, timeout, a malformed or unusable answer, a packet too large, or the key being unreachable while the hub is down) places the thread deterministically: the project's default isolation when allowed (else `worktree`), the first eligible model in menu order, `medium` effort mapped to that model, and the coordinator's device when it can run the model, else the candidate with the fewest running threads, ties by device name. An answer choosing main with a model that no main checkout can run also falls back. The record says `fallback` with the error kind, and the thread page shows `Placed without Jev: {reason}`. When no candidate exists at all, the start is refused with every reason, for example `No device can run any enabled model: Mac mini: Codex needs login.`; the coordinator sees that text.

**Overrides.** The owner corrects a placement from the thread page. *From the next turn* changes the model (same runtime only) and the effort for the next launch. *Restart with these choices* changes any field, allowed when the thread has no open pull request and has not published to main; it stops the thread, removes its worktree and starts a new thread with those fields fixed. Both are stored as `placement-override-v1` on the hub, summarized to the coordinator and fed to later placement packets as the sentences above. They are not yet used to change the configured guidance. See [projects](projects.md#placement).

## Memory selection

Project search supplies up to twelve note candidates. Each `memory_{index}` score question asks how useful that note is for the selected action, from 0 (not useful) through 3 (essential). Jevellan keeps at most five notes scoring at least 2, ordered by score with search order breaking ties. Excerpts are at most 300 characters; the brief has its own memory budget. Unresolved conflicting notes are labelled.

If memory scoring fails, the first five search-ranked candidates are used and the source is recorded as `search-rank`. This fallback selects recalled context only; it does not infer the next action, model or effort. See [memory](memory.md).

## Transport, failure and evidence

The client sends JSON to `POST https://api.typesafe.ai/v1/systemone` and checks aliases with `GET /models`. Internal versioned request/response schemas wrap the provider's wire format. Credentials are read from the hub vault, supplied as bearer authentication and omitted from persisted records. Redirects are refused. Provider error bodies are cancelled without being read because they may echo inputs or authentication.

HTTP 429 and 5xx responses retry once after one second. Authentication, malformed responses, network failure and request timeout become typed failures; cancellation aborts the request. The owner offers manual selection or an explicit retry. Missing credentials are never recorded as a successful classification.

The durable decision records the allowed/chosen action and source, eligible and excluded models, probabilities where available, model retention, requested/effective effort, account ranking, corrections shown and memory selection. Jev call records include requested/returned model, latency and usage. The **Why** drawer reads this saved evidence; opening it does not ask Jev again. **Test connection** in setup and Decisions checks model aliases and reports measured latency, not a completed classification.

## Changing the question set

For routing preferences, edit the configuration through Settings. Keep resource eligibility and work guards in code; do not add keyword or other heuristic routing around Jev.

For a semantic change to the questions, update `prepareAction`/`prepareModel`, their resolvers and the relevant state/memory builder together. Give the question set a new version and extend the versioned record schema while preserving readable historical records. If a stored document shape changes, add its explicit migration. Update the Why presentation only where the recorded evidence changes.

Run the decision-selection, state/memory, transport and automatic-conversation tests, then the affected browser journeys; for placement, also the pure placement tests and the Projects placement integration tests. Tests should cover the intended choices, eligibility, user overrides, malformed responses, cancellation and manual or deterministic fallback. `npm run eval:decisions` evaluates the saved q-v2 cases with real Jev and reports blocked without the dedicated key (`JEVELLAN_TEST_JEV_KEY`); the routing improver compares its proposals against the same saved cases. A simulated response is not a substitute for that live evaluation.

See the [acceptance report](acceptance/REPORT.md) for the current live/simulated distinction and missing-credential blockers.

Placement receipts retain the redacted corrections actually shown to Jev, including size-budget drops; Why presents that list. Legacy corrections without a type count as feature tasks. A dispatched task freezes its type, needs and goal snapshot with its assembled brief so remote retry and restart use the same placement context. New installations receive the thread effort guide; existing owners accept the suggested replacement in Settings → Decisions before saving. Discovery adds requested Opus 5.5 and GPT-6.1 Sol labels only with identifiers and effort levels returned by accounts, preserving an existing disabled choice.


2026-10-11 Projects loop amendment A4: Ekoa workflow authority and project credential scope are recorded as acceptance decision 654. Handoff PR #208 stays for the owner to merge; exact-SHA dispatch uses pinned refs and actual returned run identities. Windows freeze handoff state once and cannot mix old watch order with new dispatch order. Live installation remains blocked on the grouped owner inputs.


Projects parity phase5 decisions861–874 are recorded in [the run log](acceptance/projects-parity-2026-10/README.md): placement bounds, explicit account waits and continuation, model recovery/escalation with session continuity, and bounded cross-device usage projection. Earlier conflicting behavior yields to BRIEF.md as described there. Affected phase5 validation passes as recorded there; final full suites, release and live acceptance remain pending.


Projects parity phase6 Decisions875–879 cover the actual web-push license, durable notification delivery and the ledger/plain-text regressions. Source/evidence: acceptance/projects-parity-2026-10/phase-6/. The coordinator remains read-only and still has no merge tool.


Projects parity Decisions880–884 extend the existing hub, mesh, launch path, publication and rigging store with the Library, attachments and project environment. The run log records transport paging, copied-file history guards and regression evidence. Phase7 verification is in progress.


Phase7 source closure (Decisions880–887):121 distinct affected backend cases, PAR7/PAR7b in all4layouts, typecheck/lint/build pass. Library streaming cancellation no longer crashes the daemon. Dedicated vision and real-provider LP6 remain not run; source is not yet an installed release. See acceptance/projects-parity-2026-10/phase-7/.


Projects parity phase8 (Decisions888–889) is in progress: account-v2 endpoint definitions, explicit model service, paid-use rules, source-tagged menu choices and vault-only per-launch auth extend the existing account path. Native and endpoint discovery remain separate. The real SDK contract now uses the same bundled CLI as production against a fake server under a loopback network guard; this is simulated provider evidence. Source/browser checks and optional real-provider acceptance remain separate.

Projects parity phase8 checkpoint (Decisions888–892): compatible endpoints, source-bound model choices, billing, per-launch vault auth and bounded probes are implemented. Endpoint local outages are no longer hidden by another device's Ready observation; native saved-login behavior stays. The menu supports19 enabled choices and up to200 saved definitions, preserving disabled owner settings.191 affected backend cases and PAR8 in all4layouts pass. Dedicated vision is not run, and optional real-provider LP8 is blocked without its credential. See acceptance/projects-parity-2026-10/phase-8/; no installed release or owner acceptance is claimed.

Projects parity phase9 (Decision893) is being verified. First-turn exploration and Suggest setup authorize one repository-grounded proposal. An editable owner card applies selected fields with atomic hub revision checks and retry receipts; new goals remain paused in Propose mode. Existing notebook/history and durable first-proposal checks prevent repeated unsolicited setup. No existing project is changed by merely loading it. Evidence follows in acceptance/projects-parity-2026-10/phase-9/.

Phase9 checkpoint (Decision893):153 affected backend cases and PAR9 all4layouts pass. Suggested setup is owner-applied, revisioned and retry-safe; untouched settings stay, and goals start paused in Propose mode.16 screenshots retained, dedicated vision not run. Live LP9 and release installation remain phase10 gates.


894. The Projects parity closing moves the complete previous Projects/loop references verbatim to acceptance history files and replaces the public references with current behavior. Historical delivery claims remain evidence, not current acceptance.

895. Concurrent Projects refreshes share one in-flight task sweep. The regression failed before the fix with four calls to the blocked nightly sweep instead of one. Shutdown cancels owned work, then drains the in-flight sweep before state publishers close; regressions catch both returning too soon and waiting before cancelling jobs. This replaces unbounded overlapping periodic/event sweeps and the missing shutdown drain without weakening admission or changing polling deadlines.

896. Git rewrite receipts can fill an omitted dropped commit only when merge-tree proves that applying its original change to the preceding recorded boundary leaves exactly that boundary's tree. This replaces the assumption that every supported Git version reports empty drops. Missing nonempty, reordered, discontinuous and moved-head evidence remains refused; saved refs and exact undo boundaries remain required.

897. Release activation supports explicitly named independent installations, bound in the existing installation manifest, service definition and CLI paths. This replaces default-service-only targeting for the Pro's Madrid member. The independent Madrid hub and default CLI remain byte-identical. An unmanaged legacy member is installed into its own retained data home after a cold backup rather than fabricating update receipts; its first rollback uses that full backup.

898. Closing browser coverage navigates to Routines for job creation after the Overview move. The isolated LJ6 journey first failed waiting for New job under Queue; only that stale navigation changes, preserving actual-run identification, timeout and receipt assertions. Earlier scope/copy fixtures now include the delivered Library tools and correctly typed copy samples; reservation teardown still has its original state assertions.

899. Every browser fixture uses its after-seeding control listener for readiness, including the eight ordinary/improver hubs. This replaces advertising ordinary HTTP health before member/account seeding completed, which overlapped startup work and repeatedly blocked the four-layout suite. The new real-fixture backend regression first gets404 instead of204. Assertion, request and server-start deadlines and four concurrent journey workers are unchanged.

900. A transient signal permission refusal does not assert successful termination or immediately abandon cleanup. The existing bounded fresh identity scans must confirm every owned process exited; persistent refusal still fails as unconfirmed. This replaces immediate EPERM failure for short-lived descendants while preserving reused-identity and ownership guards. Both signal-refusal regressions fail before repair.

901. Closing verification also runs from an isolated source snapshot in Madrid's private build folder, alongside the Pro run and Mac-native regression checks. Source changes and commits remain on the Pro (Decision846); the separate Madrid hub, services and owner checkouts stay unchanged. This extends verification across both release platforms.

902. Legacy FakeRuntime runner fixtures supply explicit simulated resource facts, as the shared project fixture already does. This replaces accidentally admitting fixture work against the busy Mac's real load. The ten runner cases failed at the real load guard before reaching their assertions; production guards and dedicated resource-limit tests are unchanged.

903. Account-readiness hub outages now retain the existing once-per-wait ledger notice as well as the pending turn and Waiting for hub state. This repairs the P5 early account check replacing the older exception path without its notice. The unchanged PJ5 relay test fails twice with zero notices instead of one before repair; repeated sweeps must still write exactly one.

904. The cancellation fixture waits for its actual mocked request and abort events, under the unchanged60-second test limit, instead of assuming filesystem preparation reaches Jev within vi.waitFor's implicit one second. This replaces the old polling setup race reproduced in the four-worker Linux run (release was undefined). The late-answer, no-decision, no-launch and unchanged-HEAD assertions remain intact.

905. The encrypted-migration browser journey expects the imported first project after sign-in, matching the established Projects-first home route. This replaces its stale Runtimes landing-page assertion; the full Linux run first fails there while its snapshot shows Migration fixture loaded. Project-path editing, retained transcript and byte-identical imported history checks remain unchanged.

906. Finished job receipts gain optional cleanedAt only after process confirmation, worktree removal and private-ref cleanup succeed. Later sweeps skip the repeated Git work, including after restart; a remaining process record still requires confirmation, and interrupted or legacy cleanup retries before recording completion. This replaces cleaning all historical runs on every sweep. Both new backend regressions fail before repair; the unchanged four-layout LJ5 journey also reproduces the third-night delay before this change.

907. State-change callbacks received during a task sweep request one subsequent sweep; ordinary overlapping pulses still share the current sweep. This replaces Decision895's incomplete single-flight behavior, which could drop a job-completion wake-up. The new callback regression fails with one sweep instead of two, and the broader backend test catches a completed failed-suite/skip pair whose window stays open without periodic timers. Shutdown still cancels and drains, and no deadline changes.

908. LJ5's idempotent fixture POST helper retries one ECONNRESET using the pinned Playwright API. This extends the existing stale-connection handling for fixture reads, after the real four-layout run fails on its daytime job-run request before opening the night. Every helper request has clientRequestId. Playwright's installed types confirm it retries only that network error, never HTTP status failures; no assertion or deadline changes.

909. The legacy missing-report regression now distinguishes a usage limit from an agent failure: it asserts the retained continue turn, account wait, cooling and absence of a synthesized blocked report. This replaces its pre-P5 expectation that a rate limit ends the work. The full run supplies the failed-before receipt; production continuation behavior and timeouts do not change.

910. The stale-classification fixture waits for its actual mocked request before changing the owner's message, just as Decision904's cancellation fixture does. This replaces the same implicit one-second setup poll after the full run fails with release still undefined. The test still delivers the late classification and checks that only the owner's newer read-only request runs; its normal deadline and every stale-result/Git assertion remain unchanged.

911. PJ2's exact coordinator launch snapshot includes the required read-only Library directory and instructions, and its fresh prompt explicitly asserts the new-project setup block before comparing every prior context line. This replaces the pre-P7/P9 snapshot after the full run fails at that exact launch assertion. Routing, publication batching, session reuse, complete context and event ordering checks remain.

912. Takeover state assertions exclude only same-state ledger updates whose sole changed field is usage, and separately require the exact three-turn/two-turn usage totals. This replaces the pre-P5 assumption that the final four index events are all lifecycle transitions, after both takeover journeys fail with the added usage projection. All attach, session adoption, delivery, confinement and redaction checks remain.

913. The shared-registry bridge regression lists the three required P7 Library tools explicitly alongside every previous thread tool. This replaces its old exact scope list after the full run fails there. Token scope, unauthorized-call and cross-scope refusals remain unchanged.

914. The paused reserved-job regression drains the existing ProjectWork sweep before asserting that the runner is idle, and additionally asserts that no job worktree exists. This replaces inspecting the temporary sweep-in-progress flag immediately after a concurrent callback, after the full run fails busy=false. The reserved receipt, no conclusion while paused, and successful execution only after resume are still required; no production pause gate changes.

915. The legacy oversized-report probe crosses the current4000-character report bound, expanding4000 to4005 before readback; synthesized reports keep their separately asserted1200 bound. This replaces the old1200/1205 probe, which is now a valid normal report and therefore is correctly preserved. The full run supplies its failed-before assertion. Stable redaction, legacy read recovery and every shorter bounded-redaction assertion remain; production code is unchanged.

916. The one-mesh release gate runs the full backend with six Vitest workers on dev-madrid (16 cores) instead of the configured two. The two-worker run measured about five cases a minute, about seven hours for the suite, against a nine-hour build clock; six workers finish in about 35 minutes. Every failing case is then rerun alone, so load-sensitive cases are still separated from regressions. The checked-in configuration is unchanged.

917. Isolated browser reruns use a private wrapper of the checkout's own Playwright configuration that starts only the case's fixture server, with a fresh invocation and fresh server for every run. Every failing or interrupted case runs alone three times at the commit where it failed and three times at the baseline; an early-stopped first pass was completed to three and three, and its first receipts are kept. A run that cannot start its fixture is recorded as an interrupted attempt and repeated, never counted as an assertion failure. gate.json records every run.

918. The push-notification tests create their temporary folders in the platform temporary directory instead of macOS's `/private/tmp`. All six failed on Linux at main with ENOENT and do not exist at the baseline (a regression under the gate rule); production code is unchanged.

919. A thread composer that takes no message (attached, offline or otherwise blocked) shows no Attach files row. PJ7 failed at main on the phone layout because the extra row made the attached page taller than the screen; it passes three of three at the baseline.

920. Project notification levels lay out their radio like every other fieldset radio, the PAR3 journey expects the Library tab added by phase 7, chat messages render the library chips row only when files are attached, and usage table headings never break inside a word on phones (the table scrolls instead). These are the blocking vision findings and stale expectations of the gate's PAR journeys.

921. PAR6 runs on the installed Google Chrome (`PLAYWRIGHT_CHANNEL=chrome`) on dev-madrid. In Playwright's bundled headless shell on Linux, a service worker's `showNotification` closes the page, so no notification can be observed; Chrome shows it. The other journeys keep the bundled browser of the 15 October Madrid run.

922. Opening "Choose where it runs" in the New task dialog brings the placement fields into view, and a dialog with a sticky action bar keeps 72 px of scroll padding above it, so a scrolled-to field is never hidden under the bar. Vision flagged the PAR8 menu capture twice: the trace showed the disclosure open and the Model menu "in view" yet covered by the sticky actions. On phones, a page with a bottom composer shows toasts under the header instead of over the composer (PAR7b), and usage table row names read as text with tighter phone cells (the second PAR5 finding, after keeping headings whole).

923. The browser fixture's PAR8 coordinator step matches only the owner's own `PAR8 endpoint` line. It matched any event text containing "PAR8 endpoint", including the started thread's report about "PAR8 endpoint task". It therefore replayed the owner-request task creation in a report turn, the product correctly refused it twice, and the failed coordinator never answered PAR9's setup request. PAR9 had not passed on Linux in any run of this session; with this change PAR8 and PAR9 pass with vision in all four layouts. No assertion changed.

924. Refines D92. While a project has a thread that is not done, stopped or failed, its project write may still add a path for a device that has none, as long as every existing path and the Git policy stay exactly as they are. Changing or removing an existing path, or changing the Git policy, is still refused. Threads keep their owner device's path, so an addition cannot move work that is under way. In the one-mesh run, the Pro could not be registered for ekoa-code without stopping its five owner-held threads in review. The Pro's ekoa-code path is therefore added through the normal project write after the 0.5.0 update.

925. Every Jev decision has one overall deadline, owned by one shared helper in `@jevellan/decisions` (`withDecisionDeadline`, `runDecision`, `deadlineClient`): twice the configured per-attempt `timeoutMs` plus one second (the client's existing retry budget), plus five seconds. The helper races the whole decision against its own timer and against the caller's abort signal, so the caller settles with `JevError('timeout')` or `JevError('cancelled')` even when an inner promise never settles and ignores its signal. The daemon's `decisionClient` is a decision source: each decision obtains its client inside the deadline, so the configuration read for the per-attempt timeout, the key read and every HTTP attempt are covered. Its deadline uses the last configuration it read (4000 ms before the first), so a configuration read that never settles is bounded too. Every call site uses the helper, and each maps the error to its existing fallback: the project request outcome (`unavailable`), placement p-v1 and the account choice a-v1 (deterministic fallback), follow-up routing, the merge route m-v1 (ask the owner), conversation q-v2, memory selection, memory care and the routing improver. Where a settings read only supplies the decision's model (the request outcome, follow-up routing, the merge route), that read moved inside the deadline. Where the same settings also feed the deterministic fallback (placement, account choice, q-v2, memory selection, memory care), they are read before the decision, as before, and only the decision is bounded. The merge route's own `timeoutMs` timer is replaced by the shared deadline. The coordinator prompt now carries the "Jev could not interpret this request" instruction for an unavailable outcome, as thread follow-ups already did. Phase 0 of fix-051 did not establish a further root cause, so this is the guard, not a deadlock fix.

926. Fresh session, Stop, Move coordinator and shutdown abandon an in-flight request classification, and the outcome step releases its lifecycle operation in `finally`. Fresh starts the next turn at once, in the fresh session. Stop and shutdown keep the owner's message queued, and Move hands it over. Before, only Stop and shutdown aborted, and both then waited on the turn without a bound.

927. Fix turns for failing checks, conflicts and review comments, whether automatic or from the Fix checks, Resolve conflicts and Address comments buttons, start from the pull request's current head on worktree threads. Before the turn:
- The thread fetches `refs/pull/<n>/head` into its private ref `refs/jevellan/threads/<tid>/pull-head`.
- It fast-forwards when its branch has nothing unpushed, and otherwise merges, never rebases. A merge that stops on conflicts is left for the turn, whose prompt names the conflicted files first.
- The thread notice "Updated the worktree to pull request #{n}'s head {short sha} before this fix." is the ledger line, as thread notices are ledger entries.
- The next push leases on that fetched head, since the branch now holds it.

Thread-scoped `jevellan_github` reads use the pull request head as this device's tracker last read it, which is fresher than the hub index. A thread may now list runs, but only those on that head, which keeps the rule that a thread reads only its own pull request. The checks fix prompt names the failing runs and jobs by id as well as the check names. They are read from GitHub when the fix is requested, not stored in a shared document, so 0.5.0 members still read every shared document during the update.
