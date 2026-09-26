# Routing suggestions and private drafts

Current publication note (2026-09-26): this unfinished work is now included in the user-requested machine-handoff checkpoint on main. References below to local-only work, staging and publication blockers describe the historical build state. The running pilot is unchanged. See [handoff notes](machine-handoff-2026-09-26.md).

Date: 2026-09-25. Phase 6 is deferred at the user’s request for a pilot trial. The backend is now connected to the normal application and authenticated HTTP/device APIs. The suggestion UI, remaining project jobs and complete J10 journey are still unfinished.

## Durable decisions

`RoutingSuggestions` stores pending suggestions, evaluated previews and all Apply, Apply after change, Dismiss and Undo outcomes in the hub. Applying an edit, writing its outcome and saving the request receipt share one SQLite transaction. A failed receipt write rolls all three back. Stable request identifiers recover lost replies after restart without applying a second time, including when the suggestion has since been undone.

Apply compares only the target field and retains unrelated settings. A changed or removed field produces a recomputation state without overwriting newer text. Undo compares the applied text and expires at thirty seconds. Preview creation leaves configuration untouched. Dismissal retains the optional reason, and previously decided correction IDs cannot count as new evidence. All historical outcomes remain stored; the visible decided list covers seven days.

Each comparison is bound to the evaluated configuration, proposed configuration and complete saved-case set by checksums. A draft with changed text, an incomplete case list or a different case set is refused. Direct and instruction-based previews use the same checked storage, but the instruction-generating UI path is not connected yet.

## Private read-only stretches

`BackgroundDrafts` prepares input copies under the isolated home's `tmp/` folder. Its request and ordinary conversation ledger live under `improver/`. It uses the first eligible menu model, the ordinary account ranking, a scoped handoff bridge and the existing stretch runner, including repair, process termination, usage and restart recovery. It exposes no project-memory tools. A changed input copy fails the draft; the result contains no native session identity.

Completed retries return the saved result without another launch. Failed or interrupted draft identifiers cannot silently relaunch. Cancellation and shutdown wait for owned processes to exit and for the existing final-handoff grace. A shared account reservation prevents overlap on runtimes that cannot isolate launch configuration. Recovery that cannot confirm process cleanup blocks replacement drafts and retains its lifecycle activity.

The normal application now instantiates this component, shares account reservations with conversations, waits for both recovery paths during startup and binds both bridges to the listening daemon. Shutdown cancels the improver before closing drafts, accounts and bridges. Tests use the same real disposable process groups as the runtime contract fixture; provider behavior is simulated. No live generative improver call is claimed.

## Routing job

`RoutingImprover` connects the correction index, suppression, one Jev preference question per group, read-only drafting, all 24 before/after cases and suggestion storage. It never applies a suggestion. A probability below 0.7 stops before generation; exactly 0.7 qualifies. An already-pending group does not launch again. A missing key fails the run without a synthetic result. Logs identify the judgment, draft run, case check and suggestion. Claims renew during work and cancellation propagates to the active draft or judge request.

The two-group test produced two pending suggestions, each with 24 recorded comparisons, while the configuration history stayed at one revision. Both Jev and the draft producer are explicitly simulated in this orchestration test. The separate background-runner tests exercise actual process cleanup. A hub-local polling timer now starts only after the HTTP bridge is listening. Durable daily claims prevent repeating the same night. Manual routing runs and member forwarding are connected; dispatch of memory/context jobs remains unfinished.

## Application and revision requests

The authenticated `/api/improver` endpoint exposes state, manual routing runs, logs, Apply/Dismiss/Undo, revision requests and their results. Members forward a typed request to the hub; they do not create a second routing authority. Public job views omit claim tokens. Every run has a log, including an empty successful run. Injected decision transports or runtime adapters label comparison evidence simulated.

Direct edits and plain-language revisions have durable request records. An accepted request continues if its HTTP response is lost. Reusing its identifier reads the existing result; a different body with that identifier is refused. A restart records unfinished revisions as interrupted without silently relaunching a provider. An explicit new request can retry. The evaluated preview/recomputed suggestion and completion receipt share a transaction.

Direct edits launch no generative stretch. A plain-language change launches one more short read-only draft using the current configuration, previous draft, corrections and instruction. Both paths check all 24 saved cases. A changed field on Apply immediately queues a fresh draft and case evaluation; the resulting suggestion still requires another explicit Apply. A late provider reply cannot revive a dismissed suggestion. Cancellation leaves configuration untouched.

## Verification

- The initial store/evaluation/configuration selection passed 51 tests in five files.
- The draft/bridge selection passed 21 tests in two files in 71.73 seconds. The first run passed 19 and hit the default fifteen-second test deadline in two cancellation cases because the shared runner allows thirty seconds for a final handoff. Those two tests now allow sixty seconds; production behavior is unchanged. The final run includes actual process disappearance checks before releasing activity.
- The routing workflow/store/foundation selection passed 63 tests in seven files in 925 ms. Judge choices and draft generation are simulated.
- Typecheck and lint passed after these additions. Broader Settings/shared-state checks are recorded below. No new full backend, browser or live-Jev pass is claimed.

The final routing/store/foundation plus existing Settings/shared-state selection passed **91 tests in nine files in 19.05 seconds**. The runtime-adapter/contract/background selection then passed **27 tests in three files in 67.00 seconds**. That includes serialization of Codex's explicit private-input-copy option through the real SDK transport to a fixture CLI, on both initial and continued turns, while preserving read-only sandboxing, disabled network access and the existing approval policy. The runtime contract refuses that option with writing permissions, memory writes or a writing action. Ordinary project launches omit it. The installed CLI's help also recognizes the flag; its attempted PATH-alias setup was denied by the filesystem sandbox, and that invocation was not retried with broader permissions.

A separate **combined routing integration test passed in 2.00 seconds**. It wires the job to `BackgroundDrafts`, a real disposable fixture process, the actual scoped bridge, all 24 saved-case comparisons, hub persistence and explicit Apply. The lifecycle gate refuses maintenance while drafting and becomes available after process cleanup. The configuration remains unchanged until Apply. Provider output and Jev are simulated; this does not claim an actual generative provider or successful live classification.

Final typecheck, lint, secret scanning and whitespace checks passed. The staged 660-file phase-5 checkpoint remains intact; phase-6 work remains separate on main. No dependencies were installed or persistent product service started. The recorded commit-approval and GitHub-authentication blockers remain unchanged.

The new revision/store/job selection passed **30 tests in three files in 1.30 seconds**, including direct and instruction previews, stale recomputation, lost replies, restart, late dismissal and transactional receipt failure. The subsequent application/member regression selection passed **127 tests in three files in 1373.24 seconds**. Provider and judge responses are simulated. Current workspace typecheck and lint pass; small later log/schema/UI changes have not received another broad test run. No browser or live-Jev pass is claimed for this connection.

Remaining phase-6 work includes the suggestion cards and badge, the quiet notice and trial log, complete Settings controls, memory care and publication/revert, context suggestions, dispatch to project-owning devices and complete J10/J12 journeys. These remain implementation work, not environmental blockers.

The partial suggestion cards, badge and quiet notice are now present in the working tree and pass typecheck/lint, but have no browser verification. They are not included in the frozen phase-5 pilot. Remaining phase-6 implementation and broad final checks are deferred by user; see [PILOT.md](PILOT.md).
