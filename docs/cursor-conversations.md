# Cursor desktop conversations

Cursor desktop sessions with activity in the last five days appear in the ordinary conversation list. Opening one shows its saved user/assistant messages as Markdown, including code fences, lists and tables. Tool results are grouped with their calls, and thinking is collapsible. Existing scroll position and unchanged turn components survive polling.

The observer reads native JSONL/text journals and Cursor's SQLite composer store without writing to them. CLI chat IDs are excluded. A native `turn_ended` record ends the activity indicator; quiet or stale evidence is shown as unknown, not asserted idle or working. Hook activity supplements the journals. Failed reads retain recent cached rows with unavailable status and disable sending. The selected transcript keeps its last loaded content while reconnecting.

The native sensor used by checkout guards remains separate and unchanged. The richer conversation endpoint does not turn a native Cursor session into Jevellan-managed work, acquire its checkout, select models, or run a CLI agent.

## Delivery

Every composer offers a delivery choice. Ordinary conversations use the existing correction/next-step-note mechanisms. Cursor uses its desktop hook runner:

- **Steer current work:** queued text is returned as `additional_context` by the next `postToolUse` or `postToolUseFailure` hook. It does not interrupt an in-flight tool or model response.
- **Send after this step:** queued text is returned as `followup_message` by a completed `stop` hook. A completed session stays available through that hook for up to seven hours. No synthetic keep-alive prompts are submitted.
- A desk prompt supersedes the prior generation. Stale steering and other queued messages from a superseded generation expire visibly; they are not injected into a different turn. Cancelled/error stops do not automatically resume.
- Retries use the same client message ID. The local queue records handoff before returning stdout to prevent automatic duplicate delivery. **Handed to Cursor** is intentionally not an assertion that Cursor accepted or executed the message. A process crash at that boundary can require checking the native conversation.
- An old idle conversation without an active hook can be viewed, but cannot yet be messaged. Start one turn in that existing conversation in Cursor after enabling hooks. Starting new sessions from Jevellan is deferred.

These capabilities are based on the [Cursor hook contract](https://cursor.com/docs/hooks), not a public API for arbitrary editor input. Desktop delivery and Enterprise reporting still require observation in the user's environment; neither is claimed verified.

## Connection and installation

Regular Jevellan devices use authenticated owner requests. A device with the existing VS Code dev-tunnel SSH connection can additionally configure a Cursor connection in Settings → Devices. The connector only executes the installed helper over SSH to `127.0.0.1` at the supplied port. It creates no tunnel, port forward, listener, remote daemon, or Cursor CLI session. SSH host-key checking stays enabled. Missing/expired transport is reported rather than replaced with another route.

`npm run build` produces standalone Node helpers in `packages/mesh/dist/standalone/`. These contain their JavaScript dependencies and need Node 22.13+ on the target. Put them in a versioned directory inside the target's isolated Jevellan home, preserving the accompanying repository and Zod licenses. The configured helper is `cursor-stdio.mjs`; `cursor-hook.mjs` belongs beside it. Remote data paths must point to a Jevellan home, never a native agent home.

For a local installed/development copy, the explicit operator command `JEVELLAN_HOME=/absolute/jevellan/home node scripts/install-cursor-hooks.mjs` installs a stable helper copy and adds five hook entries. It preserves unrelated hook entries and other settings, writes an exact backup under the isolated home's `cursor/backups`, and records a versioned installation receipt. It is never invoked by build or daemon startup. The user explicitly approved this native configuration exception on 2026-09-28. Review of generated hook configuration is also available in Settings → Devices.

Stored messages, hook state, installation receipts and connection settings are versioned schemas. Transcript IDs in browser routes are hashes. Native session IDs remain in owner-local runtime state and are not written to repository evidence.

## Current evidence

- **Live installation:** five Jevellan hook entries added on the local Mac; all 17 existing hook entries preserved. Stable helpers are in the existing isolated pilot data home. No Cursor turn was submitted, stopped or steered.
- **Build/static checks:** production build, TypeScript checking and lint passed. The existing application has not been redeployed by this work.
- **Not run:** unit, integration, browser, vision and live delivery tests, as the user requested. Adapted regressions are present in `tests/cursor-conversations.test.ts` but were not executed.
- **Blocked:** the existing dev-tunnel SSH endpoint on Dev Madrid refused connections on 2026-09-28. CSG helper/hook installation and live session viewing/delivery therefore remain pending. No tunnel repair or new tunnel was attempted.
- **Not claimed:** phone acceptance, Cursor Enterprise ledger attribution, reliable delivery on the installed CSG Cursor version, or the user's acceptance.
