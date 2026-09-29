# Claude Code and Codex conversations · 29 September 2026

The user requested recent Claude Code and Codex sessions beside Cursor, using the same formatted conversation view. This phase adds read-only discovery and transcripts; it does not start, resume, steer or message either new runtime.

## Behavior and scope

- Main conversations with journal activity in the last five days appear in the ordinary searchable session list, with runtime, project, device and activity status. Explicit native subagents and Claude sidechains are excluded.
- Markdown, code, readable thinking, tool inputs and paired results use the existing compact view. Thinking opens expanded, the latest human message stays pinned, and repeated assistant labels remain absent.
- Working/idle state follows native journal lifecycle events. Quiet unfinished turns remain working for a bounded interval; stale unresolved state becomes unknown. This observes saved events, rather than proving that an agent process is alive.
- Readers use canonical native journal directories under the user's home. Codex's optional native index supplies saved titles through read-only SQLite. Custom agent homes and archived sessions are outside this phase.
- Discovery and transcript reads are bounded. The view indicates truncated history; images appear as attachment placeholders. Encrypted Codex reasoning is excluded.

## Implementation choices

The existing versioned Cursor transport and display schemas now accept an optional runtime and runtime-prefixed hashed IDs. The shared authenticated API, explicit device routing and reconnect behavior remain in place; new browser routes use `/sessions/`. Keeping this additive transport avoids a separate remote service or migration. Mesh heartbeats remain metadata-only.

The standalone helper now includes both native readers. An optional explicit SSH host supports the already available Dev Madrid connection; CSG continues through the same VS Code dev tunnel and gateway. No new tunnel, listener, native hook, shell profile, login or agent process was added. Reader packages and connection configuration live under Jevellan's isolated directories. Dev Madrid's checkout and services were not changed.

Read-only references: Garrison's Claude/Codex listers, transcript projections and their corresponding tests. Eight synthetic cases were ported for the formats, title sources, activity lifecycle, subagent filtering, recency and explicit SSH transport. They were **not run**, following the user's iteration preference.

## Evidence

- **Live:** Mac mini discovery returned 2 Claude Code and 4 Codex sessions; Dev Madrid returned 9 Claude Code sessions. Existing Cursor discovery returned 13 local, 2 CSG WSL and 50 CSG Windows sessions. No source was unavailable. The combined read completed in approximately 1.7 seconds. No recent Claude/Codex journals were returned on CSG, and no recent Codex journals were returned on Dev Madrid.
- **Live:** selected local Claude and Codex journals projected readable turns and tool results. A Dev Madrid Claude transcript returned 457 turns and 211 tool calls, all with results; the bounded-history notice was present.
- **Live:** the deployed browser showed Claude Code and Codex in the common sidebar, with the active local Codex conversation marked Working. Their formatted views showed compact tool disclosures and read-only badges; Claude also showed expanded thinking and Markdown. Inspection exposed a Codex ambient-browser wrapper in the pinned user message; the display projection now removes that wrapper while retaining the actual request. No agent message was sent.
- **Live:** the updated app is running from `~/.jevellan-build/pilot-native-sessions-2026-09-29/app` with the existing data home and tailnet address. Loopback health returned HTTP 200. CSG Windows/WSL and Dev Madrid helper packages were installed through existing SSH access.
- **Build checks:** production build, TypeScript and lint passed. The scoped crucial-issues source review found no release-blocking issue.
- **Not run:** automated tests, end-to-end tests, vision checks, physical phone acceptance and message delivery. No user acceptance is claimed.
