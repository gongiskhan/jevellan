# The Projects loop

The coordinator receives owner messages and durable project events. It answers readable questions in chat, routes follow-ups to existing threads and creates tasks for new work. Propose mode keeps owner-request tasks as drafts until approved. The Overview brings numbered questions, proposed tasks, running work and pull requests together.

Concurrent refresh/event triggers share one in-flight task sweep, and shutdown drains it before closing services. The queue dispatcher applies task dependencies, ordering, Now, goal states, concurrency, daily start caps and device guards before dispatch. Jev chooses bounded placement and eligible accounts. Worktree isolation protects the registered checkout; Main uses checkout ownership, mail and reservations. The Mini remains apps-only.

Threads use the project instruction snapshot and supported native setup, shared memory and fresh Project now state. Reports return progress, tests, changed files, questions and owner commands. Usage limits retain the pending turn and retry account admission. Long waits and repeated failures can ask Jev to choose another model or effort within owner constraints. No heuristic routing chooses meaning.

A done report enters managed publication: leftover commit, exact-commit verification, lease-protected push and pull request creation or update. Agents do not push or open pull requests. Pull request polling automatically delivers failing checks, conflicts and batched review comments back to the same idle in-review thread when enabled. Bounded rounds end in an owner decision; owner repair buttons use no automatic round.

The merge gate asks Jev for merge, test then merge or ask-owner at the current head. Required checks must pass; no-check heads otherwise wait five minutes. With automatic merge off, shadow mode still records Why. With it on, read-only verification can use another provider before a squash merge. The coordinator has no merge tool. Pending messages, moved heads and nightly holds prevent automatic merges.

Goals refill with useful tasks subject to autonomy and caps. Every enabled nightly item runs at the nightly window even if it ran during the day. Review since last starts from an explicit watermark, includes direct pushes, and produces one report. The coordinator can queue one finding task directly. Job execution begins after that fix merges, needs the owner, is not created within twenty minutes, or reaches the cutoff. Other queued tasks keep starting; their merges wait.

A late window uses its actual opening time for the 150-minute fix cutoff and seven-hour cap, and reports why it opened late. After the cutoff no fix merges until the hold releases. Ordered job receipts identify actual workflow runs and the exact tested/deployed commit. Failed gates skip deploy. A night report links each run, its result, reason and commit, plus review/fix/dream outcomes; failures mirror one Ekoa night-report item.

Ekoa Code uses the repository's NIGHTLY_SCHEDULER variable as the switch. A value of jevellan permits dispatch; anything else or a failed read means watch. Jevellan never sets it. Dispatch runs on main with supported sha inputs and verifies run titles and required jobs/steps. Watch binds only to the real scheduled legal → workflow_run deploy → workflow_run tests chain. Pinned refs remain an option for workflows with no commit input, with cleanup after runs and expiry cleanup at window opening. The independent Ekoa switch and owner activation remain outside sandbox acceptance.

Hub memory is shared across providers/devices. Turn capture supplies redacted transcript ranges; extraction produces inbox notes, recall shares them the same day, and the nightly dream consolidates durable knowledge against the code. Owner notes stay protected. Repo/device memory modes retain their existing behavior. The notebook holds plans; the rebuildable journal holds execution history.

Library files are hub-owned and hash-checked into read-only member mirrors. Variables, vault secrets and confined untracked files are supplied only to execution scopes. Scoped rigging, owner terminals, image viewing and push notifications support the owner's phone workflow without changing native homes or logins.

Paused and archived projects start nothing new; running turns finish and owner operations/polling continue. Resume immediately sweeps queued work. Resolve retains branches and worktrees, withdraws questions and supports Reopen. Full settings and UI details are in [Projects](projects.md).

The [parity run log](acceptance/projects-parity-2026-10/README.md) is the current evidence index. [Loop history](acceptance/loop-history.md) preserves the previous file byte for byte, with all checkpoints and decisions in their original order. Historical delivery and owner-acceptance claims are not inferred from this current-state reference.

Completed jobs record successful cleanup after their owned processes, worktrees and private refs are settled. Later sweeps retain the receipts without repeating historical Git cleanup; interrupted cleanup is retried.
