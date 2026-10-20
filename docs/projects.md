# Projects

## What Projects is

One project is one repository. Talk to its Coordinator to ask a question, plan work or continue an existing Thread. Claude Code and Codex sessions run on eligible mesh devices, using Jevellan's accounts and isolated runtime homes. Conversations keep their existing behavior.

## The coordinator

The coordinator reads the repository, project instructions, notebook, shared memory, thread reports, GitHub and owner terminals. It has no shell, repository write tools or merge tool. It answers quick questions itself and creates queued tasks for changes, runs and long investigations. Independent worktree tasks can run together; dependencies and project/device limits constrain ordering.

Each task created or started in chat has a live card. A follow-up shows the existing thread's card with “Sent a message”. In Propose mode owner-request tasks are drafts until Start, Start all or an owner-authorized `jevellan_tasks_start` call. Routing lines say where each item went.

The coordinator's model and effort are owner settings. Jev chooses thread placement and accounts from eligible choices. The coordinator can change only the small settings allow-list in a turn consuming an owner message: running and daily thread limits, start mode, automatic fix switches, appended project instructions and placement guidance. Each change appears with Undo; Undo refuses to overwrite a later edit.

Open questions are numbered oldest first, identically in chat and Waiting for you. The owner can answer cards or several numbered questions in one chat message. The coordinator records chat answers and delivers them to the correct thread.

A coordinator retains its session across ordinary turns. At the configured context threshold or nightly reset, it writes a handoff accounting for every owner message before starting a fresh session. A missing owner message refuses the reset. The new session receives the handoff, Waiting items, current threads and deploy message, memory and transcript paths. Native compaction remains a last resort at 95%. A model, runtime, effort or account change, missing session, device move or Fresh session starts a new one. An unavailable account leaves work waiting for admission; queued events remain durable. A failed turn retries once before resting with its reason.

Before a turn, Jev interprets each new owner message: an answer, a change, a running app, verification or something else. That interpretation is one Jev decision, and every Jev decision (placement, account choice, follow-up routing, merge route, conversation steps, memory selection and memory care) has one overall deadline of twice the configured per-attempt timeout plus six seconds. With the default 4-second timeout, that is 14 seconds. The deadline covers obtaining the client, reading the configuration and key, any settings read the decision needs, and every attempt. When it passes, the decision takes its usual fallback, and an uninterpreted owner message reaches the coordinator as "Jev could not interpret this request", leaving the coordinator to decide the intended result. Fresh session, Stop, Move coordinator and shutdown abandon an interpretation still in progress, so it never holds the coordinator or a restart.

First use of an empty project, or Suggest setup in the project menu, asks the coordinator to inspect the actual repository and propose an editable Suggested setup card. Apply changes only selected rows with revision checks; suggested goals begin paused in Propose mode. Not now leaves settings unchanged. Variable and secret values are filled in separately by the owner.

## Threads

A thread carries one task through turns, reports, verification and publication. A new thread snapshots the project's instructions; later edits reach the coordinator as an event and apply to future threads. Codex reads root AGENTS.md, falling back to CLAUDE.md only when AGENTS.md is absent. Invalid existing instruction files fail explicitly. Supported native setup is read without modifying the owner's native homes.

Every thread uses a separate branch and worktree. The registered checkout stays outside thread work. The Mini is apps-only and cannot be selected for project work, including fixed overrides.

Settings → Projects sets the maximum number of running threads across every project and device (6 by default, 1–20). The hub counts live indexes and short claims for starts being dispatched. A disconnected device finishes its current turn; new work waits for an acknowledged hub slot. Per-project and per-device limits still apply. Lowering the limit never terminates a running turn.

A project switching to landing retains the previous automatic-merge policy for its existing pull requests. `autoLand` governs new landing work; it does not convert existing threads or authorize their pull requests.

