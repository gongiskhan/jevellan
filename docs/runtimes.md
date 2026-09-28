# Runtimes

Runtime packages are the only plugin type. They provide createRuntime(ctx), the versioned adapter contract, declared capabilities, account login/probes, model discovery and isolated launches. Both built-in factories are implemented. The exported contract runner is available from `@jevellan/runtime-contract/testing`; its seven-part built-in matrix passes with real SDKs and simulated provider CLIs. Live checks are labelled separately. See the [phase 1 evidence](acceptance/phase1-runtime.md) for current production-adapter checks.

## Phase 0 transport checks

| Requirement | Claude Agent SDK | Codex SDK |
| --- | --- | --- |
| Clean interruption | Not run: Claude test credential missing | Live SDK passed: running shell turn aborted; continuation succeeded |
| Streamed text/tools and usage | Not run: Claude test credential missing | Live SDK passed |
| Continue the same session for repair | Not run: Claude test credential missing | Live SDK passed with prior-turn context |
| Concurrent per-launch bridge/memory isolation | Not run: Claude test credential missing | Live SDK with fixture MCP passed: two projects, one account, distinct scoped responses |
| Enforced read-only actions | Not run: Claude test credential missing | Installed native runtime command test passed: exit 1, write denied, no file created; model-driven attempt declined before the tool and is not enforcement evidence |
| Safety command denials | Hook fixture checks pass for ordinary forms; live blocked | Installed parser denies 19 exact prefixes; four reordered/prefixed variants bypass those rules; live model declined before a tool call |
| Complete process-group termination | Shared process-group primitive passed locally; full live adapter blocked | Shared primitive passed with a shell descendant ignoring SIGTERM; full adapter contract pending |

The table records the original phase 0 results. The Codex SDK remains the selected execution transport because points 1–4 passed. The read-only control was tested directly through the installed native app-server's command endpoint, without a model or authentication; this is a control probe, not a second stretch transport. Phase 1 additionally passed live production-adapter continuation, interruption, scoped concurrent MCP calls, Safety denial and descendant cleanup. The wrapper tracks ancestry before stopping and checks start identities, covering observed children that launch new process groups. Interruption finishes descendant cleanup before allowing continuation. Arbitrary children already reparented before observation are not claimed covered.

Runnable probes are in `scripts/spikes/`. They require an explicit isolated home and report booleans and event types, never credentials, output text or native session identifiers. The concurrent probe uses a fixture memory tool; the real Basic Memory bridge will need its own tests. Basic Memory 0.22.1 separately passed configuration-home and project-constraint checks. Codex per-launch MCP configuration must use `default_tools_approval_mode = "approve"` for the Jevellan bridge with `approvalPolicy = "never"`; `auto` blocked the first two fixture attempts. Only this scoped bridge is pre-approved.

