# PJ1 - turns, threads, worktrees and pull requests

**Evidence label: simulated.** Projects phase 1 (BRIEF-projects.md section 13, local and untracked like BRIEF.md) passes PJ1 and PJ1b to PJ1f as integration and adapter tests on 2026-10-04 (goncalos-macbook-pro). No part of this evidence is live, and Gonçalo's acceptance is not claimed.

- **Real:** a booted Jevellan daemon (`Application`) with its HTTP routes, browser session and `/api/bridge`; Git 2.55 on a temporary checkout and a bare origin (worktrees, `jv/` branches, private base refs, leased pushes); the hub's SQLite project store; child processes and process groups (restart and orphan cleanup); the stdio MCP bridge `bin/jevellan.mjs mcp-bridge`.
- **Simulated:** model turns, through FakeRuntime scripted turns that call the real bridge and write fake native session files, and for PJ1e through simulated Claude and Codex CLIs (`tests/fixtures/contract-cli.mjs`) behind the real adapters and workers; GitHub, through the local fake server `tests/fixtures/github-server.mjs` injected with `githubFetch` and `githubBaseUrl`, while the project's `remote.origin.url` is `https://github.com/fixture/repo.git` redirected to the bare origin with `insteadOf`; the GitHub token is a random fixture value.
- **Not run:** vision checks (phase 1 adds no interface, and `JEVELLAN_TEST_CLAUDE_TOKEN` is not set), live Claude and Codex turns, live GitHub (PJ-live, phase 8) and a second device (phase 5).

Test names cite the build design's decision ids; [REPORT.md](REPORT.md) lists them under the same ids (for example D9 is decision 244, D16 is 252, D94 is 298, D8 is 243 and D88 is 294).

## PJ1 - owner thread to merged pull request

File: `tests/projects-threads.test.ts`.

| Test | What it proves |
| --- | --- |
| `PJ1 owner thread runs in a worktree, opens a pull request, follows checks and cleans up after merge` | Origin `main` is advanced first. The start answers 201 `preparing`; a repeat with the same request id returns the same thread and the id with other content is refused 409. The first turn runs as the thread with write permissions, the `thread` safety profile, the exact task prompt, the system append naming the branch, base and test command, the project's git identity and the worktree as working directory. The branch `jv/add-greeting-<6>` and the worktree exist outside the checkout, based on the advanced origin. The test command passes (attempt 1), the branch is pushed to the bare origin at the pull request head, and exactly one pull request is created with the brief 9.7 body; every GitHub request carries the API headers and the token. The hub index reads `in-review`, and the coordinator queue holds the owner start line, then the publication. Failing checks are reported once per head, then passing (GitHub's empty pending combined status ignored). After the merge on GitHub the thread is `done` with `endedAt`, the coordinator hears `merged`, and the worktree, local branch and private refs are gone while the remote branch stays. The owner checkout's status, HEAD, `main`, `origin/main` and index digest are identical before and after, and no native session id or worktree path appears in the thread view, hub indexes or ledgers (the transcript `cwd` is null). |
| `PJ1 merge from the API squashes the reviewed head` | A conflict is reported once and refuses the merge with 409 `This pull request has conflicts. Ask the thread to resolve them first.`; GitHub's 405 message is returned as it came; the squash merge sends the reviewed head sha and the thread is `done` without waiting for a poll. |
| `PJ1 publication without a token or a GitHub remote leaves the branch pushed with the documented reason` (no token, not GitHub, no remote) | The thread goes `idle` with the brief's exact reason, makes no GitHub request, pushes the branch when a remote exists (local only otherwise), sends the coordinator a synthesized `blocked` report with the reason, and lists a pushed branch with its reason among the pull requests. |
| `PJ1 done without commits concludes without changes` | A done report without commits concludes `done` with `Concluded without changes.`, removes the worktree and branch, runs no verification, tells the coordinator `no-changes` and makes no GitHub request. |

## PJ1b - verification failures

| Test | What it proves |
| --- | --- |
| `PJ1b verification failure prompts are exact and the three-attempt limit holds` | The test command fails twice and then passes. The fix prompts for attempts 1 and 2 are exact, including the output tails `1` and `2`; the fix turns resume the same native session; the thread reaches `in-review` with pull request 1 and its attempt counter reset; the ledger records attempts 1 and 2 failed and 3 passed. |
| `PJ1b a third failed verification leaves the thread idle and runs no fourth turn` | Three failures leave the thread `idle` with `Tests failed three times.` after three turns; the coordinator receives `thread-verification-failed` with three attempts and the last tail; nothing is pushed and GitHub is never called. |

## PJ1c - synthesized reports

`PJ1c turns without a report or with a failure synthesize the report`: a turn that ends without a report gets a synthesized `progress` report (its text cut to 1,200 characters, `The turn ended without a report.` when silent, the text after the last tool call when tools ran); a turn that throws gets a synthesized `blocked` report with `The scripted runtime failed.`; a rate-limit failure gives a `blocked` report with the provider's message and cools the account. The coordinator's event line carries the brief's ` (Jevellan wrote this report because the thread did not.)` suffix.

## PJ1d - restart recovery