Command jobs may publish a bounded `project-job-deliveries-v1` data manifest. The daemon uploads declared dev files to Library, creates base-only managed branches and imports ordinary goal-linked tasks idempotently. A configured trusted gate runs from the pinned job checkout before landing and after every rebase; private gate input stays outside Library and agent tool targets. Gated tasks run on the device holding that private input and use merge commits. Missing input or a failed gate blocks landing. Only actual landing indexes with a passing gate produce scheduler-owned landing receipts.


Thread reports include status, summary, tests, changed files and optional owner commands. Finished, stopped and failed threads remain available for continuation; follow-ups pass through Jev's placement rules. Active tools and thinking expand, while completed tool blocks collapse. Images can open in the session image viewer.

The session information area holds runtime, model, effort, account, device, branch, usage, Why, overrides and takeover controls. Open terminal here and Take over in browser use the thread's actual device and worktree. Owner shell commands show their full text, purpose and location with Copy and Run in Terminal. Prompt commands offer Copy and the named device's Claude app instructions; they cannot run in a terminal. Shell integration returns the result automatically to the requesting session. Agents can read owner terminals but never type into them.

## Landing and deploy messages

New projects default to land delivery, with automatic landing off. A finished thread rebases onto current main, runs the path-selected landing checks and optional smoke check, and asks Jev to choose land, detached verification or an owner decision. A failed check returns a repair turn, up to three attempts. The publication lease serializes the exact push. Ordinary changes squash into one commit with a Thread line; configured paths and required job gates preserve commits. The remote backup branch is removed after a confirmed landing. Land now uses the same checks. Land instead converts an existing pull-request thread only after verifying its publication and pull-request ownership.

Each newer landing updates the project's deploy message. Approval pins its exact commit; it never approves a later landing. Deploy jobs run on an eligible tagged device. Enabled health checks run before the job, then one and five minutes after success. A failed after-run is repeated thirty seconds later. A confirmed failure of a check that passed before the deploy triggers rollback to a verified earlier deployment. Changed database migrations require an urgent owner decision instead. A first deployment without a verified baseline has no automatic rollback. Production approval remains the owner's action.

## The Overview

Desktop shows chat beside Overview; phones switch between Chat and Overview, with a count of items needing the owner. Overview has Threads, Pull requests, Queue, Routines and Library tabs.

| Thread group | Contents |
| --- | --- |
| Waiting for you | Open numbered questions, proposed tasks, waiting and failed threads; oldest first |
| Ready for review | Open pull requests without an active landing action |
| Working | Queued, preparing, running, publishing and attached threads |
| Landing | Verifying, merging, or held for the nightly window |
| Idle | Resting threads that can continue |
| Resolved | Ended or resolved work from the last 14 days; Show older adds another 14 |

Resolve is available for idle, waiting and failed work without an open pull request. Unpublished commits require confirmation; the branch and worktree stay. Resolve withdraws open questions and notifies the coordinator. Reopen or a new message clears resolution. An hourly sweep resolves eligible work after seven days without activity. Open pull requests are never resolved automatically.

## Pull requests and automatic fixes

Existing pull-request threads retain that delivery when a project switches to landing. Agents never push or open pull requests. For pull-request delivery, Jevellan commits leftovers, verifies the exact commit, pushes with lease and opens or updates the pull request. Failed publication verification returns a repair turn, with up to three attempts. Publish uses this same path.

Cards and thread headers show applicable Fix checks, Resolve conflicts, Address comments, Merge, Open on GitHub, Publish, Resolve and Reopen controls. Requests route to the owner device with retry receipts. Working or terminal-attached threads refuse conflicting actions.

Automatic fixes are enabled by default for failing checks, conflicts and review comments. An active project's in-review thread receives a same-thread repair turn, once per failing or conflicting head. Review bodies, inline comments and issue comments from any author are batched after two quiet minutes and delivered once. Each automatic turn uses one round; owner buttons use none. At the limit, the owner can allow more rounds or take over. Paused, busy and attached threads do not auto-fix.

