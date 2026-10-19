# Bridge: run log

This run builds the engine side of the Jevellan bridge, the twelve tools, the plugin and the bridge session on the branch `bridge`. A later pass on main builds the new UI, the four-layout journeys, the parity tests and the release. Every result is labelled live, simulated or not run.

## Decisions

- Branch: the owner chose for this run to work on the branch `bridge` instead of main until the closing merge. This is the one exception to the AGENTS.md "main only" rule. The branch is merged into main with a fast-forward push at the closing.
- UI edits in this run are wiring only, checked in the desktop light layout. The four layouts (desktop and phone, light and dark) with vision are left to the later pass for every screen this run rewires; `docs/surface-map.md` lists them.
- While the parallel release run is in its release gate and live checks, this run runs no browser suites and no real-model journeys, and runs heavy commands one at a time at the lowest priority.

## P0 orientation and spikes

Started 2026-10-19 22:45 Lisbon time. The parallel release run was in its release gate (its phase 10) at the start.

First merge of `origin/main`: the branch was created from `origin/main` at `eb7855ae`, which contains the parallel run's build phases 0 to 9; there was nothing to merge.

### S7 login flows in a pseudo-terminal

Live, against temporary empty folders, then cancelled. Claude Code 2.1.304: `CLAUDE_CONFIG_DIR=<folder> claude auth login` prints an `https://claude.com/cai/oauth/authorize?...` link (PKCE, code flow) and then the prompt `Paste code here if prompted >`; the code typed there completes the login. Codex CLI 0.153.4: `CODEX_HOME=<folder> codex login --device-auth` prints `https://auth.openai.com/codex/device` and a one-time code of the form `XXXX-XXXXX`, and completes on its own once the owner enters it. Mechanism chosen: run these two commands in a pseudo-terminal, read the link and code from the output, keep the process waiting; `login complete` types the Claude code into the waiting prompt. Result: pass.

### S9 thinking content for watch

