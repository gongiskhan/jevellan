# Session list controls · 29 September 2026

Each session row now has an actions button with Rename, Move up and Move down. Connection/conversation settings are available in the same expanded controls where applicable. The controls work with Cursor, Claude Code, Codex and ordinary Jevellan conversations.

Native session names are Jevellan display names: they update the sidebar, search, browser title and conversation heading without modifying native agent homes. Ordinary conversations use the existing conversation rename operation. A move saves the combined list order; changing activity does not undo that order. Newly discovered sessions appear above the saved order. Sort by activity clears manual ordering. In a filtered list, moves use the adjacent visible session while retaining other entries.

Design choice where the brief is silent: presentation is a versioned, schema-validated document in the serving installation's isolated home. Browsers using that installation share names and order, including the phone and PWA. Separate Jevellan installations have independent presentation. Revision checks reject stale changes and refresh the list; the document is written atomically. Session readers and native journals are unchanged.

Verification: production build, typecheck and lint passed. Scoped source review covered authenticated writes, revision checks, native-home preservation, filtered movement and renamed headings. Automated tests and browser interaction tests were not run under the user's iteration preference. Deployment readiness is recorded separately below. No user acceptance is claimed.

**Live deployment readiness:** the isolated pilot at `~/.jevellan-build/pilot-session-list-2026-09-29/app` is active at the existing tailnet address. Local health returned HTTP 200 and the served HTML matched the final build. No user session was renamed or reordered during verification. The worktree secret scan passed.
