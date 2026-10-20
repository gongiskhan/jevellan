# Bridge: run log

This run builds the engine side of the Jevellan bridge, the twelve tools, the plugin and the bridge session on the branch `bridge`. A later pass on main builds the new UI, the four-layout journeys, the parity tests and the release. Every result is labelled live, simulated or not run.

## Decisions

- Branch: the owner chose for this run to work on the branch `bridge` instead of main until the closing merge. This is the one exception to the AGENTS.md "main only" rule. The plan was a fast-forward merge into main at the closing; it did not happen (see Closing).
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

Built: `jevellan bridge [--project p] [--restart] [--stop] [--claude-config-dir dir] [--remote-name name]` (tmux `jv-bridge-<project>`, Sonnet at medium effort, remote control named "Jevellan · {project}", the plugin by `--plugin-dir`, the development channel, the appended system prompt, only the Jevellan tools allowed, Bash, Edit, Write and NotebookEdit disallowed, `--continue` when a session exists, the start-up dialogs answered through tmux, a minute check that starts a wanted bridge again); the push queue with acks on the state point, fed from open decision items and the hub's notification documents (deploys, rollbacks, coordinator outages), coordinator replies and answers, failed job runs, exhausted budgets and a stalled coordinator; quiet hours held durably with one summary when they end and urgent pushes at once; more than three at a time as one message; every unacked push again on reconnect; the `inject` transport for an idle bridge.

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

## Backend suite (before the first main merge after phase 0)

Simulated, on a separate snapshot clone of `1590ade4` while the parallel run's gate loaded the machine: 2521 passed, 37 failed, 1 skipped, in 5227 s. 17 of the 19 failing files fail on main in the parallel run's own gate (its full backend at `eb7855ae`: 2501 passed, 32 failed), so they are not this branch's. The two others: `project-turns` expected the old launch environment without `JEVELLAN_ROLE` (expectation updated: the role is intended), and `conversation-service` failed on tests that ran 60 to 92 s against a 60 s limit under the load; rerun alone below.

Rerun alone: `conversation-service` 95 of 95 passed (load timeouts confirmed); `project-turns` passes with the role in its expected environment. No failure is this branch's.

## Journey A: one machine, one account (live)

Live, 2026-10-20 02:04 to 02:15. The working tree was built in a separate clone and installed with the documented local command as a named second installation (`JEVELLAN_HOME=<test home> node bin/jevellan.mjs install --name bridgetest --from <clone> --no-https`): it took the next free port (9772), its own user service and its own `jevellan-bridgetest` command; the live service and command were checked unchanged. A passphrase, the dedicated Jev key, a sandbox repository and the dedicated test Claude account were added; `jevellan-bridgetest plugin install --claude-config-dir <temporary folder>` installed the plugin there (`claude plugin list` shows `jevellan@jevellan-local`, user scope, enabled); doctor showed ten of ten after the Jev model was set to one the key lists, plus its plugin line.

