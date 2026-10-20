# Install and run Jevellan

Published platform archives are available in the repository’s releases. Main can contain changes that have not completed their release gate; see the acceptance report for the tested revision, publication, installation and live-check status. Local acceptance uses disposable homes and an owned fake service manager.

## Requirements

- macOS with launchd, or Linux with a systemd user service.
- Node 22.13+ or 23.4+, including later major versions, and npm.
- Git with `merge-tree --write-tree` and `--merge-base` support; the installer checks these capabilities.
- The `claude` and `codex` executables on the service's recorded PATH. Doctor checks both; account sign-in happens later in the UI.
- Tailscale is optional for local use and required for the private device mesh and optional HTTPS route.

Jevellan installs its own Basic Memory environment and installs pinned APM when needed. Its private tools use uv, Python 3.12, APM 0.10.0 and Basic Memory 0.22.1. It does not modify the user's native agent homes, Basic Memory configuration, shell profiles or logins.

## First device

To install from main:

```sh
npx github:gongiskhan/jevellan install
```

Installation copies the application to `~/.jevellan/app/{version}/`, records its resources in `~/.jevellan/install.json`, chooses a free port starting at 9771, registers a user service and prints the URL. It never stops another listener. The installed service uses its own application copy rather than the development checkout.

The macOS service is `dev.jevellan.daemon`; the Linux user unit is `jevellan.service`. A `jevellan` command is written to an available user bin directory (`~/.local/bin` or `~/bin`). If that directory is not on PATH, or another command takes precedence, installation prints the full command path. Use that path in place of `jevellan` below.

First installation offers Tailscale HTTPS when available. Scripts can choose `--https` or `--no-https`. Jevellan records a private proxy on a separate unused port, preserves existing routes and removes only its own route during uninstall. It does not enable a public Funnel. An existing member retains its registered address; changing an HTTP member to HTTPS is not currently supported.

Open the printed URL and set the shared passphrase. The setup guide then has four steps:

1. Add the Jev key, or choose **Skip for now** to select conversation steps yourself. **Test connection** shows returned models and elapsed time.
2. Add an account and finish its login or API-key check until it is **Ready**. API keys require an explicit paid-use choice.
3. Add the path of a checked-out project on this device, its Git policy and its test command.
4. Describe the work and start a conversation.

The current step is in the page address and survives a reload. **Back** returns to an earlier step without deleting saved configuration. Starting a conversation waits for a newly added project's instruction-file setup to finish; an unfinished change is shown for attention in **Settings → Projects → Context**. **Settings → About → Open setup guide** opens the guide again. Account credentials stay in Jevellan's encrypted vault and isolated runtime authentication files.

## Another device

On the hub, open **Settings → Devices → Add a device** and copy the displayed command. Run it on the other device, replacing these placeholders with that invitation:

```sh
npx github:gongiskhan/jevellan join HUB_URL JOIN_CODE
```

The equivalent form is:

```sh
npx github:gongiskhan/jevellan install --join HUB_URL JOIN_CODE
```

Choose HTTPS during that first join if desired. The member uses the hub's passphrase and shared configuration; Codex subscription login is per device. Never copy a rotating native authentication file between devices. Use Settings to add the project's checkout path on each device before running work there.

## New hub or new machine

A hub keeps nothing that needs migrating. Project memory, project definitions and coordinator notebooks live in the owner's private `jevellan-vault` repository on GitHub, one folder per project origin (`projects/<owner>__<repo>/`). To start a hub on another machine:

1. Install with a fresh data home, for example `JEVELLAN_HOME=$HOME/.jevellan-hub node bin/jevellan.mjs install --from "$PWD" --https`.
2. In Settings, add the credentials: the GitHub token (Settings → Git), the Jev key and the accounts.
3. Add each project with its GitHub origin. When the vault holds that origin, the form offers **Restore from the vault**, checked by default: settings, goals, jobs, dailies, the notebook and project memory come back, and this device becomes the project's only allowed device.

Members re-join the new hub from a fresh home with a join code. Settings → Projects shows the vault's remote, its last sync and its last error. The vault is named after the account of the GitHub token (`<login>/jevellan-vault`); `JEVELLAN_VAULT_REMOTE=owner/repo` overrides it.

## Diagnostics, updates and removal

Other agents can connect through **Settings → Agents** and the HTTP MCP endpoint, or use `jevellan mcp-server` for a local-command client. Named connections have project scope, expiry and revocation. See [the MCP guide](mcp.md) for configuration, tools and resumable output.

```sh
jevellan doctor
jevellan update
jevellan rollback
jevellan uninstall
jevellan uninstall --purge
```

Doctor prints ten checks: Node, Git, APM, Basic Memory, Claude, Codex, daemon, hub, accounts and Jev. Missing setup is reported as missing, never as a pass. A non-OK result exits with status 1. Version probes use a disposable home; daemon checks use its private loopback control endpoint and do not start another daemon.

Update prepares the next version alongside the running one. It reports “Waiting for {n} running conversations to finish” and switches only after admitted work finishes. Rollback selects the preceding recorded version. Before reverting across changed document formats, preserve current work and restore compatible cold state as documented in that release’s handoff; retaining an older binary alone does not establish data-format compatibility. Agents cannot run daemon-control operations themselves.

Uninstall refuses while conversations are running and lists the work. Once idle, it removes its recorded service, command, applications and owned installation resources, retaining application data. Purge additionally asks you to type the exact Jevellan data-home path before removing that home. Neither removes project repositories, repository memory, native agent homes or unrelated services and commands. An externally changed installation resource is preserved and reported for attention rather than overwritten.

## Local builds and acceptance

For a development checkout:

```sh
npm install
npm run build
node bin/jevellan.mjs install --from /absolute/path/to/jevellan
```

`--from` accepts a local checkout or a packed archive; it still installs an independent copy. Tests use `npm pack` and a temporary HOME, with a fake service manager controlling only owned child processes. A temporary HOME alone does not isolate the operating system's service manager.

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- --project installation
```

The packed test covers the guided browser setup, optional key path, all-green diagnostics with simulated providers, real conversation completion and Git publication, update waiting, rollback, uninstall, purge, and exact preservation of native fixture trees. Dedicated live-provider and actual second-machine checks remain separate; see [J9](acceptance/J9.md) and the [acceptance report](acceptance/REPORT.md).


A second independent installation can use an explicit name, for example `JEVELLAN_HOME=/separate/home jevellan install --name member --from archive.tgz`. It owns `jevellan-member.service` on Linux (or `dev.jevellan.member.daemon` on macOS) and the `jevellan-member` CLI, preserving the default hub service and command. The name is bound to that installation and reused by update, rollback and uninstall. An existing managed installation cannot be renamed. An old unmanaged member requires a cold data/unit backup and verified removal of only its old unit before named installation; never claim a different installation's service.
