# PJ2 - the coordinator

**Evidence label: simulated.** Projects phase 2 (BRIEF-projects.md section 13, local and untracked like BRIEF.md) passes PJ2 and PJ2b to PJ2e as integration tests on 2026-10-04 (goncalos-macbook-pro). No part of this evidence is live, and Gonçalo's acceptance is not claimed.

- **Real:** a booted Jevellan daemon (`Application`) with its browser routes, browser session, SSE chat stream and `/api/bridge`; Git 2.55 on a temporary checkout and a bare origin (thread worktrees, `jv/` branches, leased pushes); the hub's SQLite project store (coordinator assignment and status, decision items, notebook, work settings, thread indexes); child processes and process groups (restart cleanup).
- **Simulated:** model turns, through FakeRuntime scripted turns for both the coordinator and its threads, which call the daemon's real `/api/bridge` with their scoped tokens and write fake native session files; GitHub, through the local fake server `tests/fixtures/github-server.mjs` injected with `githubFetch` and `githubBaseUrl`, while the project's `remote.origin.url` is `https://github.com/fixture/repo.git` redirected to the bare origin with `insteadOf`; the GitHub token is a random fixture value.
- **Not run:** vision checks (phase 2 adds no interface, and `JEVELLAN_TEST_CLAUDE_TOKEN` is not set), live Claude and Codex coordinator turns, live GitHub (PJ-live, phase 8), and a coordinator on another device (its routes answer 409 `Remote threads arrive in phase 5.` until phase 5).

Test names cite the build design's decision ids; [REPORT.md](REPORT.md) lists them under the same ids (for example D33 is decision 395, D34 is 396, D36 is 397, D70 is 400, D77 is 402 and D97 is 300). Chat event records are written when an event is received and marked delivered through `coordinator-turn-start.eventIds`, the deliberate deviation of decision 238.

## PJ2 - one message, two threads, batched publications