Official references: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex app-server](https://learn.chatgpt.com/docs/app-server). Installed package declarations and transport tests will establish the exact supported surface.

## Enforcement

Writing processes must use their own process group and a minimal environment. Per-launch MCP configuration must never enter the shared account home. Read-only actions must be refused when the adapter cannot enforce their permissions. Safety denies obvious destructive and daemon-control commands; after-stretch git checks detect other changes. Neither is described as a general sandbox.

The Claude hook uses PreToolUse denials, including in bypass mode, as specified by the [SDK permission order](https://code.claude.com/docs/en/agent-sdk/permissions). Its read-only policy denies every shell and editing tool, and allows only named read tools and the scoped bridge; explicit remembering can allow memory tools independently. This callback is tested locally, but end-to-end enforcement is blocked by the missing Claude credential.

Project memory adds stable PreCompact, Stop and SessionEnd commands through APM into each isolated account. The commands queue owner-derived metadata with the launch's scoped token, return empty JSON and have a bounded two-second input/request deadline. Account hooks coexist with the per-launch Safety callback/configuration. Both actual SDKs exercise this through simulated provider CLIs, and installed Codex discovers the three account events alongside per-launch hooks without loading untrusted project hooks. Native lifecycle dispatch remains a separate live-journey check; see [hook evidence](acceptance/phase2-hooks.md).

The installed Codex [rules language](https://learn.chatgpt.com/docs/agent-configuration/rules) matches literal argument prefixes. The phase 0 probe missed four common reordered forms. The production adapter now supplies the same command guard through a per-launch PreToolUse hook. A CLI shim supplies the [documented hook automation flag](https://learn.chatgpt.com/docs/hooks); the SDK still controls execution, continuation and sandbox permissions. Project configuration is marked untrusted, while account Rigging remains available. A live inert `git -C <project> push` attempt received the hook's denial and did not execute. The executable hook tests include the integration-only rebase exception. Native config and live project probes now confirm project-hook exclusion. Jevellan supplies the root AGENTS.md explicitly on the first Codex turn because the untrusted project layer prevented its native loading. Context is limited to 32 KiB and links must resolve inside the project. Hooks are not a general sandbox: arbitrary programs, native tool paths outside the matcher, and native hook startup failures remain limitations. Direct git-state changes must be checked after each stretch regardless of runtime.

### Codex sandbox on Linux

Codex runs every read-only and workspace-write shell command inside bubblewrap. Ubuntu 24.04 and later set `kernel.apparmor_restrict_unprivileged_userns=1`, which stops bubblewrap from creating the user namespace it needs ("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"). The Codex adapter runs `codex sandbox -- true` once at startup. When the sandbox cannot start, Codex declares no read-only or shell capability, model selection stops offering it, and the Codex account in Settings → Runtimes shows the reason. There is deliberately no fallback to running without a sandbox.

To allow it on such a host, add an AppArmor profile that grants user namespaces to bubblewrap only. Codex uses `/usr/bin/bwrap` when it exists and its bundled `codex-resources/bwrap` otherwise, so the profile covers both:

```
abi <abi/4.0>,
include <tunables/global>

profile codex-bwrap /{usr/bin/bwrap,home/*/**/codex-resources/bwrap} flags=(unconfined) {
  userns,

  include if exists <local/codex-bwrap>
}
```

Install it as `/etc/apparmor.d/codex-bwrap`, load it with `sudo apparmor_parser -r /etc/apparmor.d/codex-bwrap`, then restart Jevellan. Setting `kernel.apparmor_restrict_unprivileged_userns=0` also works but weakens the host for every program.

## Subscription authentication

Claude uses a user-supplied long-lived token or API key. Technical compatibility is not provider approval. Jevellan has no approval to offer Claude subscription logins; the README and UI must say so. Codex subscription authentication remains per device because refresh tokens rotate. Never copy a refreshable authentication file.

## Writing a runtime package

An ESM package exposes its factory through metadata in `package.json`:

```json
{
  "name": "jevellan-runtime-opencode",
  "type": "module",
  "jevellan": {
    "runtime": {
      "id": "opencode",
      "displayName": "OpenCode",
      "entry": "./dist/index.js"
    }
  }
}
```

The entry exports `createRuntime(context: RuntimeContext): RuntimeAdapter`. The authoritative interface and versioned launch/worker schemas are in `packages/runtime-contract/src/contract.ts`. The current daemon registers the two built-in factories in its application composition; adding package metadata alone does not make an unregistered runtime appear in Settings. A new adapter must be included in that runtime map and configuration for an application build, or supplied through the application factory hook in an isolated integration test. No OpenCode adapter ships in v1.

Implement these boundaries:

| Method or declaration | Required behavior |
| --- | --- |
| Identity, account/Rigging kinds, capabilities | Report only supported behavior. A launch that cannot honor declared permissions or isolation must fail before work begins. |
| `listModels` | Use the resolved account to return exact available model identifiers and supported efforts. Do not enable guessed models. |
| `beginLogin` | Run inside the supplied Jevellan account home; return instructions, polling and cancellation, plus code submission when needed. Credential capture uses the supplied secret-saving callback. |
| `probe` | Report authentication, identity and usage without returning the credential. Distinguish missing/expired authentication from an unrelated provider failure. |
| `materialiseRigging` | Materialize stable skills/tools/hooks/rules in the isolated account home and report which items applied. Never put stretch-specific tokens or project configuration there. |
| `startStretch` | Validate `stretch-input-v1`, enforce its permissions, start an owned process group and return a `StretchRun`. Adapt provider output to the validated event stream. |

`StretchRun` exposes streaming events, current native process metadata, completion, interruption, same-session continuation and full termination. Completion of one turn must not destroy the session needed for a handoff repair. Termination must resolve only after owned processes are gone. The built-in `WorkerRun`/`serveWorker` pair shows this separation, but its environment and transport choices currently target Claude and Codex; a new adapter needs its own environment and transport mapping.

An OpenCode package can follow this module arrangement without assuming any particular OpenCode SDK method names:

```text
src/index.ts          createRuntime; capabilities and checked account homes
src/auth.ts           isolated login, probe and credential capture
src/models.ts         account-scoped model/effort discovery
src/rigging.ts        stable configuration delivery
src/worker.ts         provider transport, permission controls and event conversion
src/run.ts            process ownership, interruption, repair and termination
tests/contract.ts     seven provider-specific contract drivers
```

Use only the resolved account's authentication and the minimal environment. Supply the bridge, memory permissions, project path, system append and reasoning effort separately for each launch. If the transport cannot isolate simultaneous launches in one account home, declare `perLaunchConfig: false` so the account is serialized. Do not copy rotating authentication files to manufacture isolation. Secrets never belong in process arguments or public test evidence.

## Contract verification

Call `runContractTests(factory, { context, cases })` from `@jevellan/runtime-contract/testing`. Supply a driver for each of `interrupt`, `events-and-usage`, `continue-session`, `concurrent-isolation`, `read-only`, `safety` and `terminate-group`. Every driver declares `live`, `simulated` or `not-run`; the latter needs a reason. Inspect the returned evidence for failed checks: the runner records failures rather than throwing on the first one.

The exported helpers collect validated events, interrupt a running tool, continue the same session, exercise two projects sharing one account home, and check process-group termination. Permission and command-denial drivers must try the native control directly; a model declining to attempt the action is not enforcement evidence. Use dedicated test credentials in disposable Jevellan homes and preserve the user's native homes. See `tests/runtime-contracts.test.ts` for the built-in drivers and `tests/runtime-adapters.test.ts` for lower-level adapter coverage.