Someone else may push to a thread's pull request. Before a fix turn (automatic, or from Fix checks, Resolve conflicts or Address comments), a worktree thread fetches the pull request's current head into its private ref space. When its branch has nothing unpushed, it fast-forwards to that head; otherwise it merges the head (never rebases), and a merge that stops on conflicts goes to the turn to resolve first. The thread says "Updated the worktree to pull request #n's head … before this fix.", and its next push leases on that head. A thread's GitHub reads cover only its own pull request: the pull request itself, and the runs, jobs and logs on its current head as Jevellan last read it. The failing-checks request names the failing runs and jobs by id.

The legacy pull-request merge gate records Jev's route and Why for each eligible head: merge, test then merge, or ask the owner. It retains the saved pull-request automatic-merge policy independently of automatic landing. Verification uses another eligible provider where possible, in a fresh read-only worktree. Head changes, pending coordinator messages, stopped threads and nightly holds prevent automatic merges. Owner Merge retains its checks and confirmation. The retired required-check editor is removed. Jevellan posts no GitHub comments, replies or reviews.

## Placement, accounts and limits

Jev's p-v1 choice selects model, effort and device within code-enforced resources, project constraints and owner-fixed choices. Project work uses Worktrees only. The a-v1 account choice uses eligible accounts and their usage rules; it never substitutes a machine login for an available managed account. Why records choices, constraints, corrections, exclusions and escalation history.

Allowed models, minimum effort and Guidance for Jev apply to automatic placement and follow-ups. Owner-fixed fields win. A thread with no account waits without consuming its pending turn. A usage limit cools that account and continues on another eligible account, or waits. When an unfixed model has a long or unknown wait, Jev can move it once to another eligible model on the same device. Two failed verifications or an agent-written blocked report can trigger Jev escalation without lowering effort.

Compatible endpoint accounts run only through Claude Code. They supply an Anthropic Messages API URL, token, explicit models, efforts and guidance. Their isolated launch points background calls at that endpoint and disables nonessential traffic. Normal accounts cannot serve endpoint-only models. Metered endpoints require a paid-use policy; subscription/free endpoints rank with subscription accounts. The menu supports 19 enabled choices and retains disabled historical definitions.

## Settings reference

Project settings is a page at `/projects/{id}/settings`, with one revision-checked Save. Status changes apply immediately. Paused and archived projects start no turns, tasks or routines; running turns finish, polling continues and owner stop/merge/discard still work. Resume sweeps queued work. Archived projects move into the sidebar's collapsed Archived row; Unarchive leaves the project paused.

| Field | Default and bounds |
| --- | --- |
| Status | Active; active, paused or archived |
| Coordinator runtime/account | Automatic eligible choice; optional fixed runtime/account |
| Coordinator model / effort | Automatic: first available / Medium; enabled menu model and supported effort |
| Delivery / automatic landing | Land / off; pull-request delivery remains available |
| Project instructions | Empty; at most 16,000 characters |
| Start mode | Start threads right away; or Propose threads and wait for me |
| Max running threads | 6; 1–20 |
| Max running per device | 4; 1–10 |
| Per-device limits | Empty overrides; each 1–10 |
| New threads per day | 100; 1–500, counted in the project time zone; restarts do not count |
| Turn limit per thread | 30; 5–200 |
| Coordinator handoff at percent | 70; 50–90; native compaction at 95 |
| Thread compaction at percent | 70; 50–90 |
| Checkpoint large cold thread sessions | Off |
| Thread checkpoint minimum context tokens | 40,000; 20,000–200,000 |
| Models threads may use | All enabled models; otherwise at most 19 model ids |
| Lowest effort for threads | No minimum; Low through Max |
| Guidance for Jev | Empty; at most 2,000 characters |
| Automatic checks / conflicts / comments | All on |
| Automatic fixes per pull request | 3; 1–10 |
| Landing checks | Empty; at most 30 path-selected commands |
| Smoke check | None; at most 2,000 characters |
| Preserve commits for paths | Empty; at most 20 relative paths |
| Risky areas | Empty; at most 2,000 characters |
| Worktree setup command | None; at most 500 characters |
| Variables | Empty; at most 200, each value at most 4,000 characters |
| Secrets | Empty; at most 100 names, values only in the encrypted hub vault |
| Copy files | Empty; at most 20 project-relative paths, each at most 300 characters |
| Memory mode / capture / dream | Hub / on / Apply and tell me; repo and device modes remain supported |
| Nightly window | Off; 02:00, Europe/Lisbon, supported IANA time zone |
| Goal refill | On; every 30 minutes, allowed interval 10–1,440 |
| Notifications | Standard; Everything, Standard, Only what needs me, Off; optional quiet hours |

