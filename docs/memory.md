# Project memory and context

Jevellan keeps hub-mode notes in the hub's working copy of the owner's private GitHub vault, `<home>/vault/projects/<owner>__<repo>/notes`, keyed by the project's origin (a project without a GitHub origin keeps `project-memory/{projectId}/notes`). Repo and device modes use the configured folder, normally `.jevellan/memory`. Basic Memory 0.22.1 supplies the index and note operations. Its configuration, database and process HOME live under Jevellan's `basic-memory/` directory. The user's Basic Memory is not used.

## Shared hub memory (0.3.0)

The 12 October brief replaces metadata-only Projects capture and read-only agent memory in hub mode (decisions 704–705). The P3 implementation uses the existing Projects placement, bridge, launch and mesh services. Verification and live blockers are recorded in PLAN.md and the acceptance report. Repo/device guards and memory care keep their existing behavior.

Hub is the default for new projects and the Ekoa Code preset; existing projects retain their mode. Switching copies current notes once, leaving the original folder untouched. Notes live in `project-memory/{projectId}/notes` in the hub data home, in a private local Git repository with no remote. One isolated Basic Memory process indexes it. Member sessions relay scoped calls to the hub. An offline hub returns and supplies in the prompt: "Project memory is unavailable: the hub is offline."

In hub mode coordinator and coding threads can search, read, write and edit; review/verification sessions can search and read. Code supplies note metadata (source, runtime, model, task/thread references, timestamps and status). Agents supply title and body. Every ordinary write creates a local `{source}: {title}` commit. Notes whose source is owner are never edited by an agent or dream.

Memory holds durable build/test instructions, gotchas, conventions, decisions with reasons and owner work preferences. The notebook holds the coordinator's plan, decisions in flight and open questions. Project now is computed live for every thread turn and is never saved as knowledge.

Projects capture is on by default and configurable per project. Own end-of-turn signals and native lifecycle hooks record the newly written byte range of each transcript, retaining session continuity through compaction. Redaction removes secrets only. Extraction uses up to 300 KB newest-first, at least 4 KB waiting, at most every 30 minutes plus window open; one failed extraction retries at the next opportunity. A low-effort read-only memory session writes zero to eight durable inbox notes with short evidence. Recall includes those notes labelled "(from today, not yet consolidated)".

An empty hub store returns an empty search or title lookup immediately, before starting Basic Memory. Once notes exist, reads use its index. Terminal handback takes precedence over capture availability: a capture failure records its reason, leaves the journal/cursor retryable and releases the attached session and bridge grant.

The nightly memory-dream replaces memory care only in hub mode. It starts at window open independently of ordered items and merge holds, or at 03:00 hub time without a window, with a two-hour cap and Run now. A Jev-placed high-effort session checks inbox/care candidates and today's changes against a read-only main worktree, preserves owner notes and archives rather than deleting durable notes. It updates Project brief within 2,000 characters. One `dream: {date}` commit carries the diff and code-derived counts, displayed as Last night's dream with Undo. Apply and tell me is default; Suggest only waits for an Apply card. The coordinator receives memory-dreamed and the night report includes a line.

Threads receive Project brief plus at most five task-relevant notes on their first turn and after compaction (5,000 characters total; 600 per note), scored by Jev with search-order fallback. Why exposes the selected notes and reasons. Coordinator fresh context receives Project brief and 30 recent titles. Every thread turn also receives bounded live Project now with other threads and merges in the last 24 hours.

## The vault (phase 5)

One working copy at `<home>/vault` holds every project's folder: `notes/`, `project.json` (`vault-project-v1`: settings, goals, jobs and dailies by name, never ids, paths or secrets) and `notebook.md`. Each write is one commit scoped to the project's folder; dreams and imports work on a copy of the whole working copy, so Undo (`git revert`) and the concurrent-note merge keep working. Device-local state (dream state, receipts, session files) stays in `project-memory/{projectId}/`. Notes kept before the vault are copied in once; the old folder stays as it was.

