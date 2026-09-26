# Memory care, context suggestions and improver settings data

Date: 2026-09-26. This completes the phase-6 improver **backend and HTTP API**. The Settings → Improver UI is being rebuilt separately and has no browser evidence here. Jev judgments and generative drafts are **simulated** in every test below. Git, checkout ownership, the publication lease, pushes to a local bare origin, SQLite and the HTTP/device protocol are **real local operations**. No live Jev or provider call was made; the live parts of J12 remain **not run** (they need `JEVELLAN_TEST_JEV_KEY` and the UI).

## What was built

- **Hub authority** (`packages/mesh/src/project-improver.ts`). Per-project, per-cycle job claims for memory care and context. They go to the hub when it has the checkout, otherwise to the first online device with it; context waits for memory care in the same cycle. The hub stores:
  - suggestion cards for memory care (Suggest only) and AGENTS.md, with Apply, Dismiss (with reason) and Undo, plus idempotent request receipts;
  - Change it previews and revision records;
  - morning reports for "Apply and tell me" with Undo;
  - checkout tasks bound to the device that has the checkout;
  - run logs and the per-project care state.

  Patches are re-hashed and their diffs recomputed on the hub, and memory care may only touch notes in the memory folder. Context may only touch `AGENTS.md`/`CLAUDE.md`. Task results are accepted only from the assigned device; tasks still running when their device restarted fail visibly instead of resuming.