Settings also contains health definitions and Run now receipts, deploy job selection, and Connect to Ekoa. Cleanup limits live in Settings → Projects, with per-device usage, last result and Clean now. Cleanup protects unfinished work and durable history; it waits when authoritative inventory or an idle-device reservation is unavailable.

Environment names use capital letters, digits and underscores. PATH, HOME, USER, SHELL, TERM, LANG, TMPDIR and runtime, authentication, Jevellan and Git prefixes are reserved. Secret APIs never return values to the owner browser. Members fetch configured launch secrets through the authenticated hub route, then register them for redaction.

Goals, nightly items and jobs are edited in Routines. Goals support paused/done states, autonomy, refill limits and open-pull-request caps. The ordered queue supports Now, dependencies, drafts, holding and owner ordering. The nightly window opens every night even after a daytime run. Memory dream precedes ordered command jobs; review follows those jobs and covers landings since its watermark. Fix findings become ordinary tasks, held from publication until the window ends. Weekdays restrict weekly items. Its seven-hour limit and restart receipts preserve progress. Historical GitHub workflow jobs remain readable but cannot dispatch or watch. See [the loop](loop.md).

## Library and attachments

Attach files in coordinator or thread composers, or upload in Library. Desktop supports image paste and drag/drop; phone file inputs offer the system's camera/photos options. Messages allow ten files. Upload failure retains unsent text and remaining chips. Attachment lines contain stable library paths, and render as image thumbnails or file chips.

The hub holds uploads and thread outputs, up to 50 MiB per file and 2 GiB per project. Library filters show All, Uploads and From threads, with Open, Download and Delete. Sessions can list/get files, and threads can add confined worktree outputs. Members hash-check requested files into read-only mirrors before turns. A file deleted or missing during download fails safely.

Environment variables, secrets and copied files reach setup, threads, verification and jobs, never the coordinator. Copied untracked files are confined to the registered project folder, cannot be symlinks and retain their mode. Missing and tracked files are skipped with a ledger reason. Leftover commits exclude them; publication refuses any commit that includes them. Rigging entries can apply to all projects or a selected set, including Conversations' project scopes.

## Notifications

Settings → Notifications enables this browser's web push subscription and offers a test, removal and a device list. HTTPS is required. On iPhone, install Jevellan from Safari to the Home Screen first. The owner verifies physical-phone delivery separately.

Standard sends coordinator replies, questions and failures. Everything also sends thread turn reports; Only what needs me sends questions and failures. Off suppresses ordinary project notifications; urgent production questions still arrive. Focused clients at the matching URL suppress duplicate notifications. Clicking a notification opens its deep link. Expired subscriptions are removed; bounded retries and seven-day retention limit delivery state. Ekoa mirroring remains independent.

Quiet hours durably hold ordinary notifications and send one project summary when the hours end or are disabled. Urgent production questions bypass the hold. Connect to Ekoa opens the owner sign-in flow; the encrypted hub vault stores registration and rotating tokens. The browser status never exposes them. Waiting items and deploy messages update their existing mirrored tasks.

## Usage