The hub pulls with rebase at start and before each memory session or dream, and pushes 60 seconds after the last commit and at shutdown. A note edited on two hubs keeps both versions with the preservation described under Publication and conflicts; other files keep this hub's version. When GitHub cannot be reached, memory reads and writes continue locally and pushes retry after 1, 5 and 15 minutes, then every 30; Settings → Projects shows the error. The token travels per command and never enters the remote URL or the repository configuration. Nothing is reset or force-pushed.

## Isolation and synchronization

The daemon owns an isolated MCP process per project. Legacy indexes use `jv-{projectId}`; hub indexes use `jv-hub-{projectId}`. Dream copies register on that same private hub process with explicitly scoped calls, so staging does not spawn another index process. Agents receive only Jevellan's scoped bridge tools. They cannot choose another project or call the provider's project-management tools. Provider processes receive a filtered environment, with explicit local routing, self-updates and background synchronization disabled. Semantic downloads and telemetry are disabled too.

Synchronization is explicit. A small Python helper calls the pinned provider's foreground sync API in its own virtual environment. It validates the registered project path, including Basic Memory's normalized registry names, before indexing. Each provider sync is a full foreground Python run (about six seconds of CPU on the build VM), so the daemon skips it while the memory folder's names and contents are unchanged since its last sync. Any provider write through the bridge invalidates that record, so a note written and later removed on disk (for example by undo) is still dropped from the index. In repo/device modes, indexed notes are not rewritten to add frontmatter or permalinks. A hub switch normalizes only its new copies, protecting unknown legacy sources as owner notes; the originals remain byte-identical. Existing permalinks are preserved; otherwise the exact relative Markdown filename is the note reference. Database files remain outside the repository.

To add memory by hand, write Markdown in the project's memory folder. A note may have YAML frontmatter such as `title: Test conventions` and `status: unresolved`. The owner's next explicit sync indexes it. Do not place secrets in project memory. Repository-mode notes travel through git; device-mode notes are excluded with an anchored entry in `.git/info/exclude` and never committed. A device-mode folder must not already contain tracked files.

## Conversations recall and capture

Recall searches literal words from the original request, the latest message and the action. The provider ranks the union of those terms; sending a whole request as a phrase would miss relevant notes. Jev scores up to twelve candidates from 0 to 3 and selects at most five scoring at least 2, with 300-character excerpts. Manual mode and failed scoring use the first five search-ranked candidates, recording that source explicitly. The brief enforces its separate 2,000-token memory budget and labels unresolved notes. The saved selection and its source are visible in Why; see [decisions](decisions.md).

Writing actions and explicit remember replies use the bridge's write and edit tools under checkout ownership. Other stretches can queue proposals. Handoff findings prefixed with `memory:` become proposals whose bodies contain the evidence pointer and a conversation link. Repeated capture and repeated identical tool calls reuse their durable proposal.

Project memory is a built-in Rigging item, on by default with separate runtime toggles. APM delivers capture hooks to each account home; launches verify that delivery. PreCompact, Stop and SessionEnd queue a structural checkpoint using the owner's recorded step metadata. Events and retries coalesce into one proposal per step. This legacy Conversations path captures structural metadata only and has no hook recall. Projects capture incremental native transcripts as described above. Ordinary answer-only replies and handoff repair do not create automatic notes. The active toggle and stretch-token lifetime also fence capture. A lifecycle notification is not a completion receipt; follow its conversation link for the final handoff and verification. Agent tools and handoff capture remain available when the hook is off.

The queue applies only at a settled boundary of the same open work, after confirming checkout ownership. It preserves any existing note with the same title. It checkpoints before recording the application receipt. If the daemon stops after writing a note or checkpoint but before recording the receipt, retry finds the existing note and finishes the checkpoint/receipt without duplicating it. The queue remains pending when another work owns the checkout.

## Publication and conflicts

