# Hub outages during unfinished integration

**Live:** local Git, HTTP, SQLite, Basic Memory, isolated homes and owned test processes. **Simulated:** provider behavior, additional devices and hub outages. This does not claim a real second-machine journey or successful live Jev classification.

The previous reproduction stranded a real conflicted rebase when the hub disappeared during automatic memory-conflict resolution. The subsequent abort also needed hub ownership, and the publication retry failed because Git was still detached inside that rebase.

The owner daemon now waits at the abort itself. Before waiting, it fingerprints the local checkout, all refs, staged entries, remote configuration, original HEAD and rebase metadata. This read does not contact the Git remote. After reconnecting, it obtains checkout authority, checks outside activity and compares the boundary again immediately before aborting. A changed file, staged resolution or rebase instruction prevents automatic cleanup and preserves the pending integration for inspection.

If the boundary is unchanged, the abort restores the recorded checkpoints. Publication then settles its previous lease attempt, obtains fresh authority, fetches again and reconciles its existing rewrite evidence before continuing. A conflict fallback also rechecks publication authority after aborting and before launching integration. No completed native step is relaunched by this recovery. Restart records interruption and retains the pending checkout rather than recreating the old daemon's continuation.

## Verification

- The initial reproduction failed in **20.49 seconds**, leaving the work blocked with Git still inside the rebase.
- The first repaired reproduction passed in **29.42 seconds**. It uses a real upstream/local conflict in a project-memory note, then verifies a clean published result containing both versions and exactly one native launch.
- The expanded run passed **13 scenarios in three files in 142.60 seconds**, with 138 unrelated cases excluded. It covers unchanged recovery with two lease attempts and one native launch, preservation of outside file/index/metadata edits, restart without continuation, lost publication replies, native conflict integration, memory merge/recall/undo and ordinary publication.
- The subsequent complete Git-policy and memory-conflict suites passed **69 tests in two files in 183.38 seconds**. Typecheck, lint and the production build passed.
- The affected browser run passed **eight workflows in 1.2 minutes** across desktop/phone and light/dark: planned work, Changes, corrections and undo. The phone-dark Changes panel and desktop-light correction/redo history were inspected. These use simulated providers; Claude vision remains credential-blocked. Secret scanning passed.
- Whitespace checks passed. The unchanged private Tailscale preview returned HTTP 200; it still serves its earlier fixed report rather than this new checkpoint. The current work remains on main and uncommitted because the recorded commit-approval blocker has not changed.

## Remaining work

Earlier context operations, undo and settlement preparation, new UI requests, logins and settings writes still need hub waits. Periodic configuration/APM synchronization, remote provider-login UI, device/header UI, network listeners and full two-daemon J8/J11 remain phase 4 work. Installer, improver and final verification remain later phases. The fixed private progress preview is unchanged. Successful Jev classification, Claude live/vision, commit approval and GitHub authentication remain separately recorded blockers.
