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

## P1 engine map

`docs/surface-map.md` lists 69 capabilities, 310 pieces of UI logic with the phase that moves each, 159 settings fields mapped to `config` keys, 14 Jev question sets and prompts, and 36 scheduled things. Written from a read of every file in `apps/web/src`; the "Moves to" column names proposed engine services where none exists yet. Tests: not run (documentation).

## P2 engine views and plumbing

Built: short display ids per project on the state point (`owner-short-ids`, never reused, objects that existed before get theirs in creation order); the status view (`project-status-view-v1`) with run and waiting-item views, ordering and the goal filter computed by the engine; run states derived from the Overview's own board group so both agree; the tool route `POST /api/local/tools/:name` with the twelve-tool catalog (exact descriptions, actions tagged read or write, zod inputs) and a handler registry; the caller log (30 days, JSONL on the state point); the owner event stream (`GET /api/local/events`, SSE with a monotonic `seq` from the clock at start-up, resumable); the status line route; project resolution (argument, session project, working folder, the only project); the recursion guard (`JEVELLAN_ROLE` on every coordinator, thread, verification and attach launch, and in all five environment allow-lists).

UI logic moved: the Overview's thread groups and their order now come from the engine (`board` in the work view); the page only pages Resolved by age. Other overview and thread-list rows stay with the later pass (see the surface map).

Deferred within P2: decision-record fields for placements (`rawChoice`, `inputsRef`) are added for the landing route in P8; placement decisions keep their existing record.

Simulated: golden files for the six scripted states (idle, busy, waiting, held, landing, crashed) plus the goal filter, and route, event-stream and recursion-guard tests on the simulated runtime, passed. Browser journeys of the rewired Overview: not run (the parallel run was in its release gate; this run runs no browser suites then).

## P3 plugin and core tools

Built: the forwarder `jevellan mcp` (lists the twelve tools; zero tools and no channel with `JEVELLAN_ROLE`; channel capability only in the bridge), `jevellan call`, `statusline` (with `--wrap` and `install`), `watch`, `attach`, `plugin build|install`, `hook session-start`, a plugin line in `doctor` that never changes its ten checks, and the README's two-command install. The plugin is generated from the tracked neutral `plugin/` folder into the installation's data folder; nothing named after Claude is tracked. Tools: `status`, `activity` (digest, events, decisions), `ask_coordinator`, `work`, `respond`, `thread` (say and stop), `config` (get and the sections that exist), `login` (status).

Decision: `ask_coordinator ask` uses the specification's fallback for every runtime in this version: the question goes to the coordinator as the owner's message with "Answer only, do not act", the tool waits up to `wait_seconds` for the reply, and a later reply is pushed. The fork (S8) works for Claude coordinators; wiring it into the coordinator's runtime adapter is left to the later pass.

Decision: tools run on the state point. On a member device the tool route answers that the tools run on the state point; forwarding member calls to the hub is left to the later pass.

Simulated: contract tests through the official MCP client (exact twelve tools and descriptions, action enums, read and write tags in the caller log, zero tools with a role set, the bridge's channel capability, the not-running sentence), CLI tests (call, status line within its budget and with `--wrap`, plugin build and install into a temporary Claude config folder, the session-start hook, status line install), and tool action tests. Journey A: not run yet (real models; waits for the parallel run's gate).

## P4 bridge and push

Built: `jevellan bridge [--project p] [--restart] [--stop] [--claude-config-dir dir]` (tmux `jv-bridge-<project>`, Sonnet at medium effort, remote control named "Jevellan · {project}", the plugin by `--plugin-dir`, the development channel, the appended system prompt, only the Jevellan tools allowed, Bash, Edit, Write and NotebookEdit disallowed, `--continue` when a session exists, the start-up dialogs answered through tmux, a minute check that starts a wanted bridge again); the push queue with acks on the state point, fed from open decision items and the hub's notification documents (deploys, rollbacks, coordinator outages), coordinator replies and answers, failed job runs, exhausted budgets and a stalled coordinator; quiet hours held durably with one summary when they end and urgent pushes at once; more than three at a time as one message; every unacked push again on reconnect; the `inject` transport for an idle bridge.

Decision: the bridge refuses to start without an interactive Claude login in the account's folder (remote control needs it) and names `jevellan login <account> --interactive`.

Simulated: a waiting item reaching a bridge forwarder as a channel notification with its exact text and meta, acked and not sent again; quiet hours, urgent bypass, summary and batching on a controlled clock; the bridge start script's flags, the interactive-login refusal and the restart with `--continue`. Journey B and the bridge behaviour eval: not run yet (real models).

## P5 takeover

Built: `thread open` interrupts a working thread at its next safe point (a steer with nothing queued, so the turn ends and the thread rests), then runs the installed `jevellan thread attach <id> [--remote-control "T31 · title"]` in tmux `jv-T31`; the existing attach marks the thread attached, which already keeps the coordinator, landing and cleanup away and holds its account. Remote control is used when the account folder has an interactive login; otherwise the copy says it is terminal only. `return` (resume, done, stop) ends the interactive session through tmux, waiting up to ten minutes for a turn in progress; resume sends the steering line, done sends the thread to landing, stop stops it. Hold rules: a warning item and push after two hours idle, keep restarts the timer, an automatic return fifteen minutes later, never mid-turn; after a restart a hold whose tmux session is gone is returned. Every steering act is recorded and reaches the coordinator as a line at its next turn.

