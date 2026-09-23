# Jevellan

**Autonomous development, coordinated.**

Jevellan runs coding agents in conversations across your runtimes, accounts and machines. Work proceeds in bounded stretches, with structured handoffs. Jev chooses the next action, model and effort; you can correct a decision afterwards, with or without undoing the work.

This repository is under active development. See [the acceptance report](docs/acceptance/REPORT.md) for what is built, tested and still blocked. The complete product is not ready to install yet.

## Install

The intended installation command, once the repository and installer are ready, is:

```sh
npx github:gongiskhan/jevellan install
```

Development needs Node 22 or newer:

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

## The fleet

In 1519 Fernão de Magalhães set out with five ships. A light on the flagship and a small set of lantern signals helped keep the fleet together at night. Jevellan takes its name from Jev and Magellan: coordinated signals for agents doing autonomous work.

In this metaphor, a conversation is a voyage, a stretch is a watch, and a handoff is the change of watch. Devices are ships, the hub is the flagship, decisions are signals, accounts are provisions, and done is landfall. Product controls use plain development vocabulary.

## Accounts

Jevellan uses the accounts you give it. Anthropic's terms restrict third-party tools from offering Claude subscription logins without their approval; Jevellan has no such approval, and using your own subscription token is your decision. API keys are always supported by the design; the account implementation is in progress.

## What is enforced

The build installs a pre-push scan for token patterns and test-secret values in git history. Runtime protections are not yet proven. [Runtime documentation](docs/runtimes.md) records each transport check and will distinguish enforced restrictions from changes detected after execution. Safety command checks are not an operating-system sandbox.

[Website coming soon](https://jevellan.build).

MIT licensed. Extracted from Garrison; see [NOTICE](NOTICE).
