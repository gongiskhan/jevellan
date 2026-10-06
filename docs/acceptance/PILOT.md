# Pilot handoff · 25 September 2026

The user requested a usable pilot and deferred the remaining build. This is not section-20 completion or user acceptance.

- **App:** https://goncalos-mac-mini-1.tail31efa.ts.net:9444/
- **Source:** https://github.com/gongiskhan/jevellan
- **Earlier recorded screens and Codex demonstration:** https://goncalos-mac-mini-1.tail31efa.ts.net:9443/#screens

## Current pilot

On 2026-10-06 the Projects build became active on the pilot at the same address, superseding the copy described under Running copy below. It runs with the same data home, loopback port and Tailscale route.

- The first activation installed commit `49106b7` in `~/.jevellan-build/pilot-projects-2026-10-06`.
- A second activation the same day installed commit `6647f91` (the vision fixes) in `~/.jevellan-build/pilot-projects-2-2026-10-06`. Its launcher also enables the installation control file.
- The first Projects release is kept for rollback. The plan-acceptance build of 2026-10-03 (`~/.jevellan-build/pilot-plan-approval-2026-10-03`) is also still intact.
- Both times, accounts, projects, the vault, configuration, settings and every conversation ledger were preserved, and no Projects work was started on the pilot. See the [Projects deployment evidence](deploy-projects-2026-10-06.md).

Terminal takeover works on the pilot from 2026-10-06 (second activation). To take a thread over, the owner runs on the mini:

    JEVELLAN_HOME=~/.jevellan-build/pilot-2026-09-25/home ~/.nvm/versions/node/v22.22.0/bin/node ~/.jevellan-build/pilot-projects-2-2026-10-06/app/bin/jevellan.mjs thread attach <threadId>

With `doctor` in place of `thread attach <threadId>`, the same command runs `jevellan doctor` against the pilot. A takeover of a real thread has not run on the pilot yet.

The [ordinary conversation update](conversation-parity-2026-09-29.md) brings chronological formatted transcripts, readable thinking capture and composer live feedback/Jump to latest to normal Jevellan work.

The [session list controls](session-list-controls-2026-09-29.md) add per-row Rename and drag-and-drop ordering (long press on mobile), with saved presentation shared by browsers using this installation.

The [native conversation update](native-conversations-2026-09-29.md) is active: recent Claude Code and Codex conversations now appear beside Cursor with formatted, read-only transcripts and activity indicators. The mini, CSG readers and existing Dev Madrid SSH reader are updated.

The [conversation layout update](conversation-space-2026-09-28.md) is active: wider reading space, pinned latest user message, compact growing input, separate send/steer and queue icons, and sidebar settings/device controls.

The [CSG Windows discovery repair](cursor-windows-2026-09-28.md) adds the missing Windows-hosted conversations through the existing dev tunnel. The WSL source remains separately labelled. The repair includes pending-subagent activity and saved database tool details.

The [PWA iteration](pwa-2026-09-28.md) is now active at the same address, with home-screen icons, installation guidance, offline reconnect and opt-in app updates. Finish any draft before reloading to receive it. Phone installation and browser behavior tests were not run.

The subsequent [Cursor feedback repair](cursor-feedback-2026-09-28.md) is now active: clean titles, readable tool details, live hook updates and a visible working indicator/Jump to latest control. The user reported failures, authorizing 13 focused regression tests and verification in their open browser. Broader tests remain deferred.

On 2026-09-28 the user requested startup on the Mac mini for Cursor conversation work. Main at `8075c8e` is now running from an independent copy with the existing pilot data home and tailnet address. Its configured CSG reader reaches the existing tunnel through Dev Madrid and observed two recent conversations without unavailable sources. Loopback health, tailnet health and the exact served application returned successfully. These are installation observations; no session, browser or automated behavior tests were run. See [Cursor iteration evidence](cursor-conversations-2026-09-28.md).

## Earlier pilot history

The repaired pilot was deployed at 19:50 UTC, with the follow-up read-only handoff fix activated at 20:10 UTC and the final stretch-context fix deployed after the live conversation reached Done. Preservation checks passed for all accounts, authentication data, projects and existing conversation ledgers. The user-configured Jev and Claude accounts are available. “Todo app” is registered as a separate project, and the new-conversation screen also exposes Add project and a folder picker.

The pilot includes the Claude sign-in recovery fix, working tool discovery, an indexed activity observer, actual execution-stage feedback, compact composer controls and grouped tool activity. See [the workflow repair report](workflow-repair-2026-09-25.md) and [login evidence](login-recovery-2026-09-25.md).

The real “Todo app · live workflow check” conversation reached **Done**. Using the configured accounts, Jev selected implementation and review, Claude submitted accepted handoffs, and Jev selected Done. Jevellan's own `node --test` gate passed **17/17**, with stable HEAD and file contents. Open that conversation, then **Changes → Read output**, to inspect the receipt. Earlier failed stretches remain visible. The live check found and repaired native read-only handoff approval and missing stretch-number context; see the workflow report for the sequence and evidence limits.

## Verification and publication

The deployed source passed typecheck, lint, production build, 79 final focused backend checks and 16 earlier responsive browser checks. Its application source exactly matches the committed source. The earlier full phase-5 browser matrix passed 116 checks. The full backend run had 973 passes, three test-boundary failures and one missing-key skip; affected cases passed after fixture corrections, but no replacement full-suite pass or final acceptance is claimed.

The completed pilot and repairs are committed as `3d1c3fb` and pushed to public `gongiskhan/jevellan`. Worktree and pre-push secret scans passed. Complete repository visibility snapshots were saved outside the checkout before creation and after the first push: all 207 existing repositories are unchanged, and the only addition is public Jevellan. Browser authentication and existing SSH authentication were used; the expired gh API login was not changed.

## Running copy and deferred work

The app runs independently of the checkout from `~/.jevellan-build/pilot-conversation-parity-2026-09-29/app`, with isolated state in `~/.jevellan-build/pilot-2026-09-25/home`. The dedicated Codex home was moved, never copied, into this home. The pilot listens on loopback port 9773 and the existing Tailscale HTTPS route at 9444. This detached process has no persistent OS service, so automatic startup after reboot is not configured.

The current copy includes main through `8075c8e`, including the work published from the other machine and the focused Cursor conversation changes. The earlier deployment exclusions in the [2026-09-26 handoff notes](machine-handoff-2026-09-26.md) describe that historical copy. This activation adds no new main-feature work or acceptance claim. The explicit native-home exception remains limited to the approved Jevellan Cursor hook entries.