| Test | What it proves |
| --- | --- |
| `PJ1d a restart during a running turn leaves the thread idle and resumes no model` | A restart during a held turn ends the turn's process group, leaves the thread `idle` with `Jevellan restarted during this step.` and no process record, starts no new turn after a pulse, sends one `thread-interrupted` restart event, publishes the idle index, and keeps the browser session answering. A crash that leaves a live orphan is cleaned up the same way; a recorded process identity that does not match the live process leaves that process alone and marks the thread `failed` with `Jevellan restarted and could not confirm this thread's process stopped.`. |
| `PJ1d a restart during setup leaves the thread idle, and the next message prepares again and sends the task first` | A restart during the setup command leaves the thread `idle` without a turn; the next message runs setup again in the reused worktree, and its first turn starts a fresh session whose prompt is the task block, `---`, then the message. |

## PJ1e - resumed turns in both workers

File: `tests/projects-turn-runtimes.test.ts`. Tests: `PJ1e resumed turns pass the stored session id and write permissions (claude)` and `(codex)`. The real Claude and Codex adapters and workers launch simulated provider CLIs. Claude resumes the stored session with `bypassPermissions`, the model and the effort; Codex resumes it with the `workspace-write` sandbox, network on, approval `never` and the effort. In both, the per-launch Safety hook receives the `thread` profile: `git push` is denied with the thread reason and `git rebase` is allowed. Each worker runs one turn, refuses continuation and leaves no process group behind. The same file covers first turns (system append, Codex root `AGENTS.md`), read-only coordinator turns, the Codex worktree sandbox directories, resume through `checkTurnResume` and the Claude text separator.

## PJ1f - safety profiles

File: `tests/safety.test.ts`. Test: `PJ1f thread profile allows rebase and keeps every other denial`. The tested forms of `git rebase` (start, `--continue`, `--abort` and interactive) are allowed for threads; `git push`, `git clean`, hard resets, forced branch deletion, `jevellan restart`, `kill`, `pkill` and nested shells stay denied with `Jevellan handles this. Report what you need with jevellan_thread_report.`, in the shared rule, the Claude permission hook and the Codex hook (which fails closed with the thread reason). Stretch and coordinator reasons are unchanged, and every existing stretch safety case in the file still passes (45 in total).

## Supporting cases and the leak check

The same `projects-threads` file also proves the running limits (decision 244: a full device queues a start with `Queued: <device> is at its limit of 1 running threads.`, an in-review fix turn waits for a slot and then updates its pull request without a second creation, and Discard is refused in review), account pinning (decisions 252 and 298: later turns resume on the placed account, and an ineligible account moves the thread to a fresh session that starts with the task), and the placement phase gates over HTTP (decisions 243 and 294). After every test in that file a leak check (decision 381) reads fresh list, work and thread views and finds no native session id, bridge token, GitHub token, browser session value or worktrees root path in any recorded response, hub thread index or project ledger.

Per-file results of the full backend run that recorded them:

| New Projects test file | Tests |
| --- | --- |
| `tests/project-schemas.test.ts` | 71 |
| `tests/projects-threads.test.ts` | 15 |
| `tests/github-client.test.ts` | 11 |
| `tests/projects-placement.test.ts` | 11 |
| `tests/projects-turn-runtimes.test.ts` | 10 |
| `tests/project-runner.test.ts` | 9 |
| `tests/project-hub-store.test.ts` | 8 |
| `tests/project-ledger.test.ts` | 8 |
| `tests/thread-worktree.test.ts` | 8 |
| `tests/project-copy.test.ts` | 7 |
| `tests/project-stores.test.ts` | 7 |
| `tests/project-turns.test.ts` | 7 |
| `tests/project-admission.test.ts` | 6 |
| `tests/project-bridge-schemas.test.ts` | 6 |
| `tests/project-publication.test.ts` | 5 |
| `tests/github-token-secret.test.ts` | 3 |
| `tests/project-transcripts.test.ts` | 2 |
| `tests/project-work-api.test.ts` | 2 |
| `tests/project-bridge.test.ts` | 1 |
| `tests/project-settings-guard.test.ts` | 1 |
| **Total** | **198** |

Existing files that gained Projects cases, all passing: `tests/safety.test.ts` (45), `tests/git-policy.test.ts` (60, including the two thread-ref regressions for decisions 250 and 346), `tests/native-conversations.test.ts` (15), `tests/stretch-bridge.test.ts` (14), `tests/conversation-ledger.test.ts` (13), `tests/fake-runtime.test.ts` (6) and `tests/worker-run.test.ts` (6).

## Commands and counts

Node 22.22.0 and Homebrew Git 2.55.0 first on `PATH` (Apple Git 2.39 lacks `merge-tree --merge-base`). Tests import `dist/`, so build first.

```sh
npx tsc -b
npx vitest run tests/projects-threads.test.ts tests/projects-turn-runtimes.test.ts tests/safety.test.ts --reporter=verbose
```

Result: **70 passed** (15, 10 and 45), 0 failed. The complete phase verification (`npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npx playwright test`, `node scripts/secret-scan.mjs --worktree`, `git diff --check`) gave: backend **1409 passed, 4 skipped (live Jev tests without `JEVELLAN_TEST_JEV_KEY`), 0 failed in 109 files (1819 s)**; existing browser journeys **158 of 160** with four workers (two phone-dark load timeouts whose file then passed 27 of 27 alone) and **4 of 4** packed installation journeys; vision checks not run; secret scan and whitespace check pass. Details are in REPORT.md under Latest verification.

## Limits

- Everything above is simulated: no live Claude or Codex turn, no real GitHub repository or pull request, no second device. PJ-live (phase 8) runs the live journey or records it as blocked.
- The coordinator does not run turns yet (phase 2): events are queued for it and asserted in the queue, and decision answers have no route yet.
- Accounting failures during a turn are not retried across a hub outage, and a message queued while the daemon shuts down stays queued without an automatic turn after the restart (brief 8.6 resumes nothing).