Simulated (code and SDK types read; no model call). The runtime contract already has a `thinking` event with a text delta. The Claude worker emits it from `thinking_delta` stream events (Agent SDK 0.3.281 with partial messages; the SDK's thinking display can be summarized or omitted, so some turns carry none). The Codex worker emits it from the SDK's `reasoning` items (Codex SDK 0.156.1), which are summaries. Mechanism chosen: watch and `activity events` show `thinking` events whenever the runtime emitted them, and text and tools otherwise; nothing new is requested from the SDKs. Result: pass.

### S6 plugin through a local marketplace

Live, in a temporary config folder. A generated folder with `.claude-plugin/marketplace.json` (marketplace `jevellan-local`, plugin source `./jevellan`) and the plugin `jevellan/.claude-plugin/plugin.json`: `claude plugin marketplace add <folder>` then `claude plugin install jevellan@jevellan-local --scope user` (both with `CLAUDE_CONFIG_DIR` set) installed it, and `claude plugin list` shows `jevellan@jevellan-local`, scope user, enabled, read from the generated folder. Mechanism chosen: `jevellan plugin install` runs exactly these two commands. Result: pass.

### S1 plugin tools in a session

Live, Claude Code 2.1.304, Haiku, one headless `claude -p --plugin-dir <generated plugin> --output-format stream-json` call under the run's account folder. The session's init message lists the plugin's stdio MCP server as `plugin:jevellan:jevellan` (connected) and its tool as `mcp__plugin_jevellan_jevellan__status`. Mechanism chosen: the bridge allows `mcp__plugin_jevellan_jevellan__*`. A plugin loaded with `--plugin-dir` is addressed as `jevellan@inline`. Result: pass.

### S2 channel push into an interactive session

Live. The plugin's MCP server declares `capabilities.experimental["claude/channel"]` and sends `notifications/claude/channel` with `{ content: "[Jevellan] ...", meta: { kind, id } }`; meta keys must be letters, digits and underscores. A local plugin is not on the channel allowlist, so the session needs `--dangerously-load-development-channels plugin:jevellan@inline` (the documented `--channels` accepts only allowlisted plugins), which shows a confirmation dialog once per start ("I am using this for local development"); the flag is ignored with `-p`. The push appeared in the transcript as `← jevellan: [Jevellan] W99 waiting on you: ...` and the model answered it on its own turn. Other first-start dialogs seen in a fresh folder: workspace trust and a browser-tools prompt. The channel gives no delivery receipt: the notification resolves when written to the transport. Mechanism chosen: transport `channel` with the development-channel flag; `jevellan bridge` answers the start dialogs through tmux (trust is pre-accepted for the bridge folder, the channel confirmation and other first-run prompts are confirmed by key presses while their text is on screen). Acks in Jevellan's push queue mean "written to the bridge's forwarder". Result: pass.

### S3 the same in a remote-control session

Live. `claude --remote-control "jevellan-test · S3 channel" --plugin-dir ... --dangerously-load-development-channels plugin:jevellan@inline` started with `/rc active` and a claude.ai session link, and the channel push arrived in its transcript 40 seconds later. The test session was ended right after. Whether the owner's phone notifies on such a push can only be checked by him (handoff). Result: pass.

### S4 takeover of a Claude thread

Live, Haiku, temporary folder. An Agent SDK 0.3.281 turn in streaming input mode was interrupted with `interrupt()` while its tool call ran (receipt `{"still_queued":[]}`, result `error_during_execution`). Then `claude --resume <session id> --remote-control "jevellan-test · S4 takeover"` in tmux showed the interrupted conversation with `/rc active`; a message typed into the pane got its answer; `/exit` printed `claude --resume <same id>`. Interactive resume keeps the session id: the session file stayed the same and no new one appeared. A new SDK turn resuming that id answered with the word typed in the terminal. Mechanism chosen: open interrupts at the safe point, resumes interactively with remote control in tmux `jv-<id>`, and return resumes the same session id through the SDK. The resumed interactive session showed the workspace-trust prompt in a fresh folder; Jevellan pre-accepts trust for thread worktrees in the account's config before opening. Result: pass.

### S5 takeover of a Codex thread

Simulated only, as this run's brief says; the live check is left to the later pass. The existing thread attach already builds `codex resume <session id>` against the account's managed Codex home (`packages/cli/src/thread-attach.ts`). Mechanism chosen: `thread open` on a Codex thread starts that command in tmux, terminal only. Result: not run live.

### S8 asking the coordinator through a fork

Live, Haiku. While an Agent SDK turn was still running a 40-second tool call, `query({ resume: <id>, forkSession: true })` with read-only tools answered a question about the conversation in about 3 seconds with a new session id, and the original turn finished normally 30 seconds later. Codex has no fork in its SDK (0.156.1). Mechanism chosen: `ask_coordinator ask` forks the Claude coordinator's native session; for a Codex coordinator it falls back to tell with the prefix `Answer only, do not act:` and pushes the reply. Result: pass for Claude; fallback for Codex.

### Decision: remote control needs an interactive Claude login

Live check: a session started with only a long-lived `claude setup-token` credential (`CLAUDE_CODE_OAUTH_TOKEN`, an empty config folder) ran as "Claude API" and did not start remote control, as the Claude Code documentation says. Jevellan's managed Claude subscription accounts hold exactly that kind of credential, so neither the bridge nor a takeover can reach the Claude app with it. Choice: a Claude subscription account gains an optional interactive login, made by `claude auth login` into the account's managed folder (S7), used only for remote-control sessions (the bridge and takeover). Model turns keep using the existing token. `jevellan bridge` refuses to start without an interactive login for `bridge.account` and names the command that makes one; takeover without one falls back to plain tmux and says so in its copy. Real-model tests in this run use the run's own logged-in account folder, which has an interactive login.

Time zone: every tool prints times in the project's configured time zone (the nightly window's), Europe/Lisbon by default, formatted with an explicit time zone so output never depends on the machine.

Push transport: `channel` by default. Its start dialogs are answered by `jevellan bridge` through tmux; if the session does not reach its prompt in time, the bridge falls back to `inject` and records it. The bridge behaviour eval runs headless (`-p`), where channels are ignored, so its push utterance is delivered as a message starting `[Jevellan push]`, which rule 6 of the bridge prompt covers.