Publication checks the complete change from the work's recorded base. A change confined to the configured repository-memory folder, including attachments, may publish without running the project's code test command. The publication receipt explicitly records `verificationExemption: memory-only`. A code change or a file moved into memory from elsewhere still requires verification. After bringing in upstream work, publication checks the remaining change again; an integration stretch that introduces code loses the exemption. Checkout ownership, a clean checkpoint and the remote publication lease are required in both cases.

Before pushing an exempt commit, the ledger records its exact commit, original work base and upstream. A retry after a failed push or index sync can reuse that classification for that exact commit, even after restarting. Otherwise unrelated upstream code brought in by rebase would be mistaken for this work's code changes. Any later local commit needs a fresh classification; the old receipt cannot exempt newly added code.

When every conflicted file is a regular UTF-8 Markdown note inside that folder, Jevellan resolves the Git conflict by retaining the upstream note and appending the complete local version under `## Merged from {device} on {date}`. It sets the outer frontmatter's `status` to `unresolved`, preserving valid upstream metadata. Invalid frontmatter is retained as text under a valid outer status. A delete/modify conflict keeps the surviving note and a deletion notice. Repeated conflicts retain the earlier appended versions too.

This is preservation, not semantic reconciliation. Recall labels the note `(conflicting versions, unresolved)` until memory care reconciles it. The service refreshes the isolated index after successful publication so subsequent recall sees the current file. Git's rebase stage 2 is the upstream/rebased side and stage 3 is the local commit being replayed; see the [Git rebase documentation](https://git-scm.com/docs/git-rebase/2.50.0).

Binary, invalid-UTF-8 and symbolic-link conflicts, and conflicts outside memory, go through the normal integration stretch. A mixed conflict discovered later in the rebase aborts all tentative note merges and saves the original checkpoint tip before integration. Successful automatic merges have a versioned ledger receipt naming the paths and source blob ids. No process installs a Git merge driver or changes project Git attributes.

## Instruction files

`ProjectContext` inspects `AGENTS.md` and `CLAUDE.md` without changing either. If one file exists, it supplies a local symlink for the other runtime when necessary. A runtime proven to read `AGENTS.md` needs no compatibility link. Claude's live capability check is currently blocked by the absent test credential, so the conservative default creates its compatibility link.

When neither file exists, creation must be selected. The seed names the project, test command and memory folder. On an external project, the seed and link remain locally excluded. When both files exist separately, the choices are keep either primary, apply a reviewed merge into `AGENTS.md`, or leave both alone. Settings → Projects records the observed state and shows a badge until a decision is made. Create AGENTS.md is checked by default when adding a project.

Every filesystem change requires checkout ownership. Keep/merge choices include the fingerprint of both files and their tracked state; a changed file is preserved and the choice is rejected as stale. Local links are excluded from git. Replacing a tracked file is a real change for the main-policy checkpoint. External projects reject tracked replacements and merge applications. Outside, circular and dangling links fail explicitly rather than reading another file.

Context changes run as visible conversations titled `Context · {project}`. Local compatibility links need ownership but no commit. Real main-policy changes start from a clean, synchronized checkout, create a checkpoint, and pass Jevellan's normal verification and publication path. A failed verification retains the checkpoint and ownership; Retry attempts publication without replacing the files again. Open work exposes the existing settlement controls.

Merge starts a read-only reply stretch with an explicit merge-draft contract, using the selected model or the first eligible menu model. The complete draft and original file contents are persisted for review. Settings shows both replacements, including the CLAUDE.md link. Apply and Cancel carry client request ids and conversation generations; retries cannot turn a pending review into approval. A restart preserves a ready draft and never launches a model automatically. A changed project revision or file fingerprint blocks application without overwriting the newer state. Ambiguous interrupted filesystem changes remain blocked for inspection.

## Implementation state

The provider backend, scoped bridge, manual recall, durable capture queue and context-file operations have component tests. Installed-provider tests use actual Basic Memory in disposable homes; queue/checkpoint tests use real git with a simulated memory port. Context tests adapt Garrison's never-clobber regression for both instruction files.

