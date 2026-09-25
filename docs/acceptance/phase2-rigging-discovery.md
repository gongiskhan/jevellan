# Account-local Rigging discovery and recovery

Rigging now discovers the supported files in Jevellan's isolated Claude Code and Codex account homes. The account inventory joins the existing managed-item rows in Skills, MCP servers, Hooks, Rules, Commands and Settings. Installed copies can be shown explicitly; loose items, changed installed copies and parked items are visible by default.

## Implemented behavior

- Delivery records distinguish installed files from loose files. A changed installed file retains its ownership and is marked as changed outside Rigging. It is not silently adopted or overwritten.
- Each local copy names its account and runtime. Discovery does not create absent account homes, follow symbolic links or inspect native agent homes, authentication files or session stores. An unreadable item is reported without hiding other accounts.
- Local text edits autosave through a content-and-ownership fingerprint. A stale save leaves the newer file intact and offers **Discard draft and reload**. Installed copies, package snapshots, redacted content and unsupported binary content are read-only.
- A skill is a complete directory bundle. Editing changes its `SKILL.md`; parking/restoring preserves all files and executable permissions. Other supported files are moved individually. Text editing is bounded to 1 MB, and a managed bundle to 256 files / 10 MB.
- Hooks and MCP servers inside supported configuration files are individual entries. Settings are top-level values. JSON/TOML edits preserve other values; serialization can normalize formatting and TOML comments. Restored hooks are appended once, while occupied server/setting names are refused.
- **Park** moves a local item out of its runtime home into Jevellan's parked store. **Restore locally** brings it back to that account, without replacing an existing destination. Automatic delivery archives remain recoverable and read-only. An automatic backup identical to currently active content is not presented as a disabled item.
- **Park changed copy** preserves a changed installed file or bundle before a managed delivery retry. For a changed installed configuration, the complete file is preserved; individual entries remain read-only because the current delivery record owns the container. **Retry delivery** reruns the existing APM delivery path.
- Every move has a versioned durable intent. The destination is preserved before a configuration entry is removed from its source. Exact interrupted results can finish through **Retry**, including a lost completion record. If outside changes make the intent ambiguous, both copies remain intact. **Keep files as they are** cancels the pending move without deleting either copy.
- Delivery, local edits and moves share the same account-home queue. A loose edit waiting behind APM cannot overwrite a file that became managed in the meantime.

Inventory responses contain metadata rather than configuration values. Detail responses redact known credentials; redacted documents cannot be edited, and credential-bearing content is refused before being moved into the parked store. Invalid configuration diagnostics do not quote the original input.

## Reference behavior

Read-only sources: Garrison's `primitive-state.ts`, `primitive-state.test.ts`, `quarters.ts`, `quarters-crud.test.ts`, `quarters-two-homes.test.ts` and `state-transitions.ts`. The adapted behaviors are disk-versus-lock ownership, owned drift, all-loose discovery without a record, account separation, read-only managed content, complete bundle preservation and park/restore collision handling. Jevellan adds versioned move intents, stale-save fingerprints and a shared delivery/edit queue.

Native-home sharing, native imports, plugins, quarantine, the global memory store and Garrison-specific package metadata are not used. The current inventory covers the runtime surfaces Jevellan already delivers and consumes: skill/rule/command/hook files, Claude's `CLAUDE.md`, `settings.json` and `jevellan-mcp.json`, and Codex's `AGENTS.md`, `config.toml` and `hooks.json`.

## Verification

The initial component/delivery run passed **23 cases in two files in 8.21 seconds**, including actual installed APM delivery into disposable homes. After adding pending-move cancellation, the inventory and Settings HTTP checks passed **22 cases in two files in 5.47 seconds**. A further regression covers automatic backups whose contents are already active. The final inventory and Settings HTTP run passed **23 cases in two files in 7.20 seconds**.

The first affected browser run passed all four existing Settings workflows. Its four new workflows failed at the textarea selector: the captured accessibility tree showed the editor and its content, but exact label-text lookup did not find the controlled textarea. The test now uses the textarea's accessible role and name. This was a test selector failure, not a missing editor or a passed UI check. The final affected browser run passed **eight workflows in 36.1 seconds**. It covers retry of a lost move receipt, stale autosave, discard/reload, subsequent successful autosave, Markdown preview, whole-bundle park/restore across reload, package read-only detail, runtime filtering and Codex MCP edits that preserve other settings. Representative desktop/phone and light/dark panels were visually inspected. The complete **44-workflow browser matrix passed in 3.4 minutes**, covering all existing workflows with the new shared account fixtures. Typecheck, lint and the production build also passed. The full unit suite has not been rerun for this increment; the broader unit-test history is recorded in [REPORT.md](REPORT.md).

These checks use actual isolated files, APM, Git-independent account storage, HTTP and rendered UI. Provider login and model responses remain simulated in browser fixtures. No live provider acceptance or Claude SDK vision pass is claimed.

| Layout | Local edit and preview | Parked item | Codex MCP edit |
| --- | --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-rigging-local-desktop-light.png) | [Capture](screenshots/phase2-rigging-parked-desktop-light.png) | [Capture](screenshots/phase2-rigging-mcp-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-rigging-local-desktop-dark.png) | [Capture](screenshots/phase2-rigging-parked-desktop-dark.png) | [Capture](screenshots/phase2-rigging-mcp-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-rigging-local-phone-light.png) | [Capture](screenshots/phase2-rigging-parked-phone-light.png) | [Capture](screenshots/phase2-rigging-mcp-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-rigging-local-phone-dark.png) | [Capture](screenshots/phase2-rigging-parked-phone-dark.png) | [Capture](screenshots/phase2-rigging-mcp-phone-dark.png) |

## Remaining phase work

This is account-local discovery and recovery. Loose skill/rule/command promotion into managed APM delivery is now connected; its capture, runtime choices and durable retry have [separate evidence](phase2-rigging-promotion.md). Live manual journeys and native integration/lifecycle evidence remain before phase 2 can close.
