# Conversation reading space · 2026-09-28

The user requested more space for reading, compact delivery controls and a pinned preview of their latest message.

## Changes

- Conversation routes omit the redundant application header. The machine switcher lives in the sidebar; phone navigation is beside the session title. The transcript uses the available workspace width with modest side padding.
- The latest user message stays at the top and is clamped to two lines. Cursor explicitly marks automatic subagent notifications with `isSimulatedMsg`; the reader preserves that distinction as optional `automated` turn metadata. These updates are labelled as Cursor updates and do not replace the pinned human message.
- Both Cursor and regular conversations use a one-line textarea that grows upward to one-third of the viewport, then scrolls internally. The arrow sends while idle or steers while running. The separate queue icon sends after current work. Accessible names and hover descriptions identify both actions; unavailable delivery remains disabled, including keyboard submission.
- Cursor connection settings move from the conversation footer to gears on relevant session rows. The selected regular conversation has a sidebar gear opening its step/model/effort controls and work-settlement action. No settings or delivery-mode row occupies the composer.
- Enter sends/steers; Shift+Enter inserts a line break. Draft text is retained on failed delivery. Existing backend delivery modes and message IDs are preserved.

## Evidence

- **Live desktop:** inspected the deployed Cursor conversation in the existing browser at its default 895 × 608 viewport. The global header and explanatory footer are absent; the machine switcher is in the sidebar. The actual latest user instruction remains pinned above the transcript instead of the subsequent automatic notification.
- **Live responsive:** at 390 × 844, navigation is reachable beside the title and the conversation has no horizontal overflow. A 433-character regular-conversation prompt occupied 37 pixels while its full text required 130 pixels, confirming two-line truncation.
- **Live composer:** temporary unsent multiline text grew the input to approximately 201 pixels on desktop and 279 pixels at phone width, both capped at one-third of the respective viewport. Clearing it restored a 46-pixel single line. Temporary text was removed; no message was sent to an agent.
- **Live settings:** the selected regular conversation’s sidebar gear opened its next-step/model/effort settings and closed mobile navigation. No setting was changed. The original Cursor page and default viewport were restored.
- **Build checks:** build, TypeScript and lint pass. Automated suites and live steering/queue delivery were **not run** for this UI iteration. Physical phone acceptance is not claimed.
- **Deployment:** isolated mini release `~/.jevellan-build/pilot-conversation-space-2026-09-28/app`, existing pilot data home and tailnet route. CSG’s read-only helper was updated through the existing dev tunnel; hooks and tunnel configuration were preserved. Health reports OK.
- **Scoped review:** inspected keyboard submission guards, separate queue semantics, responsive navigation, empty-draft cleanup, source metadata filtering and retained settings access. No crucial issue remains identified in this scope. Secret scanning is required before publication.

## Disclosure follow-up

The Cursor tool/thinking headers added text arrows to the shared border-drawn chevron, causing the doubled, misaligned marker in the user's screenshot. Both now use only the shared rotating chevron, aligned with a flex summary. Thinking blocks mount open by default; tool blocks retain their collapsed default. Native disclosure toggling still permits the reader to collapse thinking.

- **Live:** all 15 thinking blocks in the open conversation initially expanded; tool blocks remained closed. Browser inspection confirmed a single aligned arrow and working manual collapse/expand.
- **Build checks:** build, typecheck and lint pass. Automated suites were not run for this small UI fix. No agent message was sent.
- **Deployment:** web assets updated in the existing isolated release, retaining older hashed assets for open clients. The daemon, CSG reader and hooks were not restarted or changed.

## Transcript density follow-up

Removed the repeated agent-name label from assistant turns. User messages retain their distinct bubble and You label; injected notifications are labelled Automatic update. Reduced transcript/live-activity gaps to 8 pixels and removed the disclosure cards' extra outer margins, so adjacent thinking, tools and text no longer accumulate padding and label space.

Build, typecheck and lint pass. The change is limited to web assets in the existing isolated installation; no daemon restart, native session mutation or message delivery is involved. Automated suites were not run for this visual adjustment.

**Live evidence:** the deployed browser has no assistant-turn labels, measured adjacent turn spacing is 8 pixels, and thinking remains open. Visual inspection confirms the tighter layout. No agent message was sent.