The owner loop, Projects editor, read-only memory viewer and context create/keep/merge workflow are connected. Memory-only publication, automatic note-conflict preservation and post-publication index refresh have actual Git/provider and simulated-runtime service evidence; see [publication checks](acceptance/phase2-memory-publication.md). [Hook capture checks](acceptance/phase2-hooks.md) cover actual APM delivery, scoped subprocesses, SDK wiring through simulated providers, native Codex discovery and owner-side queue application. Native lifecycle dispatch still needs live journey evidence. [J11](acceptance/J11.md) records the single-device live Codex journey and the cross-device journey using real Basic Memory with local simulated devices/providers. Nightly memory care and AGENTS.md context suggestions are described below; see [phase-6 memory care](acceptance/phase6-memory-care.md) for evidence.

## Memory care and context suggestions

Memory care runs once per project per night, and whenever you press Run now. The hub hands the project's job to itself if it has the checkout, otherwise to the first online device that does (by join date). It runs only once per project and night. On that device the job first checks that no work owns the checkout and no outside agent is active. It then fast-forwards the clean checkout to origin/main and refreshes the isolated index. If the checkout is owned, the job is skipped and reported as "skipped: {project} is in use".

Candidates are collected in code:

- notes changed since the previous care run (Git history from the last recorded commit);
- notes marked `status: unresolved` or containing `## Merged from`;
- pairs with near-identical normalised titles, or mutual top-five Basic Memory search hits, where at least one note changed;
- notes older than 90 days (last commit, or file time outside Git) that no other note links to;
- broken `[[wiki]]` and relative Markdown links.

Jev judges them in one batched request: a Noul per pair ("These two notes describe the same thing") and a Noul per stale note ("This note is still useful for work on this project"), with the device's last ten handoff summaries for that project as state. A pair is merged at a probability of 0.7 or more. A stale note is archived at 0.3 or less.

A private read-only draft works on copies of the involved notes under the isolated home's `tmp/`. It returns a `memory-patch-draft-v1` that merges confirmed pairs, reconciles unresolved notes (keeping the superseded text under `## History`) and fixes links. Jevellan itself moves stale notes to `archive/` unchanged; nothing is deleted except a duplicate folded into its partner. Code refuses patches that touch unconfirmed notes, create notes or archive by themselves. It computes the counts from the patch, not from the draft's summary.

In "Apply and tell me" mode the patch is applied only if every file still has the hash it was computed from. The job takes checkout ownership and commits `memory: nightly care ({merged} merged, {archived} archived, {fixed} links)`. It publishes through the normal memory-only path, with no test run. A changed note causes one recomputation, never a forced write. If publication cannot finish, the local commit is saved under `refs/jevellan/discard/...` and discarded, and the checkout is released. The morning card offers the diff and an Undo: a published `git revert` made under ownership. In "Suggest only" mode the same patch becomes a suggestion card, and the checkout is untouched until Apply, which uses the same checks. Only one memory care suggestion per project waits at a time.

Context suggestions run after memory care for the same project. Groups of three or more related notes (by title or mutual search overlap) get one Noul each: "These notes state a working rule for this project". Each confirmed group gets one short read-only draft of a complete new `AGENTS.md`, or of `CLAUDE.md` when `AGENTS.md` links to it. It arrives as a suggestion card and is never applied automatically. Apply commits `context: {title}` and publishes under section 11, including the project's test command. External projects are skipped. Dismissed and decided suggestions are not repeated while the involved notes are unchanged.

If a daemon stops while an improver operation owns a checkout, the next start checks the operation's journal. It restores any written patch text, saves and discards unpublished improver commits, and releases ownership. Anything unexpected stays owned for inspection.

## P1 session implementation checkpoint (2026-10-12)

