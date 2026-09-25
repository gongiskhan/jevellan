# Conversation file and evidence navigation

Evidence: **simulated models with actual HTTP, Git repositories, file reads and Chrome**. No live provider or Claude vision acceptance is claimed.

The conversation now opens file references from assistant Markdown, tool inputs, findings and the Changes panel. Findings recorded during a step appear alongside handoff findings, with duplicates removed. Stored handoffs, ledger events and blobs still open through the conversation reader. Verification output is shown as literal text so formatting cannot change what the command printed. External HTTP links open normally; opening evidence never executes a quoted command or launches a model.

## File versions

- Recorded main-policy steps open the file at their last checkpoint, including later memory or context checkpoints belonging to that step. Later edits and steps do not replace that evidence.
- If a file was deleted by the step, the viewer opens its before-step version and labels it explicitly. A missing historical file never silently falls back to the current file.
- **Open working copy** explicitly switches to the current contents. External-policy projects and steps without a recorded checkpoint use this view, labelled “Current working copy · not a saved step”.
- Source lines use `path:line`, `path:line:column` or `path#Lline` references; the viewer highlights the starting line. Markdown renders with a source toggle and relative project links. PNG, JPEG, GIF and WebP data render as images. SVG is shown as source, and unsupported binary data is refused.
- The Changes panel lists checkpointed and uncommitted files separately through their source labels. Deleted and untracked paths are included.

Reads are scoped to the conversation's project on its owner device. Regular files up to 2 MB are supported. Credential filenames, paths outside the project, symbolic links and non-file objects are refused; known secrets are redacted in text before it reaches the browser. These are adaptations of the reference viewer's existing behavior. There is no writable file API, directory browser or remote URL fetch in this feature.

## Reference and verification

Read-only sources: Garrison's `packages/talk/ui/app.tsx`, `packages/claude-chat/src/host-rewrite.ts`, `packages/projects/src/fs.mjs`, `tests/host-rewrite.test.ts`, `tests/projects-files.test.ts`, and `tests/e2e/projects/files.spec.ts`.

Ported behavior tests cover rendered Markdown, numbered source lines, screenshot bytes, encoded spaces, project confinement, sensitive filenames, symbolic links, oversized files, binary rejection and local link handling. Jevellan adds checkpoint-versus-working-copy tests, deletion fallback, text redaction, external-policy labeling and HTTP authentication. The original upload/workspace roots, writable project tools and loopback URL rewriting were not ported.

The focused checks passed **11 cases in two files in 8.72 seconds**; 67 unrelated service cases were excluded by the name filter. The initial run passed ten and failed one test because it expected an uppercase redaction marker; the actual redacted value was already correct. The assertion now uses the existing lowercase marker.

Four browser workflows initially passed in **31.4 seconds**. They open evidence after two different implementation checkpoints, switch to the working copy, navigate Markdown links, render a one-pixel PNG fixture, read a tool-referenced file and open independent verification output. A later addition checks a bare filename with a line suffix, as well as paths containing directories. The first complete run passed 24 workflows and failed the cross-work undo assertion in each layout because its Markdown selector matched both the stream and the newly rendered handoff. Those tests stopped before settling their checkout; the following controls/evidence fixtures then correctly encountered ownership blocks. The stream assertions were narrowed to their intended content. The final rebuild passed typecheck and lint, and the complete **36-workflow browser suite passed in 2.9 minutes**. See [REPORT.md](REPORT.md) for the broader verification history.

The source, Markdown and image panels were visually inspected at representative desktop/phone and light/dark sizes. The image fixture is deliberately a single pixel; its original bytes and decoded width are asserted. Browser checks are deterministic; the required Claude SDK vision pass remains blocked by the missing dedicated token.

| Layout | Source line | Markdown | Image |
| --- | --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-evidence-source-desktop-light.png) | [Capture](screenshots/phase2-evidence-markdown-desktop-light.png) | [Capture](screenshots/phase2-evidence-image-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-evidence-source-desktop-dark.png) | [Capture](screenshots/phase2-evidence-markdown-desktop-dark.png) | [Capture](screenshots/phase2-evidence-image-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-evidence-source-phone-light.png) | [Capture](screenshots/phase2-evidence-markdown-phone-light.png) | [Capture](screenshots/phase2-evidence-image-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-evidence-source-phone-dark.png) | [Capture](screenshots/phase2-evidence-markdown-phone-dark.png) | [Capture](screenshots/phase2-evidence-image-phone-dark.png) |

Loose Rigging discovery, the remaining project-memory presentation and live manual/native integration evidence still belong to phase 2. Automatic Jev decisions remain phase 3 work.
