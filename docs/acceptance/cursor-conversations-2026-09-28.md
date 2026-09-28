# Cursor conversations iteration — 2026-09-28

The user requested focused work alongside continuing main-feature development on another machine. Main was fast-forwarded to `8264aab` before implementation. The updated task expands the brief's original read-only sensor scope to desktop Cursor viewing and messaging, excludes terminal/xterm/CLI attachment and new-session creation, and explicitly defers all test execution until a reported failure.

Implemented: a five-day desktop Cursor index; ordinary sidebar integration; formatted conversation view with collapsible tool/thinking content; completion-aware spinners and disconnected states; mesh owner routing; an existing-dev-tunnel SSH helper connection; durable per-session message queues; desktop hook delivery at the next tool boundary or completed turn; shared composer delivery selection; stable standalone helper builds and explicit hook installation.

The implementation choices and practical limits are documented in [Cursor conversations](../cursor-conversations.md). History is bounded to the latest 8 MiB of a journal or 500 saved composer bubbles, with a visible truncation note. Refresh is polling (1.5 seconds for an open session, 3 seconds for discovery), with native database work in a worker rather than the daemon event loop. The historical metadata-only guard sensor was left unchanged.

Evidence:

- **Live:** local hook installation after the user's explicit exception to the native-home rule. Read-back found 22 hook entries, including all 17 pre-existing entries unchanged. Five entries were added. Original configuration was backed up under the isolated Jevellan home. No native transcript or database was written.
- **Live:** read-only inspection found the existing dev-tunnel SSH configuration on the gateway. Its loopback SSH endpoint refused connections; CSG installation and session access are blocked until that existing connection returns.
- **Static:** `npm run build`, `npm run typecheck`, `npm run lint`, and `git diff --check` passed. The production build includes standalone helpers.
- **Not run:** all automated and live behavior tests, browser/phone checks and vision checks, per the user's explicit request. Regression cases were ported/adapted but not executed.
- **Not installed:** the new daemon/web application was not activated on this machine or Dev Madrid, preserving the ongoing main-feature work and running conversations. Only the explicitly approved local Cursor hooks were installed.
- **Not claimed:** live steering, follow-up delivery, CSG functionality, Enterprise statistics, or user acceptance.

One end-of-iteration crucial-issues inspection covered wrong-session delivery, duplicate submissions, stale spinners, native writes and transport behavior. The queue is generation-bound; command arguments are quoted; native storage is read-only; delivery does not launch a CLI agent; unavailable transport disables controls. No additional review was needed. This inspection is not runtime evidence.