Coordinator sessions now continue beyond forty turns, including after a daemon restart. Model/runtime/effort/account changes, missing native sessions, device moves and Fresh session retain their existing fresh-session rules. Project settings accept compactAtPercent from 50 to 90, default 70, preserving migrated v1/v2 fields and omitted owner settings. Claude uses the per-turn CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Codex uses the discovered model context window and model_auto_compact_token_limit; an unknown window uses the native default and shows a notice. All Projects session kinds receive the setting.

Runtime context and compaction events are separate from billed usage. Versioned ledger receipts preserve reported counts and explicitly mark unavailable counts as null. Coordinator and thread compactions keep the native session and refresh the next task/context prompt. Review, verification and future memory sessions record receipts in the project coordinator ledger. The panel shows context percentage when known, today's compactions, last compaction and Fresh session; the saved threshold is beside coordinator settings. Native account configuration remains unchanged. Shared recall and Project now remain P3 work.

Simulated evidence: 107 focused backend cases pass, covering persistence, restart, compaction, migration, production/test bounds, isolated journal/model reads and byte-identical fixture native homes. Browser/vision verification and real scenario C are recorded separately in acceptance/coordinator-memory-terminal.md; owner inputs still block live provider acceptance.

## P2: numbered answers and GitHub awareness

Open questions use one oldest-first order (created time, then id) in cards, fresh coordinator context and resumed event blocks. Ask/answer tool receipts include the current numbered list, so questions created in the turn have the same numbers the owner sees. Chat answers are allowed only during a turn consuming an owner message, record source owner-chat and quote that turn's owner words. A batch preserves every message rather than attributing an answer to only the last follow-up. Retries complete one answer and its existing Ekoa mirror once. The coordinator distributes each answer explicitly; it gets no redundant decision-answer event. Panel answers retain their normal path. Owner CI-log messages are bounded at 200,000 characters to support the specified compaction scenario.

The read-only jevellan_github tool exposes repository runs, jobs and bounded log tails, pull requests from all authors, changed files/checks and recent commits with merged-pull associations. It resolves the checkout's raw origin and uses the existing project token and request budget. A 60-second per-request cache coalesces concurrent calls, excludes errors and separates token rotations; scope and current head are checked even on cache hits. Threads can read only their own pull request and runs/logs at its current head. Results are versioned, secret-redacted and bounded. Log downloads retain a streaming tail with a 64 MB transfer ceiling and timeout; the returned tail is at most 8,000 characters.

Simulated: 135 relevant backend cases in ten files and six workflow cases pass, with a focused final rerun for batched chat provenance, large owner messages and shared rate accounting. CM2 passes four layouts; the retained eight dedicated live vision judgments have no blocking findings. Typecheck/lint/build pass. Actual GitHub bridge calls through owner Settings remain blocked on the pending token, and no real provider scenario or owner acceptance is claimed. Shared capture/recall remains P3 work.

## P3 delivery details

Hub conversion imports bounded batches into a private copy and activates only a complete, validated import. Hub and legacy registry names cannot collide. Writes have durable receipts and per-note retry markers, preserving append idempotency even after an intervening edit and a lost receipt. Owner sign-in uses the existing device-bound session token for local and relayed APIs.

Capture redacts complete native records before transport. Oversized records are split without discarding text; fragment metadata refers to the same original byte range, and the cursor advances after all fragments are acknowledged. Extraction bounds both UTF-8 bytes and characters to 300 KB, with an explicit trimming notice. Inbox provenance records the learning provider and supplied task/thread evidence. Legacy-mode captures can be retained before an explicit hub switch; automatic hub extraction and consolidation do not loosen legacy write guards.

Memory sessions run on the hub, with Jev choosing an eligible provider/account. The dream uses a read-only main worktree and private notes copy. Nonconflicting concurrent notes merge on another disposable copy; conflicts leave current notes intact. One applicable commit supplies the actual diff and counts, and Undo reverts it while preserving later knowledge. The code watermark starts at current main, advances after Apply and returns to its prior value after Undo. A dream finishing after ordered jobs still updates the night report and coordinator. Run now persists its request before launch and recovers its receipt across restarts.

