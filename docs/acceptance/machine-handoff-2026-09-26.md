# Machine handoff — 2026-09-26

The user requested committing and pushing all remaining project work to continue development on another machine. This checkpoint includes the unfinished phase-6 implementation, its tests and evidence, and the existing fixture screenshots. No deployment or further implementation is part of this checkpoint.

## Continue development

Clone `git@github.com:gongiskhan/jevellan.git` and use `main`, or run `git pull --ff-only` in an existing clean checkout. Use a Node version accepted by `package.json`, run `npm ci`, then `npm run build`. Start with [the acceptance report](REPORT.md), [phase-6 routing](phase6-routing.md), [J10](J10.md), [J12](J12.md) and `roadmap.json` for the unfinished work.

`BRIEF.md` remains deliberately untracked under AGENTS.md; transfer it separately before further implementation. Local `.env` files, credentials, authentication homes and pilot runtime state are also excluded. This Git checkpoint transfers development work, not the live installation or its accounts. Configure any required credentials through the documented isolated setup on the other machine.

The running pilot still uses the phase-5 release plus repairs, most recently Git settings at `0248a0b`. The incomplete improver is now in the development checkout on main, but was not deployed to the pilot. No phase-6 completion or user acceptance is claimed.

## Verification for this checkpoint

- **Local:** `npm run typecheck`, `npm run lint` and `npm run build` passed. Vite reported a bundle-size warning; the build succeeded.
- **Simulated providers / local persistence:** 51 focused improver tests passed across configuration, evaluation, job claims, routing and suggestion storage in six files.
- **Browser fixtures:** the Git settings save/reload/connection flow passed in all four desktop/phone and light/dark layouts against the combined checkpoint. These checks do not verify the unfinished improver UI or constitute J10/J12 acceptance.
- **Local:** the worktree secret scan passed. The eight existing changed screenshots were inspected and show test fixtures with masked credentials. Publication also requires the repository's pre-push secret scan.
- **Not run:** a new full backend/browser matrix, live improver provider calls, J10/J12 and the deferred final review. Historical broader results remain in the linked reports.
