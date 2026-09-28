# Cursor desktop conversations

Cursor desktop sessions with activity in the last five days appear in the ordinary conversation list. Opening one shows its saved user/assistant messages as Markdown, including code fences, lists and tables. Tool results are grouped with their calls, and thinking is collapsible. Existing scroll position and unchanged turn components survive polling.

The observer reads native JSONL/text journals and Cursor's SQLite composer store without writing to them. CLI chat IDs are excluded. A native `turn_ended` record ends the activity indicator; quiet or stale evidence is shown as unknown, not asserted idle or working. Hook activity supplements the journals. Failed reads retain recent cached rows with unavailable status and disable sending. The selected transcript keeps its last loaded content while reconnecting.

The native sensor used by checkout guards remains separate and unchanged. The richer conversation endpoint does not turn a native Cursor session into Jevellan-managed work, acquire its checkout, select models, or run a CLI agent.

Cursor's journals can lag behind active work and omit tool results. A bounded, generation-specific live feed captures new tool results, failures, responses and thinking from the desktop hooks. The viewer shows those updates separately, keeps working feedback visible beside the composer and offers Jump to latest while reading older history. Old calls without recorded results are labelled Recorded; their inputs remain readable, and missing results are explained when expanded. Timestamp/context envelopes are removed from user messages and generated titles.

## Delivery

Every composer offers a delivery choice. Ordinary conversations use the existing correction/next-step-note mechanisms. Cursor uses its desktop hook runner:

- **Steer current work:** queued text is returned as `additional_context` by the next `postToolUse` or `postToolUseFailure` hook. It does not interrupt an in-flight tool or model response.
- **Send after this step:** queued text is returned as `followup_message` by a completed `stop` hook. A completed session stays available through that hook for up to seven hours. No synthetic keep-alive prompts are submitted.
- A desk prompt supersedes the prior generation. Stale steering and other queued messages from a superseded generation expire visibly; they are not injected into a different turn. Cancelled/error stops do not automatically resume.
- Retries use the same client message ID. The local queue records handoff before returning stdout to prevent automatic duplicate delivery. **Handed to Cursor** is intentionally not an assertion that Cursor accepted or executed the message. A process crash at that boundary can require checking the native conversation.
- An old idle conversation without an active hook can be viewed, but cannot yet be messaged. Start one turn in that existing conversation in Cursor after enabling hooks. Starting new sessions from Jevellan is deferred.

These capabilities are based on the [Cursor hook contract](https://cursor.com/docs/hooks), not a public API for arbitrary editor input. Desktop delivery and Enterprise reporting still require observation in the user's environment; neither is claimed verified.

## Connection and installation

Regular Jevellan devices use authenticated owner requests. Configure an existing VS Code dev-tunnel SSH connection in Settings → Devices. If the tunnel endpoint is on another machine, supply its gateway host and user; the second SSH client runs there using that gateway's existing identity file. The target remains `127.0.0.1` at the supplied tunnel port. No identity is copied and no agent is forwarded. The connector creates no tunnel, port forward, listener, remote daemon, or Cursor CLI session. SSH host-key checking stays enabled. Missing/expired transport is reported rather than replaced with another route.

`npm run build` produces standalone Node helpers and an installer in `packages/mesh/dist/standalone/`. These contain their JavaScript dependencies and need Node 22.13+ on the target. Transfer all three `.mjs` files and the accompanying repository and Zod licenses into the target's isolated Jevellan home. Run `JEVELLAN_HOME=/absolute/jevellan/home /absolute/path/to/node cursor-install.mjs --standalone` there. The installer prints the stable, versioned `cursor-stdio.mjs` path to configure in Settings. Remote data paths must point to a Jevellan home, never a native agent home.

For a local installed/development copy, the explicit operator command `JEVELLAN_HOME=/absolute/jevellan/home node scripts/install-cursor-hooks.mjs` installs a stable helper copy and adds seven hook entries. It preserves unrelated hook entries (including prompt hooks) and other settings, writes an exact backup under the isolated home's `cursor/backups`, and records a versioned installation receipt. A symbolic-link hook configuration is left to its existing manager. It is never invoked by build or daemon startup. The user explicitly approved this native configuration exception on 2026-09-28. Review of generated hook configuration is also available in Settings → Devices.

Stored messages, hook state, installation receipts and connection settings are versioned schemas. Transcript IDs in browser routes are hashes. Native session IDs remain in owner-local runtime state and are not written to repository evidence.

## Current evidence

- **Live installation:** five Jevellan hook entries installed on CSG, preserving all 12 existing entries. Corrected standalone helpers also replaced the local Mac installation, preserving all 17 existing entries. No Cursor turn was submitted, stopped or steered.
- **Live observation:** after the user started the existing tunnel, the gateway connection returned two CSG sessions active within the last five days, both idle. Neither had an active Jevellan delivery hook yet. No transcript content or native session identifiers were recorded in evidence.
- **Build/static checks:** production build, TypeScript checking and lint passed.
- **Live activation:** at the user's request, main through `8075c8e` runs on the Mac mini using the existing pilot data and HTTPS address on port 9444. CSG is configured through the existing Dev Madrid gateway. The running app's reader observed two recent CSG conversations without unavailable sources. Loopback/tailnet health and the exact served application were checked as installation readiness.
- **Reported-failure repair:** the user subsequently reported display and feedback failures. All 13 focused Cursor regression cases now pass; live browser inspection confirmed readable tools, clean titles and new CSG hook activity. Seven Jevellan hooks are installed on each device, with all unrelated hooks preserved. See [repair evidence](acceptance/cursor-feedback-2026-09-28.md). Broad tests and live delivery tests remain unrun.
- **Pending:** a native Cursor turn in each existing conversation to activate its newly installed delivery hooks, followed by user-led messaging and UI iteration. The Dev Madrid checkout and services were not changed.
- **Not claimed:** phone acceptance, Cursor Enterprise ledger attribution, reliable delivery on the installed CSG Cursor version, or the user's acceptance.