File: `tests/projects-coordinator.test.ts` (all eight cases run through the booted daemon's browser routes; assertions run after the scripted turns, never inside them).

| Test | What it proves |
| --- | --- |
| `PJ2 one owner message starts two threads and the publications arrive batched` | The owner message `add A and fix B` runs coordinator turn 1 read-only, with the coordinator profile, no resume, the project checkout as working directory, the brief 9.1 system append for the project and the exact fresh-context prompt. That turn starts two threads through `jevellan_thread_start` and is held until both thread indexes are `in-review` and both `thread-published` events are queued. Turn 2 resumes turn 1's native session with exactly the event block header and the two `Pull request #n opened.` lines, so both publications arrive batched in one turn. The start results, the chat one-liners, the exact ledger type order, the turn start's delivered event ids, `coordinator.json` and the hub status (`turns: 2`) are asserted. The SSE stream's ids equal the ledger; `Last-Event-ID: 4` resumes at 5, `?after=999999` is refused 400 and a request without the session cookie 401; no native session id of any coordinator or thread turn (four ids, each at least 16 characters) appears in the full or the resumed stream. The work view shows the coordinator idle, two `in-review` threads and two pull request entries. |

## PJ2b - a thread question through the owner and back

| Test | What it proves |
| --- | --- |
| `PJ2b a needs-decision report becomes an owner question and the answer reaches the thread` | A coordinator-started thread reports needs-decision and goes `waiting-for-you` with the question's first line. Coordinator turn 2 carries the exact report block and asks the owner with `jevellan_ask_user`; the item is in `decisions.open`, from the coordinator, with the thread id and the option detail. The owner's answer is 202 `repeated: false`, the same body `repeated: true`, and another answer 409 `This question was already answered.`. The next coordinator prompt is exactly the `[owner answered] "..." → SQLite` block; the coordinator's `jevellan_thread_message` answers `started`, thread turn 2's prompt is `Use SQLite.` and resumes turn 1's session, and the thread reports done and reaches `in-review`. Exactly one `decision-answer` event exists, with the derived id; `thread-published` is delivered in turn 4, and the item is in the answered list. |

## PJ2c - the decision fallback when the coordinator cannot run

| Test | What it proves |
| --- | --- |
| `PJ2c without a coordinator account the thread question goes to the owner directly` | With the coordinator model pinned to an entry whose only account is disabled, the coordinator is `unavailable` with the brief's `No account can run the coordinator model on <device>.` reason and one notice for two messages, a later answer and a sweep; nothing runs on the coordinator's runtime. An owner-created thread's needs-decision report becomes a `from: 'thread'` decision item under the derived fallback id (decisions 394 and 409); answering `SQLite` sends thread turn 2 the prompt `SQLite`, and the coordinator queue keeps every event, including the `thread-user-message` for the answer. |
| `PJ2c after two failed turns the coordinator waits for a message, and thread questions go to the owner directly meanwhile` | Two failing coordinator turns write the exact failed-twice notice. An owner-created thread then runs no third coordinator turn and its question becomes a thread item; a new owner message runs a turn that carries the owner-started line, the report with the ` (Jevellan asked the owner directly.)` suffix and both messages, and the failure count resets (decision 405). |
| `PJ2c without a model that runs read-only turns the coordinator is unavailable with the capability reason` | With no menu entry that can run read-only turns, the reason is `No enabled model can run the coordinator on <device>.` (decision 300). |

## PJ2d - session rotation

| Test | What it proves |
| --- | --- |
| `PJ2d the coordinator rotates its session at 40 turns and on Fresh coordinator session` | A coordinator-started thread leaves a progress report and an open question, and the owner writes the notebook over HTTP. With `turns: 40` written between close and boot, the next turn has no resume and the exact full fresh context: notebook, the active thread line, the open question, the recap, then the event. The following turn resumes with the events only. Fresh coordinator session over HTTP starts the next turn without resume, with the same notebook, active-thread and open-question block, then the event; the turn after resumes again. A work-settings PUT to another coordinator model starts a fresh session on it, and the turn start records carry the fresh flags and labels for turns 1 to 7. |

## PJ2e - idempotent coordinator messages

| Test | What it proves |
| --- | --- |
| `PJ2e coordinator messages are idempotent by client id` | The same message sent while the turn runs, after delivery and after a restart answers `repeated: true`; the same id with other text is refused 409 `This message id was already used for different content.`. There is one user-message record, one turn and one chat line. |

## Coordinator restart (brief 8.6)

| Test | What it proves |
| --- | --- |
| `a restart drops the running coordinator turn; its events stay queued and the next turn delivers them with the thread interruption (brief 8.6)` | A coordinator turn is held while its thread's turn is held. After the restart both process groups are gone, the thread is `idle` with the restart reason and launches no turn, and coordinator turn 1 ends `dropped`. Turn 2 resumes the dropped turn's session (decision 426) and delivers the queued message plus the `thread-interrupted` restart event in the exact block; the queue is empty, the process record cleared and the hub status idle. |

## Supporting files

| File | Tests | What they prove |
| --- | --- | --- |
| `tests/project-coordinator-loop.test.ts` | 7 | In-process `ProjectWork` with the real hub store: `one turn at a time: events during a turn arrive batched in the next, which resumes the session, until the queue is empty`; `sessions rotate at 40 turns, on Fresh, on an effort change and when the account changes; otherwise turns resume`; `a failed turn retries once with its events in front; after two failures the owner is told and only a message tries again`; `Stop interrupts the running turn, whose events count as delivered; later events run next (D33)`; `without a coordinator model or account the coordinator is unavailable with one notice, asks the owner directly, and runs once it can (D34, D70, D97)`; `a restart drops the running turn, keeps its events queued, and the next start delivers them in a new turn (brief 8.6)`; `coordinator memory tools read project memory through the bridge and leave chat lines`. |
| `tests/project-coordinator-api.test.ts` | 5 | `the phase 2 rows of the route table: coordinator, settings, notebook and answers, with their ids, methods and stream flag`; `streamLedger: refusals before headers, exact frames in 64-event batches, drain backpressure, a 15 s keepalive and the end on a failed authentication`; `coordinator routes: session required, assignment by the first message, idempotent messages, a resumable chat stream, Stop, Fresh and no native session id`; `work settings, notebook and answers: revision checks, the main default coerced with its reason, idempotent answers, counts and retryable outages`; `a coordinator assigned to another device is refused here until phase 5 and shows offline`. |
| `tests/project-coordinator-prompts.test.ts` | 5 | `every event kind reads as brief 9.3, with titles from the indexes, the fallback suffix and the checkout base branch`; `the fresh context lists active threads, open questions and the recap without the batch being delivered (9.2, D36)`; `a first turn with nothing known yet reads (empty) and (none), the PJ2 opening prompt`; `the recap keeps the newest 8,000 characters, oldest first, and drops older items whole`; `sessions rotate at 40 turns, on a pinned model change, an effort change or a session model that cannot run here (brief 8.1, D77)`. |
| `tests/project-coordinator-tools.test.ts` | 3 | `thread tools start, list, read, message and stop as brief 7.1 says, refuse ended and attached threads, and leave one chat line per call`; `questions, the notebook with its revision conflict, pull request status, queued and refused starts, and owner work reaching the coordinator`; `chat lines name what the coordinator did or could not do, in one short line`. Every call goes through the daemon's `/api/bridge` with the turn's scoped token, which answers 401 after the turn ends. |

Leak check (decisions 381 and 425): after every test in `projects-coordinator` and `projects-threads`, `expectNoLeaks` reads every recorded API response, fresh list, work and thread views, the hub thread indexes, the hub coordinator status, every hub record of the project (assignment, decisions including the coordinator's questions, notebook, work settings) and the coordinator and thread ledgers, and finds no native session id, bridge token, GitHub token, browser session value or worktrees root path. `project-coordinator-tools` also records every coordinator tool result and refusal and checks them the same way; a probe that appended a native session id to `jevellan_thread_read` results failed it, and the product was restored.

Per-file results of the full backend run:

| New phase 2 test file | Tests |
| --- | --- |
| `tests/projects-coordinator.test.ts` | 8 |
| `tests/project-coordinator-loop.test.ts` | 7 |
| `tests/project-coordinator-api.test.ts` | 5 |
| `tests/project-coordinator-prompts.test.ts` | 5 |
| `tests/project-coordinator-tools.test.ts` | 3 |
| **Total** | **28** |

With the 20 phase 1 Projects files (198 tests, [PJ1](PJ1.md)) the Projects files hold 226 tests. Existing files changed in phase 2, all passing: `tests/project-copy.test.ts` (7), `tests/project-runner.test.ts` (9, coordinator now `unavailable` in that fixture, decision 413, and the main default read, decision 419), `tests/project-work-api.test.ts` (2, the notebook route, decision 424), `tests/projects-threads.test.ts` (15, the leak check moved to the fixture helper, no assertion changed), plus the helper `tests/helpers/project-fixture.ts`. The conversation stream tests in `tests/conversation-service.test.ts` (94) and `tests/member-application.test.ts` (109) pass unchanged over the shared stream code (decision 422).

## Commands and counts

Node 22.22.0 and Homebrew Git 2.55.0 first on `PATH` (Apple Git 2.39 lacks `merge-tree --merge-base`). Tests import `dist/`, so build first.

```sh
npx tsc -b
npx vitest run tests/projects-coordinator.test.ts tests/project-coordinator-api.test.ts tests/project-coordinator-loop.test.ts tests/project-coordinator-tools.test.ts tests/project-coordinator-prompts.test.ts --reporter=verbose
```

Result: **28 passed** (8, 5, 7, 3 and 5), 0 failed, in 28.0 s, after the last test edit. The complete phase verification (`npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npx playwright test`, `node scripts/secret-scan.mjs --worktree`, `git diff --check`) gave: backend **1437 passed, 4 skipped (live Jev tests without `JEVELLAN_TEST_JEV_KEY`), 0 failed in 114 files (1664 s)**, one run without reruns; existing browser journeys **164 of 164** in 29.7 minutes with four workers (160 layout and keyed, 4 packed installation); vision checks not run; secret scan and whitespace check pass. Three test files were hardened after the backend run (leak check coverage only); their hardened assertions are evidenced by the verbose run above and a solo run of the coordinator tool, coordinator acceptance and thread acceptance files (26 of 26). Details are in REPORT.md under Latest verification.

## Limits

- Everything above is simulated: no live Claude or Codex coordinator turn, no real GitHub repository or pull request, no second device. PJ-live (phase 8) runs the live journey or records it as blocked.
- There is no chat, decision or notebook interface yet (phase 3); the routes and the stream are exercised over HTTP.
- A coordinator assigned to another device is refused with 409, and `jevellan_thread_message` and `jevellan_thread_stop` for threads owned by another device answer `This thread was not found.`, until phase 5. `jevellan_mail_send` is not offered until phase 6.
- After two failed coordinator turns the wait for an owner message is kept in memory, so after a restart in that state the queue also waits for a message (decision 405). Hub status publication is best effort; the next state change corrects a lost write (decision 393).
