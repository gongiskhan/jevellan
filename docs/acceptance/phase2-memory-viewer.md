# Project visibility and memory browsing

BRIEF.md §§13.5 and 15 require the public-repository memory notice and a read-only note viewer with titles, last update and rendered Markdown. Projects now provides both.

## Behavior

The authenticated visibility endpoint resolves the saved checkout for this device and reads `gh repo view --json visibility` there. It never falls back to another checkout or starts a conversation. Public, private and internal results remain distinct; an absent CLI, unavailable authentication, timeout or malformed response returns unknown. The command has a five-second timeout and does not inherit `GH_REPO` or provider credentials. Concurrent views share an in-flight check; reopening Projects checks again.

A known public project shows the required copy beside its memory setting: “This repository is public. Memory committed here is public too.” The edit panel hides a previous result if its draft checkout path or remote changes. A failed check makes no assertion that the repository is private. This is the single-device implementation; owner routing belongs to phase 4.

Search results and the selected note show an ISO-validated last-update time. Installed Basic Memory 0.22.1's `read_note` JSON response provides title, permalink, file path, content and frontmatter, but no update time. Jevellan therefore uses the exact project note's local file modification time. A tooltip identifies this source: it is not a promise of the original author's edit time across Git checkouts. The note must remain a regular file inside the already validated project memory directory. Reading and searching preserve the authored contents and modification time.

## Evidence

- **Live local tooling:** the real isolated Basic Memory provider preserves an imported unresolved note, returns its fixed file modification time in both read and search, and leaves its contents unchanged. Existing project isolation, exact reference, local exclusion and redaction checks pass.
- **Simulated GitHub responses:** twelve visibility cases cover public/private/internal results, missing authentication or executable, timeout, malformed output, concurrent requests, rechecking changed visibility, failed-probe recovery and refusal of missing/disallowed/nested checkouts. No live GitHub visibility claim is made; the recorded authentication blocker remains.
- **Actual HTTP and Git, simulated visibility:** the endpoint requires authentication, returns a versioned project/device result, rejects an unknown project, preserves Git refs/status and starts no model. This focused case passed; sixteen unrelated context cases were excluded by its filter.
- **Browser verification:** eight affected workflows passed in 41.8 seconds: the existing manual Projects journey and the new public-memory viewer, each at desktop/phone sizes in light/dark. GitHub visibility and model responses are fixtures; the note files, isolated Basic Memory, HTTP and rendered UI are actual local components. The new workflow checks the exact public notice, an unknown project without a notice, invalidation of an edited path, searchable notes, exact timestamps, rendered Markdown and reload.

The first browser run passed the four existing journeys and failed all four new cases because the simulated visibility probe compared the temporary `/var` path with its resolved `/private/var` path. Canonicalizing the fixture root fixed the simulated response; no product fallback or false public/private assertion was added. Representative captures were visually inspected. The note result then received a small layout adjustment to place its timestamp below its title; all four final viewer workflows passed in 20.6 seconds after rebuilding, and the updated phone and desktop captures were visually inspected.

The sixteen visibility/Basic Memory tests passed in 18.69 seconds. The separate authenticated endpoint case passed in 1.08 seconds. Typecheck, lint and the production build passed. The full unit suite has not been rerun for this change; the broader history remains in [REPORT.md](REPORT.md). Required Claude SDK vision checks remain blocked by the absent dedicated token.

| Layout | Memory setting | Note viewer |
| --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-memory-settings-desktop-light.png) | [Capture](screenshots/phase2-memory-viewer-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-memory-settings-desktop-dark.png) | [Capture](screenshots/phase2-memory-viewer-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-memory-settings-phone-light.png) | [Capture](screenshots/phase2-memory-viewer-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-memory-settings-phone-dark.png) | [Capture](screenshots/phase2-memory-viewer-phone-dark.png) |

This closes the project-memory presentation gaps, not phase 2. Loose Rigging discovery and live manual/native integration evidence remain.