Simulated: open on a running thread, held status, refusals while held, return with the steering line in the next turn, the idle warning, keep, and the automatic return. Journey E with a real Claude thread: not run yet. Codex takeover: simulated only (S5).

## P6 jobs, nights, deploy switch

Built: the `jobs` tool (list, show, history, night, deploy, health, run, pause, resume, schedule with window start, order, days or an interval, health_run, rollback with confirm); paused command jobs and interval schedules (new optional fields on the job, no misses); missed nights: a window more than its seven hours late opens as a catch-up within `night.catchUpHours` (default 4) and is recorded as missed, later it is recorded as missed and skipped, one `night_missed` push per night; the optional heartbeat; the three-position deploy switch with `deploy.paused`: in nightly and automatic modes the open deploy message is approved through the owner's own answer path once the night's suite passed on its commit (automatic also after the landing debounce), a deploy that changes the database waits and says so, and an automatic deploy that fails or is rolled back pauses deploys.

Decision: in nightly and automatic modes the deploy message stays open (the owner can still deploy earlier) instead of being closed as expired; Jevellan approves it at the right moment. This keeps one deploy record and one item everywhere.

Not built: the intake of external pull requests. Landing a contributor's head with `--no-ff` needs a landing path for a branch that no thread owns; it is left to the later pass, with the rest of the copy specified.

Simulated: the jobs tool on real stores, missed and caught-up nights on a controlled clock, interval due times, and the deploy switch's approval, database hold and pause. Journey C: not run as a whole (no intake; the parts above are covered by tests).

## P7 goals and labels

Built: the `goals` tool (list, show, create, edit, pause, resume, done); a paused or done goal refuses tasks from the coordinator with `G1 is paused.`; done cancels queued tasks; labels and due in status come from the engine. Simulated: the full goal lifecycle with the specified copy. Journey D through the bridge: not run yet.

## P8 Jev control

Built for l-v1, the landing route: the active prompt version is what Jev is asked; the last eight enabled landing lessons replace the old corrections in its packet; the owner's rules are applied after Jev's answer and before the hard guards (project beats global, more `when` fields beat fewer, then the more careful route); the route records `rawChoice`, `rulesApplied`, the prompt version and the lessons. Prompt versions are imported from the code as v1 (l-v1, p-v1, m-v1); proposals take the full text or exact edits, show a diff and replay the last 20 decisions with their stored packets; apply and roll back keep history; a changed code default becomes a proposal. Rules show their effect on the last 30 decisions with no model calls. Lessons are listed, edited and removed; the earlier landing and merge corrections migrate into lessons. `override` covers placements (undo restarts the thread on the owner's choice; only records the lesson) and landing routes (before landing the owner's route is applied; after landing a revert task and a redo task are queued).

Decision: p-v1 and m-v1 are versioned and listed but the engine still reads their code text in this version; placement rules are stored and measured but not yet applied inside placement. Both are left to the later pass.

Simulated: rules, proposals with edits, apply, rollback, history, the rule hook, lessons and overrides. Journey F with real calls: not run yet.

## P9 accounts, logins, secrets

Built: `config add_account`, `remove_account` (disables; accounts are never deleted), `accounts.<label>.budgetPercent` and `.enabled`, `config secrets` (names only) and `set_secret`, `login start` (the account's token login, or `interactive` for the `claude auth login` that remote control needs), `complete`, `status` (with remote-control readiness), the `login_done` push, `jevellan login <account> [--interactive]` and `jevellan secret set NAME` with hidden prompts.

Simulated: Journey G with a stand-in `claude auth login` (link captured, code completes, push sent) and the account and secret actions; secret values never appear in tool output.

## P11 remote MCP

Built: the same twelve tools over Streamable HTTP at `/remote/mcp`, answered only for the configured hostname (the tunnel's Host), with OAuth: protected-resource and authorization-server metadata, dynamic client registration, PKCE S256, short-lived access tokens and rotated refresh tokens stored hashed, identity from a GitHub-compatible upstream sign-in with exactly one allowed login. Off by default; with writes off only reads and `respond` run; deploys and rollbacks are refused remotely even with writes on; every remote call is in the caller log; disabling refuses everything at once; `jevellan remote revoke` deletes every token; `jevellan remote setup` writes the cloudflared configuration and lists the owner's steps.

Simulated: Journey H with a fake identity provider and the official MCP client, including the wrong identity, the disabled endpoint, revocation, refresh rotation and the host check.

### Decision: what the real-model journeys use

Checked live (Haiku, default permission mode, the spike plugin): `--allowedTools mcp__plugin_jevellan_jevellan__*` and the bare server prefix `mcp__plugin_jevellan_jevellan` both let a headless session call the plugin's tool with no permission denial, and with neither the call is denied. The bridge keeps the glob.

The real-model journeys split by who runs the model. The Claude Code side (the `claude -p` plugin calls of Journey A, the bridge of Journey B, the bridge behaviour eval, the takeover session of Journey E) runs live under this run's own logged-in Claude folder, which is the documented way for this run and is never copied. The engine side (the coordinator and the threads of a test installation) needs a managed account with its own token; the only one a test installation can hold is the dedicated test token, so the engine side runs live only while that account has room, and otherwise on the simulated runtime, labelled so in each journey.
