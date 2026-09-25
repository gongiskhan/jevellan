# Phase 2 memory, context and recovery evidence

Date: 2026-09-24. Component evidence; no completed acceptance journey is claimed.

## Executed checks

- `npm run typecheck` and `npm run lint`: passed.
- `npm test`: the final run passed 249 tests in 28 files after the memory, context and restart changes.
- `npx vitest run tests/conversation-recovery.test.ts tests/conversation-work.test.ts`: sixteen focused tests passed, including five new restart cases.
- `npm run build` and `npm run scan:secrets`: passed.

`tests/basic-memory.test.ts` uses the installed Basic Memory 0.22.1, actual MCP processes and disposable configuration homes. It proves concurrent project separation, exact note reads/edits, title lookup, natural-language recall, indexing manually added notes without rewriting their bytes, unresolved metadata, local exclusion for device memory, redaction before writes and process-group cleanup. Its native-home sentinel is a fixture; it does not claim a complete hash audit of the user's real memory.

The original sync test failed because disabling background sync also prevented startup indexing. Explicit foreground sync then exposed two provider details: registry names are normalized, and forcing local routing also requires `BASIC_MEMORY_EXPLICIT_ROUTING=true`. Both were handled using the installed provider source; the actual sync test now passes. No provider package or native configuration was modified.

`tests/project-context.test.ts` passes twelve cases covering both single-file directions, native AGENTS support, already-linked idempotence, neither file, both files, both keep choices, reviewed merge, stale files, ownership acquisition races, external policy and invalid links. The stale-file tests adapt Garrison's `claude-md.test.ts` without its user-home editing behavior.

`tests/memory-queue.test.ts` passes six cases using real temporary git repositories and a simulated memory port. A read-only proposal changes no checkout files. Another owner's reservation prevents application. A successful boundary creates a memory checkpoint and receipt; interrupted checkpoint and receipt paths retry without duplicate notes or commits. Handoff capture preserves existing titles and links the source conversation. Manual recall records twelve candidates and five short excerpts.

`tests/conversation-recovery.test.ts` uses real disposable process groups. Recovery kills a worker and its descendant before finishing the stretch, preserves output and an already accepted native handoff, aggregates recorded usage and waits for a new message. A second recovery is inert. Interruption and the waiting notice are one durable event; a simulated projection failure cannot lose that notice. A reused or absent process identity leaves the step unsettled instead of claiming cleanup. No successor is launched and no checkout ownership is released by this component.

## Remaining integration

The owner loop now connects these components to API startup and manual scheduling, ownership admission, checkpoints, publication, and the conversation/Projects inspection UI. The conflict-integration test also proves that a handoff memory note is checkpointed before final verification and publication. Context create/keep/merge now has owner-work and Settings wiring; see [context workflow evidence](phase2-context.md). Memory-only publication and conflict preservation now have actual Git and Basic Memory service evidence; see [publication checks](phase2-memory-publication.md). Queued hook delivery now has installed Codex lifecycle evidence from the [live manual J2 journey](J2.md), with its event-level limits recorded in [Project memory hooks](phase2-hooks.md). Recovery with missing process identity stays explicitly blocked. Jev scoring, cross-device recall and nightly care are later work. Full automatic J1–J13 remain incomplete.
