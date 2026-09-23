# Jevellan

BRIEF.md is the local specification and stays untracked. Read it completely before implementation. When it is silent, keep the design simple and record the choice in docs/acceptance/REPORT.md.

## Rules

- Work on main only, with no worktrees or feature branches. Commit and push after every phase; update roadmap.json and the acceptance report first.
- Garrison is read-only reference. Never edit, commit, stash, branch or add files there. Port relevant tests with each behavior. Never import it at runtime.
- Never modify the user's native agent homes, Basic Memory, shell profiles or logins. All runtime state belongs to Jevellan's isolated homes.
- Never commit BRIEF.md, CLAUDE.md, .claude/, credentials, native session identifiers or unredacted evidence. Secrets belong in the encrypted hub vault and runtime authentication files only.
- No attribution trailers, generation credits or session links in commits, code or documentation. Use the machine's normal git identity.
- Never change another repository's visibility. Before creating gongiskhan/jevellan, save the owner's repository visibility list outside this checkout; compare after the first push.
- No adversarial or security reviews during the build. One crucial-issues review at the end; a second only if the first finds a serious problem.
- Every stored and received document has a versioned zod schema. TypeScript is strict, ESM, Node 22+, npm workspaces.
- User logins happen in the UI after installation. Never add heuristic routing. Jev decides meaning; code enforces resources and limits.
- Agents never restart, stop, update or redeploy the daemon. The installed daemon runs from its own versioned copy.
- Label evidence live, simulated or not run. Missing credentials are blocked tests, never passes. Do not claim the user's acceptance.

## Architecture in ten lines

1. apps/daemon serves HTTP, SSE and the compiled React application.
2. apps/web provides conversations and Settings on desktop and mobile.
3. packages/core owns schemas, configuration, homes, git policy and locks.
4. packages/conversations owns durable work, briefs, handoffs, ledgers and guards.
5. packages/decisions asks Jev for actions, models and effort, and records corrections.
6. packages/accounts ranks eligible accounts and manages authentication and usage.
7. packages/memory isolates Basic Memory per project behind permissioned bridge tools.
8. packages/mesh owns the hub database, device APIs, routing, tokens and session sensor.
9. packages/runtime-contract defines adapters and their contract tests; runtimes/* implements them.
10. packages/cli installs versioned copies and services, handles join and exposes the MCP bridge.

## Vocabulary

Use configuration, runtime, account, rigging, conversation, stretch, handoff, finding, decision, action, model, effort, work, device, hub, project and guard. Historical source names belong only in reference documentation. The navigation theme belongs only in the README.

## Verification

Run npm run typecheck, npm run lint, npm test and npm run test:e2e. Secret scanning is mandatory before pushes. Runtime contract tests and vision checks require their documented test credentials; never borrow the user's native credentials. Decisions live in packages/decisions; guards live in packages/conversations. Test behavior and regressions, not implementation spelling.