Engine side live on the test account (it was at 96% of its week, so this installation's budget for it was raised to 99% for the run; coordinator Sonnet low, threads limited to Sonnet). Claude Code side live under this run's folder, headless, in the sandbox folder (project resolution by working folder), with the generated plugin. "add a task to fix the typo in the README" called `work add` (T1); the thread fixed the typo and landed it on the sandbox's main as `1ad484a` within a minute; "what's running?" called `status` and showed T1 landed and not deployed; "why did Jev pick that model?" called `ask_coordinator ask`, and the coordinator's answer came back within the wait. The thread's native session lists only its own worker tools and none of the twelve owner tools.

Found and fixed during the journey (each rerun live):
- With the account's claude.ai connectors loaded, "add a task" went to an external task connector instead of `work`. The bridge now starts with `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so only the Jevellan tools are there; the eval does the same.
- Without the bridge prompt, "why" questions went to `jev` (its specified description names the model choice). The descriptions stay exact; the forwarder now gives every session server instructions: "why" and "what next" questions go to `ask_coordinator` with mode ask, `jev` is for Jev's rules, prompts and lessons, and project tasks go to `work`. After this, Sonnet routed the question to `ask_coordinator ask`.
- `doctor` reported the forwarder unreachable when the service answered that no project existed yet; it now means unreachable only when the service did not answer.

## Merge of main after the parallel run stopped

Merged `origin/main` at `c1248ab2` (the parallel run's closing fixes) with no conflicts; typecheck and lint passed. Full backend on a snapshot of the merge, unloaded: 2579 passed, 3 failed, 14 skipped in 1855 s. The three failures were list-view expectations without the new `attention` field of the sidebar rows (this branch's change); they pass with the field. No other failure.

## Journey E: takeover of a real Claude thread (live)

Live on the test installation, 02:16 to 02:21. A thread was told to write three notes with 40-second waits between them. `thread open T2` interrupted it at its safe point (the turn ended "steered" and the thread rested) and held it within 4 seconds; status showed "held by you"; tmux `jv-T2` ran the installed `thread attach` with the resumed native session. Remote control was not used: the test account folder holds only a token, so the copy said so (the decision recorded in phase 0). A message typed into the pane ("skip the remaining sleeps, also create notes/owner.txt containing heron") was carried out in the held session. The test installation was reinstalled while the thread was held (to take the tmux target fix below); the hold survived the restart. `thread return T2` ended the session through tmux in 3 seconds; the thread's next SDK turn continued from the terminal's work and reported all four files; it landed on the sandbox's main as `5500618`, which contains `notes/owner.txt` with "heron". The idle warning, keep and automatic return on a controlled clock are covered by the simulated tests (phase 5). The Codex variant: simulated only.

Found and fixed: tmux pane commands (`send-keys`, `capture-pane`) need the exact-session target with a colon (`=name:`); the bare `=name` works only for session commands, so the bridge's start-dialog answers and the `/exit` of a return were silently not delivered. Fixed in the bridge and takeover code and their tests.

## Journey F: Jev control through the bridge (live)

Live, 02:25 to 02:27, headless sessions with the bridge system prompt and the generated plugin against the test installation (Sonnet at medium effort, one resumed conversation; the engine's Jev calls and threads live). Caller log, in order: `jev prompts`, `prompt_show`, `prompt_propose` (edits, a unified diff, a replay of the two stored l-v1 decisions with real Jev calls, "not applied yet"), `prompt_apply` after the owner's "yes" (v2 live), `prompt_rollback` (v1 live again, v2 in history), `override` with undo on T1's landing route after landing (a revert task landed as `59f9e51` through the normal flow and the work was queued again as T4 with the owner's note), `override` with only on T2's placement (lesson recorded, nothing changed), `jev lessons` and `rules`. Lesson L1 ("should have asked") reached Jev: T4's landing route was ask-owner and it waits as a decision item.

Found and fixed: the `ask_coordinator` input schema offered `mode` only as "ask" (the merged schema took the first action's literal), so "never land parser work without asking me" could not be sent as an instruction; both modes are now offered, and the contract test checks it. A lowercase proposal id (`p1`) was refused once; rule, lesson and proposal ids are now accepted in any case.

Note: the bridge answered in European Portuguese to English requests in this account; rule 10 of the specified prompt says to reply in the owner's language, and nothing in this run's folder sets a language, so this is taken to come from the account's own preferences. Left as is; the owner's own account will show which applies.

## Journey B: the bridge and its pushes (live)

Live, 2026-10-20 02:34 to 03:20, nine rounds; the ninth passed every step. A test bridge for a fixture project ran in tmux as a real Claude Code session (Sonnet, medium effort) under remote control named "jevellan-test · bridge journey", under this run's own logged-in folder, with the engine on the simulated runtime. Each round's session was ended by the test.

1. A waiting item arrived over the channel and the bridge told the owner what it was in two sentences; in the next 30 s no write tool was called.
2. A deploy message arrived; "deploy" typed into the session called `respond` on W2 with "Deploy a1b2c3d", and the decision was answered with that option.
3. A coordinator outage arrived with the existing copy.
4. With quiet hours on, two ordinary items were held and an urgent "Production is down. Roll back?" went at once; the bridge said a rollback needs the owner's words and did nothing. When quiet hours ended, "2 updates while you were away" arrived as one message.
5. With the bridge stopped, two items waited; the bridge started again with `--continue` and both arrived.

Found and fixed (each confirmed by the next round):
- Claude's terminal cuts a channel line at about 60 characters, so the test reads the bridge's session transcript, which has every push in full.
- The workspace trust dialog defaults to "No, exit", and a key sent before the dialog takes input is lost; one round's bridge exited there. The bridge folder is now trusted in the account's own preferences before the start (as takeover already did for worktrees), and a start-up dialog is answered on its second sighting and not again within five seconds (answering a dialog still on screen sent Down then Enter to the channel confirmation, which picks Exit).
- Claude drops a channel message sent while it is still starting: after a restart, the first of two waiting pushes was acked by the new forwarder two seconds in, with the channel confirmation still on screen, and never reached the session. Pushes now wait until three seconds after the bridge's prompt showed, and the forwarder relays only after the session initialized the connection.
- A bridge that is shutting down still acks. Every start now sends again each push acked since the previous start whose text is not in the bridge's transcript.

## Journey D: goals through the bridge (live, in part)

Live, 02:27 to 02:31, headless sessions with the bridge system prompt against the test installation. "Create a goal called Docs quality ... then tell the coordinator to give it one night item that reviews the README every night, and to plan a first task for it" called `goals create` (G1) and `ask_coordinator tell`. The coordinator queued T5 "Review README for quality" under G1 within two minutes; "what's running for Docs quality?" called `goals show` and showed T5 running with the goal's label, its landing question W3, and the coordinator's decision. "pause Docs quality" called `goals pause`: G1 paused, T5 kept running to its end, and the goal view said so. The coordinator did not add the night item it was told to add in that time, so "due" from a night item was not seen live; it is covered by the simulated goal tests. Result: pass for create, tell, labels, show and pause; the night item part not seen live.

## Bridge behaviour eval (live)

Headless, Sonnet at medium effort, the thirteen utterances of the specification against a fixture on the simulated runtime.

- Round 1 was invalid: the test spawned Claude synchronously, which blocked the event loop of the process that also runs the engine, so every tool call waited until the 240 s limit. The eval now spawns without blocking.
- Round 2: 11 of 13. "switch deploys to nightly" went to `jobs schedule` and "roll back" stopped after `status`.
- Round 3: 11 of 13, different misses: "deploy" went to `jobs run`, and "never put parser work below high effort" went to the coordinator as an instruction.
- The specified prompt and descriptions are exact, so the routing went into the forwarder's server instructions, which this run owns: a short answer such as "deploy" answers the waiting item through `respond` and deploying is never a job run; standing placement rules are `jev rule_set`; the deploy switch is `config set deploy mode`; "roll back" is `jobs rollback` without confirm. The `jobs` refusal for an unknown "deploy" item now names `respond` and the deploy switch, and the deploy view names the item to answer.
- Round 4: 13 of 13.
- Round 5, on the final code: 13 of 13.

## Browser journeys in the desktop light layout (live, existing suites)

The three desktop light projects at the bridge head: 60 passed, 3 failed, 37 did not run (the projects file runs serially and stops at its first failure). The same three fail on main at `c1248ab2` in a separate clone, so none is this branch's:

- LJ2 expected `settings.autoMerge`, which version 5 of the work settings replaced with `autoLand`.
- J8 and J11 open `/` expecting the new-conversation composer; Home now opens the first sidebar project.

All three tests were updated (`autoLand`, and `/new`). Rerun with the updates: three more runs of the projects layout at the final code each stopped at a different test, never one this branch touches (an ECONNRESET in "Thread images open", PJ3b stuck on "Connecting…", LJ2 waiting for a pull request, LJ4 timing out on sign-in), and each passes alone. A probe of the fixture server's event loop found stalls of 1 to 2 s about every 15 s and requests that got no answer within 15 s; the same probe on main at `c1248ab2` (with only the LJ2 expectation fixed so it runs on) showed the same stalls and failed the same way at LJ3 with a 15 s request timeout. The flakiness is main's; the desktop light and improver layouts passed in full, and J8, J11 and LJ2 pass with the updates.

## Closing

Main had not moved past `c1248ab2`, which the branch already contains; the only UI change Codex made after the branch's base is one icon entry, which holds no logic, so the UI sweep moved nothing.

The parallel run ended at its release clock with its gate unaccepted: 0.6.0 was never tagged or installed, and both machines run 0.5.1. Merging `bridge` into main would have put the bridge into that unfinished release, so this run did not merge, did not install on either machine and did not start the ekoa-code bridge. The Codex pass (`CODEX-PASS.md` in the private run folder) finishes 0.6.0 first, then merges `bridge`, then releases 0.7.0.

Checks on the final code: typecheck and lint pass; the bridge eval 13 of 13; Journey B pass; backend suite 2583 passed, 0 failed, 15 skipped (the opt-in real-model tests); browser journeys in the desktop light layout as above (failures only from main's flaky projects file).

The test installation `bridgetest` was uninstalled (its data stays in the private run folder) and the live service was checked unchanged. The owner's steps, the journeys, the eval, usage readings, the bridge's token cost, the ten decisions and the known problems are in the private handoff, `/home/ggomes/.jevellan-build/bridge/HANDOFF.md`.

## In-place accounts and a macOS playground (live)

Live, 2026-10-20, on a Mac, with a separate named installation built from this branch. It ran on its own port and home, as a single-machine hub that joined no mesh, with a scratch clone of a project whose origin is a local bare repository. The owner's Claude Code folder and Codex folder were registered as accounts in place: `jevellan account in-place <label> --runtime claude|codex --folder <dir>`. Nothing is copied. Jevellan never writes Rigging into such a folder and refuses its own logins for it. The registry is `homes/in-place.json` (`in-place-homes-v1`), so every check that compares a home with `Homes.account` still holds.

Found on macOS and fixed, each with tests:
- **Login detection.** Claude Code keeps a claude.ai login in the login keychain ("Claude Code-credentials-" and the first eight hex digits of the folder path's SHA-256), not in `.credentials.json`. The bridge, takeover and login status look for either. Only the entry's presence is read.
- **HOME.** macOS finds that keychain through HOME, so a session with HOME set to the account folder was "Not logged in". An in-place Claude folder keeps the owner's HOME; its configuration still comes from `CLAUDE_CONFIG_DIR`.
- **PATH in tmux.** tmux starts a session through the owner's login shell, whose profile put an older claude (no `--effort`) first on PATH, and the bridge exited at once. The bridge script restores the service's PATH and runs claude by its full path. Takeovers run attach with that PATH.
- **Process name.** Claude's native build runs as a file named after its version, so the pane shows "2.1.304". The bridge counts that as running.
- **Memory hooks.** In-place launches no longer wait for the project memory hook, which would have to be written into the owner's folder. Turn-end capture still runs.
- **Connectors.** A claude.ai login hands its connectors (mail, calendars, documents) to every session. Every Claude session Jevellan starts now runs with `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
- **Takeover.** It accepts an in-place folder and adds only the worktree's trust to its preferences.

Live results: the bridge ran under remote control. Channel pushes reached its transcript. From the bridge, `respond` answered a test question and approved two landings and a deploy, and `work add` queued three tasks, each of which landed in the local bare repository. A takeover resumed a running thread's own session under remote control, took a typed instruction, and landed it after "return as done". The bridge eval subset (status, overnight digest, a why question, add a task, take over, a push arriving), headless on Sonnet at low effort against the simulated fixture: 6 of 6.

## Merge into main and first fixes (2026-10-20)

`bridge` was merged into main as `47bb8565`, in a fresh checkout of `origin/main` at `bb1ee094` (0.7.1). The merge was first made on `336248ca` and tested there; main then moved by one docs and roadmap commit, and the same merge was made again on it. From this merge on, main is the only branch; `bridge` is not pushed again. The one conflict was the `@jevellan/core` import in `packages/projects/src/launch.ts`: it keeps `projectEnvironment` (0.7.1's filter of command-only project variables) and `IN_PLACE_RIGGING_REASON` (the in-place memory hook exemption), and both code paths are unchanged. On the merge: typecheck and lint pass. The bridge eval subset, on Sonnet at low effort, passed 6 of 6. The backend suite: 2594 passed, 22 skipped and 1 failed. The failure was `test-server-close`, which the merge does not touch: a fixture server killed while starting took longer than 40 s to remove its root while other runs loaded the machine, and the file passes alone. Live on the macOS playground, updated from the merge: status, a push (a landing question reached the bridge), and a takeover that took a typed instruction and landed after "return as done".

Three fixes followed, each with a failing test first, from a live installation on 0.7.1:
- **Status crashed on a thread merged through its pull request** ("Cannot read properties of undefined (reading 'commit')"). Such a thread counts as landed but has no landing record, and the render read its landing commit. The run view now carries the pull request, and the line reads "merged as PR #n".
- **Every coordinator turn failed with "A journal projection cannot replace earlier entries."** The hub rendered journal entries from the payload as the current schema parses it. A default added in 0.6.0, the owner command `kind`, changed entries that were already written, and the append-only check refused the projection. Entries now render their recorded payload. The manifest moves to `project-journal-state-v2`, which records the renderer version that wrote the files. A journal written by another renderer, every v1 manifest included, is rebuilt once. The same renderer still never replaces an entry.
- **A stopped coordinator could not be restarted from the tools.** Status showed it as idle. Status now shows "stopped" after two failed turns. `ask_coordinator` takes mode `restart`, which sends an owner message through the durable delivery, with `fresh` to drop the session first. A model looking for a restart only found it on `ask_coordinator`: on `thread` it did not. The bridge eval gains "the coordinator stopped, restart it".

On the fixes: typecheck and lint pass. The bridge eval subset with the new utterance passed 7 of 7. The backend suite: 2598 passed, 23 skipped and 1 failed. The failure was the forwarder contract's list of `ask_coordinator` modes, which was then updated, and the file passes.
