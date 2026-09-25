# Jevellan

**Autonomous development, coordinated.**

Jevellan runs coding agents in conversations across your runtimes, accounts and machines. Work proceeds in bounded stretches, with structured handoffs. Jev chooses the next action, model and effort; you can correct a decision afterwards, with or without undoing the work.

This repository is under active development. See [the acceptance report](docs/acceptance/REPORT.md) for what is built, tested and still blocked. The complete product is not ready to install yet.

## Install

The installation command, once the repository is published, is:

```sh
npx github:gongiskhan/jevellan install
```

Installation also creates a `jevellan` command in `~/.local/bin` or `~/bin`. If its folder is already on PATH, use `jevellan doctor`, `jevellan update`, `jevellan rollback` and `jevellan uninstall`. Otherwise the installer prints its full path. Shell profiles are never changed. Updates keep the previous installed version; uninstall keeps the data unless you choose `--purge` and confirm its path.

First installation offers Tailscale HTTPS when available. Use `--https` or `--no-https` to choose explicitly in a script. Jevellan records its private route on an unused port and removes that route on uninstall. Choose HTTPS when first joining a member; changing an already registered member's address is not supported.

The UI guides first setup through a Jev key (optional), an account, a project and a conversation. See [installation instructions](docs/install.md) for local builds, joining another device, diagnostics and removal.

Development needs Node 22.13+ or 23.4+ (including newer major versions), with built-in SQLite:

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

Browser tests can use an installed Google Chrome with `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`; otherwise they require the Playwright Chromium browser.

Read [architecture](docs/architecture.md), [decisions](docs/decisions.md), [device mesh](docs/mesh.md) and [project memory](docs/memory.md) for the implementation boundaries and recorded limitations.

## The fleet

In 1519 Fernão de Magalhães (Magellan) set out with five ships. To keep them together at night, his flagship burned a light called the farol, and a small set of lantern signals told every ship when to turn, change course or shorten sail, as described in Pigafetta's account. Jevellan does the same for your agents. The name is Jev plus Magellan.

In this metaphor, a conversation is a voyage, a stretch is a watch, and a handoff is the change of watch. Devices are ships, the hub is the flagship, decisions are signals, accounts are provisions, and done is landfall. Product controls use plain development vocabulary.

## Accounts

Jevellan uses the accounts you give it. Anthropic's terms restrict third-party tools from offering Claude subscription logins without their approval; Jevellan has no such approval, and using your own subscription token is your decision. API keys are always supported. API-key accounts require an explicit paid-use policy. Live Claude validation remains blocked by a missing dedicated test token.

## What is enforced

The build installs a pre-push scan for token patterns and test-secret values in Git history. Codex uses native read-only controls and a per-launch command guard, with live control evidence; Claude permission wiring has simulated SDK evidence, with live checks still blocked. [Runtime documentation](docs/runtimes.md) records the proof and limits. Command hooks are not a general operating-system sandbox.

The conversation loop checks Git state after every stretch, requires review of unexplained changes and independently verifies checkpoints before publication. Ownership prevents two conversations from writing the same checkout. Closing work supports publication, retained changes and discard with saved recovery refs. Corrections support undo and redo, including already-published work, with durable history and explicit recovery after interruption. Memory and project-context changes use the same ownership and publication rules. Network outages, external edits and provider failures remain visible in the UI; the acceptance report separates local simulations from live evidence.

[Website](https://gongiskhan.github.io/jevellan/) · [Português](https://gongiskhan.github.io/jevellan/pt/).

MIT licensed. Extracted from Garrison; see [NOTICE](NOTICE).
