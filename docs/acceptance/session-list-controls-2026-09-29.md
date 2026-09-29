# Session list controls · 29 September 2026

Each session row has an actions button for Rename. Reordering uses drag-and-drop: drag a row on desktop, or hold it for 450 milliseconds on a touch screen before moving it. The initial Move up/Move down buttons were replaced at the user’s request. Connection/conversation settings are available in the same expanded controls where applicable. The controls work with Cursor, Claude Code, Codex and ordinary Jevellan conversations.

Native session names are Jevellan display names: they update the sidebar, search, browser title and conversation heading without modifying native agent homes. Ordinary conversations use the existing conversation rename operation. A move saves the combined list order; changing activity does not undo that order. Newly discovered sessions appear above the saved order. Sort by activity clears manual ordering. In a filtered list, drops use the visible destination while retaining other entries.

Design choice where the brief is silent: presentation is a versioned, schema-validated document in the serving installation's isolated home. Browsers using that installation share names and order, including the phone and PWA. Separate Jevellan installations have independent presentation. Revision checks reject stale changes and refresh the list; the document is written atomically. Session readers and native journals are unchanged.

Verification: production build, typecheck and lint passed. Scoped source review covered authenticated writes, revision checks, native-home preservation, filtered movement and renamed headings. Automated tests and browser interaction tests were not run under the user's iteration preference. Deployment readiness is recorded separately below. No user acceptance is claimed.

**Live deployment readiness:** the isolated pilot at `~/.jevellan-build/pilot-session-list-2026-09-29/app` is active at the existing tailnet address. Local health returned HTTP 200 and the served HTML matched the final build. No user session was renamed or reordered during verification. The worktree secret scan passed.

## Drag-and-drop follow-up

A floating row and insertion line show the destination. The list scrolls automatically near its edges. Movement or scrolling before the hold threshold cancels activation, preserving normal mobile scrolling. Release saves; Escape, cancellation, window blur or dropping outside the list cancels. Releasing a drag does not open the conversation. The visible order is held stable during the gesture; saved order uses the existing revision-checked API. Keyboard users can use Alt+Up/Down on the focused row without extra visible controls. Rename stays in the row menu.

The implementation uses non-passive touch-move handling only after the hold has activated, following [MDN’s touch event guidance](https://developer.mozilla.org/en-US/docs/Web/API/Touch_events). No dependency or native reader change is required. Source review covered scroll/drag separation, cancellation, click suppression and saved ordering. Build/typecheck/lint are checked for this update; automated and physical-touch interaction tests remain not run under the user's instruction.

**Live deployment readiness:** the drag-and-drop assets are installed in the same isolated pilot, without a daemon restart. Health returned HTTP 200 and the served HTML matched the final build. Production build, typecheck and lint passed. No session order was changed for verification.