The Memory panel shows capture, Apply and tell me or Suggest only, Inbox (from today), Last night's dream, actual changes and Undo. Note lists are bounded previews; opening a note reads its full content. Explicitly reapplying the old Ekoa preset updates only hub memory and the enabled independent dream, preserving owner edits to the loop. Real provider acceptance remains blocked on the already requested owner activation inputs.


## P4 runtime scope

Codex full access is scoped to Projects coding threads. Coordinator, review and memory sessions retain their read-only runtime requirements, and hub memory tools retain their separate note permissions. The refreshed checkout/protected-path guard and structured owner-command handoff do not change capture, recall, owner-note protection or native homes. Terminal reads and returned owner-command output redact secrets before entering agent context.

## P5 terminal continuity

Browser takeover runs the existing attach command. Its isolated native session gets a scoped bridge for memory, GitHub and terminal reads while attached. Capture hooks can forward a changed native session only when it is in that account home and has the thread's working folder; detach captures the adopted session and expires the grant. No task control or report tool is exposed while the owner holds it. Hub memory permissions remain unchanged, and legacy memory remains read-only.

Owner-terminal command records and two-megabyte scrollback are device state. Agents read redacted bounded snapshots through the hub's existing project scope. Exact owner-command results and explicitly sent output use ordinary session messages, so normal capture and extraction can retain durable learning from them. Terminal metadata and once-only result receipts are versioned and survive browser navigation; raw terminal output is not copied wholesale into shared notes.


## Scenario verification

The live working-day/night harness checks source-provider frontmatter, cross-provider first-turn recall, learned setup on the first push, notebook answers, Project now, dream changes and byte-identical owner notes. Dream input fixtures are imported as copies through owner operations; the harness never edits the native memory folder. Reports are checked against the notes commit and real current memory. Extraction/dream runtime usage is recorded in project-session-end-v1 in the existing project ledger. Capture content and native transcript paths are omitted from committed scenario receipts.


The original 0.3.0 closing checkpoint published and activated that version with its complete cold 0.2.1 restore retained. Current Pro activation is 0.3.3; both members, both Codex sign-ins and project GitHub entries are ready. Full current cold rollback is retained. The Ekoa preset now uses hub memory with capture and the independent dream enabled; other existing projects keep their memory mode until changed in Settings. Source gates pass: 2,020 backend tests in 182 files, all 292 unique browser cases through the complete matrix and affected reruns, 582 clear dedicated vision verdicts, typecheck/lint/build and both source-bound platform archives. The single closing review and permitted second are finished. Live cross-provider extraction, recall and dream acceptance remain unclaimed; Ekoa MCP login and formal provider scenarios are pending; no scenario clock or owner acceptance has started. See acceptance/pro-hub-030-live-2026-10-13.md and the ordered activation handoff.


Live activation checkpoint: the owner delegated browser driving, and the protected hub login is awaiting the existing passphrase/1Password unlock. Both member packages are verified/unpacked with actual 0.3.0 CLI checks. Confirmed abandoned installation builds reclaimed another 7.6 GiB on Madrid, whose Ekoa disk guard still fails. The Mini pilot/apps/fence remain retained; original URL acceptance is pending its apps-only service/join. Current diagnostics require account freshness and Jev model discovery in Settings. No real scenario clock, owner acceptance, source change or additional review started. See acceptance/computer-activation-2026-10-13.md and decisions 752–753.


## Activation continuity — 13 October 2026

The shared Jevellan handoff records the authenticated Pro, current account/model readiness, the imported-history replay blocker and its 0.3.1 repair. Source checks and fixture vision remain separate from real provider/memory scenarios, which have not started. Keep native homes and old note stores untouched. The repair changes only conversation ownership bookkeeping; capture, recall, hub notes and dream behavior are unchanged. See [the repair evidence](acceptance/hub-history-rebinding-2026-10-13.md).


