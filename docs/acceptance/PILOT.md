# Pilot handoff · 25 September 2026

The user requested a usable pilot and deferred the remaining build. This is not section-20 completion or user acceptance.

- **App:** https://goncalos-mac-mini-1.tail31efa.ts.net:9444/
- **Source:** https://github.com/gongiskhan/jevellan
- **Earlier recorded screens and Codex demonstration:** https://goncalos-mac-mini-1.tail31efa.ts.net:9443/#screens

## Current pilot

The repaired pilot was deployed at 19:50 UTC, with the follow-up read-only handoff fix activated at 20:10 UTC and the final stretch-context fix deployed after the live conversation reached Done. Preservation checks passed for all accounts, authentication data, projects and existing conversation ledgers. The user-configured Jev and Claude accounts are available. “Todo app” is registered as a separate project, and the new-conversation screen also exposes Add project and a folder picker.

The pilot includes the Claude sign-in recovery fix, working tool discovery, an indexed activity observer, actual execution-stage feedback, compact composer controls and grouped tool activity. See [the workflow repair report](workflow-repair-2026-09-25.md) and [login evidence](login-recovery-2026-09-25.md).

The real “Todo app · live workflow check” conversation reached **Done**. Using the configured accounts, Jev selected implementation and review, Claude submitted accepted handoffs, and Jev selected Done. Jevellan's own `node --test` gate passed **17/17**, with stable HEAD and file contents. Open that conversation, then **Changes → Read output**, to inspect the receipt. Earlier failed stretches remain visible. The live check found and repaired native read-only handoff approval and missing stretch-number context; see the workflow report for the sequence and evidence limits.

## Verification and publication

The deployed source passed typecheck, lint, production build, 79 final focused backend checks and 16 earlier responsive browser checks. Its application source exactly matches the committed source. The earlier full phase-5 browser matrix passed 116 checks. The full backend run had 973 passes, three test-boundary failures and one missing-key skip; affected cases passed after fixture corrections, but no replacement full-suite pass or final acceptance is claimed.

The completed pilot and repairs are committed as `3d1c3fb` and pushed to public `gongiskhan/jevellan`. Worktree and pre-push secret scans passed. Complete repository visibility snapshots were saved outside the checkout before creation and after the first push: all 207 existing repositories are unchanged, and the only addition is public Jevellan. Browser authentication and existing SSH authentication were used; the expired gh API login was not changed.

## Running copy and deferred work

The app runs independently of the checkout from `~/.jevellan-build/pilot-git-fix-2026-09-26/app`, with isolated state in `~/.jevellan-build/pilot-2026-09-25/home`. The dedicated Codex home was moved, never copied, into this home. The pilot listens on loopback port 9773 and the existing Tailscale HTTPS route at 9444. This detached process has no persistent OS service, so automatic startup after reboot is not configured.

Unfinished phase-6 source and evidence are included in the 2026-09-26 machine-handoff checkpoint on main, but remain excluded from the deployed pilot. See [handoff notes](machine-handoff-2026-09-26.md). Suggestion UI, memory/context improver jobs, complete J10/J12 journeys, broader final checks and the final crucial-issues review remain deferred. Garrison and native homes remain protected. The original build goal stays paused.
