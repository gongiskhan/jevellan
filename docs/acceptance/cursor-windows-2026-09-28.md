# CSG Windows Cursor discovery · 2026-09-28

The user reported a running CSG Cursor conversation missing from Jevellan. This report concerns that regression; it does not claim message-delivery or user acceptance.

## Cause and repair

The existing dev tunnel was healthy. Jevellan read the WSL home, while the missing desktop conversation was stored in the Windows user's Cursor database. The Windows home had four unrelated hooks and no Jevellan hooks. The WSL connection is retained with an explicit WSL label; a second reader accesses Windows Cursor through the same SSH gateway and existing VS Code dev tunnel.

The reader now supports explicit Windows helper/home paths and the Windows database location. Cursor's checkpoint timestamp contributes to five-day discovery. The desktop database remains canonical when available, so a fresh but less detailed journal export cannot remove saved tool results. Workspace metadata supplies project labels. Cursor can mark a stream aborted while its last subagent tool remains loading; that explicit tool state now keeps the working indicator active. A completed conversation still stops it. Database transcripts include bounded tool arguments/results and their saved states, along with text and thinking. Display fields are extracted together in one JSON pass per bubble. The Windows reader has an explicit native working directory instead of inheriting WSL’s UNC working directory.

Tunnel requests are newline-framed, so the Windows reader can respond without waiting for an inherited WSL stdin handle to close. A focused regression keeps stdin open and verifies that the complete request still gets a response. Initial live transport and saved-tool reads timed out; the final installation receipt was re-read after an installer SSH timeout to confirm completion before switching the configured helper.

The Windows hook installer uses a small bootstrap to invoke its recorded runtime, since the system Node is version 20. Windows file writes flush the file before atomic rename and omit the unsupported POSIX directory flush. Existing POSIX durability is retained.

A portable Node 22.22.0 Windows runtime was downloaded from nodejs.org, checked against the vendor's SHA-256 list before and after transfer, and placed under Jevellan's Windows home. System Node, PATH, shell profiles, native logins and existing hook scripts are unchanged. Seven Jevellan entries were added under the user's existing explicit hook authorization; all four unrelated Windows hooks are preserved. There are no new inbound ports, tunnels, listeners or remote services. Native databases are opened read-only; they are not copied or changed.

## Evidence

- **Live reproduction:** the WSL reader returned one older idle session while Windows Cursor had the missing parent conversation and active subagent data. Reading the live Windows SQLite database via WSL's filesystem failed; the native Windows reader succeeds without disabling SQLite locking or ignoring its WAL.
- **Live installation:** the Windows hook installer completed successfully after the directory-flush portability fix. Eleven hook entries are present: four existing and seven Jevellan entries.
- **Live reader:** initial native discovery took approximately 0.9 seconds; the parent transcript read took approximately 0.8 seconds. Both used the existing tunnel. An exported transcript could not be read and was reported as unavailable without dropping the database sessions.
- **Simulated regression tests:** all 18 focused Cursor cases passed, including Windows path configuration, checkpoint recency, lagging journal precedence, working hook precedence, a waiting subagent and formatted saved tool results. Build, typecheck and lint passed. The existing Vite chunk-size advisory remains.
- **Source review:** scoped crucial-issues inspection covered native read-only access, Windows runtime/paths, preserved hooks, atomic-write portability, terminal-state precedence and bounded display fields.
- Working-tree secret scanning and whitespace checks passed. Publication uses the mandatory pre-push history scan.
- No message was sent to the user's running Cursor conversation. Live steering/follow-up delivery, physical phone acceptance and broad suites are **not run** in this regression repair.

## Final live observations

- The repaired sidebar showed the missing parent conversation as Working and also showed its active subagent. Opening the parent restored its transcript. Expanding a completed tool exposed Input and Output sections, while the active subagent tool appeared In progress.
- The initial full tool-detail transfer took about 38 seconds and exceeded the application deadline. The final canonical database reader, launched from its native directory with the single-pass display extraction, returned the parent transcript through the real two-hop tunnel in **1.84 seconds**, with 401 turns, 292 tool blocks and about 572 KB transferred. At that observation the conversation had become idle. A preceding read completed in 2.03 seconds.
- Final deployment uses the existing Mac mini release directory `~/.jevellan-build/pilot-csg-windows-final-2026-09-28/app` and unchanged pilot data home. The read-only Windows helper is independently versioned from the already-installed hooks. The Windows startup list includes recent desktop sessions; the WSL connection is retained separately. Native exported-transcript read failures remain explicitly reported; they do not hide the database sessions.
- Browser inspection was live in the existing desktop browser. No phone installation/physical device acceptance is claimed. The user’s original screenshots establish the phone symptom, not a post-fix phone pass.

## Subagent-list follow-up

The user reported child tasks appearing as separate conversations. Discovery now uses Cursor's explicit `composerHeaders.isSubagent`, composer `isSubagent`/`subagentInfo`, and parent `subagentComposerIds`. Child classification is collected before the five-day filter, so old parents can still identify recently exported children. The same exclusions apply to database sessions, exported journals and hook-only discovery. Known exclusions survive temporary source loss in the running reader cache. Ordinary parents retain their existing transcript and working indicator.

The optional, defaulted `excludedSessionIds` list carries hashed IDs through the versioned reader response, allowing the gateway to discard previously cached child rows instead of restoring them during partial source failures. Older helpers remain readable. This is structural metadata filtering, with no title-based guesses and no native database changes.

- **Simulated:** 21 focused Cursor regressions pass, including header-present/header-absent databases, old-parent references, recent child exports/hooks and cache fallback after metadata loss. Build, typecheck and lint pass.
- **Live:** the mini uses the isolated `pilot-cursor-parents-2026-09-28/app` release with the existing data home and tailnet route.
- **Blocked:** CSG's existing tunnel returns connection refused. Its updated reader is packaged locally, but has not been installed there; live CSG filtering and browser confirmation are not claimed. Remote helper configuration and existing hooks are preserved.
- **Not run:** broad suites, message delivery and physical phone acceptance.
- **Scoped review:** checked parent retention, metadata fallback, read-only native access and cache resurrection. The cache check found and fixed a case where temporary metadata loss could reintroduce a known child from its journal.