Live follow-up, 13 October: 0.3.1 is published and healthy on the Pro. Twelve histories and retained account/vault/project data pass preservation, with full cold rollback retained. The separate live sandbox uses hub memory and the requested gate/coordinator configuration; its Pro terminal/copy preflight passes. Fresh Pro/Madrid space is above the unchanged guards. Ekoa binding is held by preserved legacy work pending an owner decision; protected sign-ins, member-access confirmation and scoped credentials remain pending. Formal scenarios and phone acceptance have not started. See [release evidence](acceptance/release-031.md).


Live activation follow-up: the Pro Codex account is signed in as goncalo@ekoa.io and labelled Ekoa Codex, with Ready status and its 90% ceiling retained. GitHub browser confirmation is complete. The Pro sandbox Git check passes using the machine connection preference in Jevellan, without changing native Git configuration. The owner approved the prepared repo + workflow grant. The classic token expires 12 November 2026 and is saved only in the sandbox and Ekoa project vault entries; the default remains unset. Live PR, Checks, commit-status, Actions runs/jobs and Variables access pass using each saved entry. Member access, retained Ekoa work, Ekoa MCP credentials and real scenarios remain pending. Decisions 763–765 and acceptance/pro-codex-auth-2026-10-13.md record the checkpoint.


Decision 766: the real invoices/customers sandbox is published at 61fc71abcf86d4cd14a127bb47ff473fddece17b with sandbox-baseline; loop-pilot-baseline retains the original pilot. Only the sandbox NIGHTLY_SCHEDULER is set to jevellan. Its original Vitest 5 pin requires Node 22 and fails the new actual Node 20 install/run regression before the fix. Pin Vitest 4.1.11; ten affected harness/regression cases pass, including real engine-strict npm installation and generated-app execution on Node 20. The actual app passes lint, three unit tests and eight page cases in phone/desktop light/dark layouts. Dedicated vision credentials are unavailable, so those eight vision checks are blocked. The installed Pro daemon stays 0.3.1; the corrected harness runs from current main. No formal scenario/clock or new review started.


Decision 767 supersedes decision 764's pending grant: the owner approved the prepared thirty-day classic repo + workflow token, and ordinary GitHub UI generation and Jevellan Settings storage complete. Both project entries pass live PR, Checks, commit-status, Actions runs/jobs and Variables reads; the shared default remains unset. Ekoa PR208 remains open with result passing, and its scheduler variable remains unset/watch mode. No Ekoa merge, workflow dispatch, member enrollment or formal scenario starts. Remaining blockers and the unchanged scenario clock are recorded in acceptance/github-scoped-activation-2026-10-13.md.


Decisions 768–769: the owner authorizes Madrid project work and Mini apps-only membership. The Mini is online on 0.3.1 at its retained 9444 HTTPS address, with both original 9600/9601 app URLs returning 200 and all fifty app files byte-identical. The pilot home/fence remain intact. Madrid uses a fresh /home/ggomes/.jevellan-member because the earlier .jevellan directory contains Cursor data; that directory stays untouched. Madrid joins, but its initial user service rejects the old quoted WorkingDirectory. The native regression fails on both ordinary and special-character paths before the fix, then 33 service/file cases pass on Linux. Accept only the exact known legacy unit for repair, retaining changed-file and live-service guards. Prepare corrective 0.3.2 without changing the immutable older releases or adding a review. Remaining activation, sign-in and scenario evidence follow after the patch. See docs/acceptance/member-activation-2026-10-13.md.


## 13 October 2026 — Approved members online

