# Project memory and context

Jevellan keeps Markdown notes in each project's configured memory folder, normally `.jevellan/memory`. Basic Memory 0.22.1 supplies the index and note operations. Its configuration, database and process HOME live under Jevellan's `basic-memory/` directory. The user's Basic Memory is not used.

## Isolation and synchronization

The daemon owns a constrained MCP process per project, named `jv-{projectId}`. Agents receive only Jevellan's scoped bridge tools. They cannot choose another project or call the provider's project-management tools. Provider processes receive a filtered environment, with explicit local routing, self-updates and background synchronization disabled. Semantic downloads and telemetry are disabled too.

Synchronization is explicit. A small Python helper calls the pinned provider's foreground sync API in its own virtual environment. It validates the registered project path, including Basic Memory's normalized registry names, before indexing. Imported notes are not rewritten to add frontmatter or permalinks. Existing permalinks are preserved; otherwise the exact relative Markdown filename is the note reference. Database files remain outside the repository.

To add memory by hand, write Markdown in the project's memory folder. A note may have YAML frontmatter such as `title: Test conventions` and `status: unresolved`. The owner's next explicit sync indexes it. Do not place secrets in project memory. Repository-mode notes travel through git; device-mode notes are excluded with an anchored entry in `.git/info/exclude` and never committed. A device-mode folder must not already contain tracked files.

## Recall and capture

Recall searches literal words from the original request, the latest message and the action. The provider ranks the union of those terms; sending a whole request as a phrase would miss relevant notes. Jev scores up to twelve candidates from 0 to 3 and selects at most five scoring at least 2, with 300-character excerpts. Manual mode and failed scoring use the first five search-ranked candidates, recording that source explicitly. The brief enforces its separate 2,000-token memory budget and labels unresolved notes. The saved selection and its source are visible in Why; see [decisions](decisions.md).

Writing actions and explicit remember replies use the bridge's write and edit tools under checkout ownership. Other stretches can queue proposals. Handoff findings prefixed with `memory:` become proposals whose bodies contain the evidence pointer and a conversation link. Repeated capture and repeated identical tool calls reuse their durable proposal.

Project memory is a built-in Rigging item, on by default with separate runtime toggles. APM delivers capture hooks to each account home; launches verify that delivery. PreCompact, Stop and SessionEnd queue a structural checkpoint using the owner's recorded step metadata. Events and retries coalesce into one proposal per step. Provider payload content and transcripts are never captured, and there is no hook recall. Ordinary answer-only replies and handoff repair do not create automatic notes. The active toggle and stretch-token lifetime also fence capture. A lifecycle notification is not a completion receipt; follow its conversation link for the final handoff and verification. Agent tools and handoff capture remain available when the hook is off.

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

The owner loop, Projects editor, read-only memory viewer and context create/keep/merge workflow are connected. Memory-only publication, automatic note-conflict preservation and post-publication index refresh have actual Git/provider and simulated-runtime service evidence; see [publication checks](acceptance/phase2-memory-publication.md). [Hook capture checks](acceptance/phase2-hooks.md) cover actual APM delivery, scoped subprocesses, SDK wiring through simulated providers, native Codex discovery and owner-side queue application. Native lifecycle dispatch still needs live journey evidence. [J11](acceptance/J11.md) records the single-device live Codex journey and the cross-device journey using real Basic Memory with local simulated devices/providers. Nightly memory care and J12 remain unfinished.