Project settings → Usage shows Today, 7 days or 30 days across devices, grouped by thread, model, account and kind. Tokens in/out, cache reads/writes and costs come from turn ledgers. Unknown-cost turns are counted explicitly. Thread headers show token/cost totals when available. Device-owned daily aggregates rebuild the last 30 days at startup in the project's time zone.

## Across devices

The hub owns shared definitions, settings, task indexes, questions, library, memory and the encrypted vault. Each thread's owner device runs its session, git work and publication. Relay requests are scoped, versioned and idempotent; temporary outages retain queued work. An SSH connection for native conversations is distinct from a joined Projects member. All participating devices must run 0.6.0 before using the new schemas; independent installations are not upgraded by association.

## Where state lives

The JSONL ledgers are authoritative local execution history. The hub holds shared versioned documents and slim indexes; owner devices keep thread-local pending turns, account waits, automatic fix cursors and session records. The notebook holds plans and open decisions. Project memory holds durable knowledge, including same-day inbox notes and nightly consolidation. The project journal is a rebuildable Markdown history with thread/day/night files and INDEX.md, mirrored read-only to members.

## Limits

One repository per project; no project deletion, cloud-hosted Claude threads, coordinator shell, GitHub posting or dollar spend caps. Compatible endpoints use Claude only. Thread transcripts still poll every 1.5 seconds. Project status, daily starts, concurrency, device resource guards and permanent exclusions are enforced in backend operations, including fixed requests.

The [parity run log](acceptance/projects-parity-2026-10/README.md) separates simulated checks, live journeys and missing credentials. [Projects history](acceptance/projects-history.md) preserves the former reference verbatim; dated claims there are historical, not current acceptance.


The installed command can send an owner message without a browser session:

```sh
jevellan project send ekoa-code --from "Coordenador" --wait 600 -- "Which work needs my attention?"
```

It uses the installation control file, forwards to the assigned Coordinator, and records the source as “You, via Coordenador”. Text comes from stdin when omitted; `--id` preserves a caller-supplied message identity for retries. `--wait` defaults to 600 seconds and accepts up to 3,600. It prints the reply from the completed turn that consumed that message. `--json` emits `ok`, `projectId`, `turn`, `reply` and `at`; without waiting, turn and reply are null. A timeout exits 2 while the Coordinator continues working.

An owner command can be a shell command or a Claude app prompt. Prompts say “Paste into the Claude app on {device}” and offer Copy. They cannot run in a terminal. Project notification settings contain a level and optional quiet hours, disabled by default from 23:00 to 08:00 Europe/Lisbon. Held updates survive a restart and become one project summary when quiet hours end or are disabled. An urgent production question bypasses quiet hours and the ordinary notification level.

Settings → Ekoa offers Connect to Ekoa. The hub discovers OAuth metadata, registers a public client when supported, and uses authorization code with PKCE S256. Sign-in returns to the hub’s `/settings/ekoa/callback`. The vault holds the client, temporary verifier and rotating tokens. A rotated refresh token is saved before its access token can be used. A later settings save wins over a delayed callback. Ekoa mirror ownership markers keep Waiting items and deploy messages on their existing tasks.

Source after 0.7.2 exposes shared thread controls through `thread actions`, `thread act` and `thread merge` as well as the UI. The action model provides consequences and availability; mutations retain canonical guards and retry ids. Member-owned work runs through its existing owner route. This source is not a new installed release.

Source after 0.7.2 supplies Routines rows, nightly outcomes, review labels, counts and action availability from the engine's versioned jobs view. Nightly clocks use the project's timezone. Enable and Pause/Resume requests carry the read revision and change only that flag. Run now refuses new work for paused jobs or projects and preserves accepted retry receipts. These source changes are not installed yet.

Source after 0.7.2 adds `jobs editor` and `jobs save` for the same versioned job/nightly editor models and canonical saves used by the UI. Defaults, limits and eligible choices come from the engine; saves preserve revisions, retry identity and coordinator ownership. Editor request data is available through MCP structured/text results and the CLI; remote output is redacted before serialization. These changes remain source only.