Decision 770 supersedes decisions 768–769's pending member activation: both members are online on published 0.3.2. Madrid uses its isolated member home and retains its existing membership, HTTPS address and 0.3.1 rollback. The Mini remains apps-only; its two original app URLs return 200 and fifty original files are byte-identical. Both authentication-file fingerprints match across the update. The Pro remains healthy on 0.3.1; its latest observed resources fail the normal disk/load guard, so no forced update or guard override occurs. Madrid's protected owner checkout is saved and read back. Real Madrid terminal hostname/pwd/copy/reconnect preflight passes; formal D and physical-phone acceptance remain unclaimed. Its isolated Ekoa Codex sign-in is complete: the normal device flow selects goncalo@ekoa.io, and the hub records Madrid Ready with fresh 2% weekly usage. The five-hour figure remains unknown. The earlier expired challenge needs no owner action. No formal scenario clock or additional review starts. See docs/acceptance/member-activation-2026-10-13.md.


## 13 October 2026 — Correct release identity before activation

Decision 772 replaces decision 771's provisional package identity checkpoint. Archive verification catches an advertised CLI version of 0.3.2 despite 0.3.3 manifests, before installation or GitHub release publication. Synchronize the runtime VERSION and add an actual-CLI regression in an isolated home: it fails before repair and passes after it. Preserve the failed private candidates. Only this run's new unpublished v0.3.3 tag is retargeted to the correction, with an expected-old-target lease; earlier published tags/assets and both source commits stay preserved. Rebuild and verify both final packages before publication/activation. This adds one passing check to the earlier 187 affected cases; no additional review or live scenario starts.


## 13 October 2026 — Old work closed and Ekoa clones bound

Decision 773 completes 771–772's live recovery: published 0.3.3 from f02f27b is healthy on the Pro under its retained user service/HTTPS address, with accounts/settings/vault/authentication/identity and 37 original history files preserved. Full cold 0.3.1 restoration and all earlier backups remain. The owner-approved normal Keep control closes the old Ekoa work and releases only its imported claim. Both dedicated clean-main clones are now bound to the existing Ekoa registration, allowing Pro/Madrid and retaining project-only GitHub scope; Mini remains excluded/apps-only. Both final platform assets match published digests, actual CLI/native PTY and 21 files/10 assets. Preset/MCP/provider acceptance remain pending; no formal clock, extra review or owner acceptance is claimed. See docs/acceptance/release-033.md.


## Live Ekoa preset checkpoint, 13 October

Decision 774 replaces decision 773's pending Ekoa preset application. The normal authenticated setup operation configures the existing Ekoa project on the active Pro hub: six goals, two active, all Propose tasks; shadow merging with requiredChecks [result]; the exact thread rules/risky areas; worktree isolation and npm ci; 01:00 Europe/Lisbon Nightly; hub memory, capture and the independent dream. Only Pro and Madrid are allowed, with limits 6/8 and project limit 12. The first review starts at current main 770e76b, not the whole history. The selected existing Opus model is unchanged; only its display label is corrected. The real coordinator completes a refill, reads memory/GitHub commits and proposes two drafts; neither is approved or starts a coding thread. Live Variables read at 14:34 UTC finds NIGHTLY_SCHEDULER unset, so watch mode remains; PR208 is open/unmerged. Ekoa rejects the browser's saved login; the visible login panel awaits the owner's correct existing credential. MCP, provider journeys and phone acceptance remain blocked/unclaimed; no formal scenario clock or additional review starts. See docs/acceptance/ekoa-preset-live-2026-10-13.md.


## Prior live acceptance correction, 13 October

Decision794 records live partial C1–C3 continuity: the Claude coordinator compacts in its existing session and its refreshed notebook/memory context preserves the invoice title convention. C4 fails before Codex compaction on a member thread-stream race, repaired with a failing-before regression. Full scenario and cross-provider compaction acceptance remain pending. The Ekoa browser sign-in is now complete; its OAuth-only MCP remains blocked by the current static-token client, as decision788 records. No memory feature or native home changes here.


## Third C correction, 13 October

Decisions796–798 preserve the real third C evidence: Claude C1–C3 pass; Codex compacts and resumes, but the owner merge answer is rejected on the member. Full C remains in progress. Its unrelated PDF work exposes the managed-worktree preview refusal. Both product paths now have failing-before regressions; compiled changes await the retained result before private activation. No memory feature or source/native memory folder changes.