- **Device executor** (`apps/daemon/src/project-improver.ts`). It runs on every device, and members poll the hub through the device-authenticated `/hub/mesh/improver-device` endpoint. The memory-care pipeline and context job follow [docs/memory.md](../memory.md#memory-care-and-context-suggestions):
  - skip an owned checkout;
  - fast-forward and sync;
  - collect candidates in code;
  - one batched Jev request;
  - a private read-only draft on copies under the isolated `tmp/`;
  - checked patch, hash-checked apply under ownership, `memory: nightly care (…)` commit and memory-only publication;
  - published `git revert` Undo.

  A failed publication discards to a saved ref and releases the checkout. After a crash, an apply journal restores the checkout and releases ownership at the next start.
- **Application facade** (`apps/daemon/src/improver.ts`, `improver-cards.ts`):
  - `improver-state-v2` with unified `improver-card-v1` cards for routing, memory-care and context suggestions;
  - morning reports, last runs per job and project, the trial log from the hub conversation index (now carrying the finished-elsewhere outcome), the Settings badge count and the once-only notice line;
  - new operations `summary`, `run-now` (all jobs), `report` and `notice-seen`;
  - `act`/`revise`/`revision`/`log` for every kind.

  The nightly scheduler covers project jobs through the executor's poll (hub 60 s, members 15 s).
- **Pure pieces:** candidate collection and patch validation in `packages/memory/src/care.ts`, Jev questions in `packages/decisions/src/memory-care.ts`, versioned schemas in `packages/core/src/project-improver-schemas.ts` and `improver-schemas.ts` (exported to `@jevellan/core/client`), and a unified diff in `packages/core/src/text-diff.ts`.

## Verification

All results below were run on 2026-09-26 with Node 22.

| Check | Result | Evidence label |
| --- | --- | --- |
| `tests/memory-care.test.ts` (9) | pass | Jev/draft simulated; Git, bare origin, ownership, publication real |
| `tests/memory-care-units.test.ts` (5) | pass | unit |
| `tests/memory-care-application.test.ts` (1) | pass | full application over HTTP, private draft runner with FakeRuntime and the real bridge; judge simulated |
| `tests/member-application.test.ts` (109, one new member dispatch case) | 108 pass in 1432 s; 1 timing failure | The new case passes; it uses hub and member daemons on one machine (simulated second device). "context recovery at applied-result preserves the applied boundary: restart" timed out waiting for its injected boundary in the full run and passed when rerun alone. It does not use the improver; the failure looks load-related and is recorded, not claimed as fixed. |
| `tests/improver-api.test.ts` (3, one new) | pass | judge/provider simulated |
| Improver selection: 12 files, 78 tests | pass in 64.6 s | as above |
| Affected selection: 17 files, 227 tests | 225 pass; 2 fail in `settings-api.test.ts` | The two failures are "APM produced an unsupported runtime file." from Rigging delivery with this machine's installed APM. They are unrelated to the improver and were not changed. |
| `npm run typecheck` | pass | |
| `eslint packages apps/daemon tests` | pass | Repository-wide `npm run lint` currently fails only on an untracked `.scenario.tmp.mjs` at the root, which is not part of this work. |

J12 backend behaviours proven by `tests/memory-care.test.ts`:

1. Two duplicate notes, one unresolved note with `## Merged from` and a broken link, and a stale unlinked note (last commit 200 days ago). **Run now** produces exactly one published commit, `memory: nightly care (1 merged, 1 archived, 1 links)`, although the project's test command is `false` (memory-only publication). The stale note is moved unchanged to `archive/`, and the checkout is clean and released.
2. The morning report has counts `{merged 1, archived 1, fixedLinks 1, reconciled 1}`. It also has the diff (View changes), the involved notes' permalinks and the notice line "Memory care for Sandbox: merged 1 note, archived 1, fixed 1 link.", shown once. The last run reads "Merged 1 note, archived 1, fixed 1 link, reconciled 1" with the commit, and the log stages go from started to complete.
3. **Undo** publishes `Revert "memory: nightly care (…)"` and restores every note byte for byte.
4. **Suggest only** creates one card and leaves the checkout and origin untouched; a second run neither duplicates it nor drafts again. **Apply** commits and publishes, and **Undo** within 30 seconds reverts and publishes.
5. A note changed upstream before **Apply**: the stale patch is refused and recomputed from the newer text. The newer text is kept, and the card returns to pending with a new revision and an explanation. The next Apply publishes a merge that includes the newer text.
6. An owned checkout is skipped as "skipped: Sandbox is in use", with no Jev or draft call, and is not retried in the same run.
7. Three notes stating the same working rule produce one AGENTS.md card, never applied automatically. A direct Change it edit and Apply publish `context: Run the tests before pushing` after the project's test command passes. Decided and dismissed rules (with the reason recorded) are not suggested again while the notes are unchanged. A plain-language Change it runs one more read-only draft and returns a preview without applying it.
8. A checkout left owned by a stopped improver process has its unpublished commit saved under `refs/jevellan/discard/…` and discarded, and ownership is released. A checkout owned by a conversation is never touched.

## Design choices (not fixed by the brief)

- Thresholds: a pair is merged at p ≥ 0.7 ("same thing"); a stale note is archived at p ≤ 0.3 ("still useful"); a rule group needs p ≥ 0.7. Unresolved notes and broken links are always sent to the draft; they need no Jev question.
- Stale notes are archived by code, not the draft, so "never delete" cannot be broken by a provider. The draft may only merge, reconcile and fix links, and may only change notes involved in those or notes linking to them.
- "Merged n notes" counts notes folded into another one. Counts are computed from the patch.
- Duplicate pairs are reconsidered only when one note changed since the last care run. Stale notes, unresolved notes and broken links are checked every run.
- Only one memory-care suggestion per project waits at a time. Suppression keys are the involved notes' paths and contents.
- Context groups need three or more related notes (title similarity or mutual search overlap). External-policy projects are skipped for context. AGENTS.md changes are not memory-only, so their publication runs the test command.
- The morning-card Undo has no time limit; suggestion-card Undo keeps the 30-second window. Projects that do not commit memory (device mode or external) apply and undo on disk, with hash checks.
- The trial log counts a conversation as finished in Jevellan when its state is `done` without an outside outcome, in the week of its last update (UTC Mondays). Renaming a finished conversation later moves it to the rename's week. Conversations Jevellan starts itself are left out: context operations now carry `origin: 'context-operation'` on the conversation and its index entry. Older context conversations are recognised from their recorded context operation.
- Handoff summaries for the stale-note question come from the executing device's local conversations only.

## Not done

- Settings → Improver UI, the card UI and the browser journey (owned by the UI rewrite).
- Live Jev and provider runs of J12 (need `JEVELLAN_TEST_JEV_KEY` and test credentials).
- A physical second device (the member dispatch is simulated with two daemons on one machine).
