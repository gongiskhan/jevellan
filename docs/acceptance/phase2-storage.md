# Phase 2 storage and coordination checkpoint

These are component tests, not completed acceptance journeys. The daemon API, manual runtime loop and core browser flow now have separate evidence in [phase2-loop.md](phase2-loop.md); undo, settlement and the remaining memory/context workflows are incomplete.

The durable ledger and work reducer preserve request text, constraints, plans, follow-ups, generation, counters, process identity and partial output. Replaying history has no launch side effects. A handoff retry returns the original receipt; a different second handoff is refused. The journal is authoritative and restores missing summary/conversation/handoff files after a simulated interrupted materialisation. Torn trailing bytes are preserved in an old segment. Complete corrupt records and missing segments fail explicitly.

Tests use disposable homes and actual files. Large UTF-8 payloads spill into digest-verified blobs after redaction. Ranges retain contiguous event ids across rolls; searches return at most 20 snippets and stable pointers. The work-continuity scenario covers plan, approval, implementation, block and reply with the same work id, base commit and counters. These storage calls do not yet establish a full model-driven journey.

Coordination tests use actual SQLite compare-and-swap and temporary git checkouts. Clean paused work remains reserved; a dead daemon does not free unpublished work. Publication lease renewal, expiration, competing claims and failure before push are covered. Remote liveness does not use a local PID.

Git tests use local bare origins. They cover clean fast-forward admission, refusal of unrelated dirty/unpublished changes, local checkpoint commits, post-stretch detection of unexpected git-state changes, external-project mutation refusal, and immutable saved refs. Verification runs the configured shell command against a clean checkpoint and stores an independent receipt and output blob. Agent-reported tests do not decide completion. Passing commands that change the tree invalidate the receipt. Timeout cleanup removes the observed child before returning.

The Garrison check still reports the original upstream-status mismatch, while current HEAD and the latest appended snapshot match. The comparison parser now separates snapshots instead of comparing the original status to the entire appended file. No Garrison state was altered.

Publication component tests passed with real local bare origins: direct publish, clean rebase with a new receipt, a conflicting rebase resolved by a simulated integrate worker, and a real push rejection followed by integration and re-verification. A separate fixture forces three rejections and proves nothing is published. Failed verification stops before fetching or taking a publication lease. These are not live model acceptance journeys.
