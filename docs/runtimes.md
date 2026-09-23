# Runtimes

Runtime packages are the only plugin type. They provide createRuntime(ctx), the versioned adapter contract, declared capabilities, account login/probes, model discovery and isolated launches. The contract implementation is in progress.

## Phase 0 transport checks

| Requirement | Claude Agent SDK | Codex SDK |
| --- | --- | --- |
| Clean interruption | Not run: Claude test credential missing | Live SDK passed: running shell turn aborted; continuation succeeded |
| Streamed text/tools and usage | Not run: Claude test credential missing | Live SDK passed |
| Continue the same session for repair | Not run: Claude test credential missing | Live SDK passed with prior-turn context |
| Concurrent per-launch bridge/memory isolation | Not run: Claude test credential missing | Live SDK with fixture MCP passed: two projects, one account, distinct scoped responses |
| Enforced read-only actions | Not run: Claude test credential missing | Installed native runtime command test passed: exit 1, write denied, no file created; model-driven attempt declined before the tool and is not enforcement evidence |
| Safety command denials | Pending protocol/unit checks; live blocked | Pending spike |
| Complete process-group termination | Shared process-group primitive passed locally; full live adapter blocked | Shared primitive passed with a shell descendant ignoring SIGTERM; full adapter contract pending |

The Codex SDK remains the selected execution transport because points 1–4 passed. The read-only control was tested directly through the installed native app-server's command endpoint, without a model or authentication; this is a control probe, not a second stretch transport. Safety and full adapter integration remain unfinished.

Runnable probes are in `scripts/spikes/`. They require an explicit isolated home and report booleans and event types, never credentials, output text or native session identifiers. The concurrent probe uses a fixture memory tool; the real Basic Memory bridge will need its own tests. Basic Memory 0.22.1 separately passed configuration-home and project-constraint checks. Codex per-launch MCP configuration must use `default_tools_approval_mode = "approve"` for the Jevellan bridge with `approvalPolicy = "never"`; `auto` blocked the first two fixture attempts. Only this scoped bridge is pre-approved.

Official references: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex app-server](https://learn.chatgpt.com/docs/app-server). Installed package declarations and transport tests will establish the exact supported surface.

## Enforcement

Writing processes must use their own process group and a minimal environment. Per-launch MCP configuration must never enter the shared account home. Read-only actions must be refused when the adapter cannot enforce their permissions. Safety denies obvious destructive and daemon-control commands; after-stretch git checks detect other changes. Neither is described as a general sandbox.

## Subscription authentication

Claude uses a user-supplied long-lived token or API key. Technical compatibility is not provider approval. Jevellan has no approval to offer Claude subscription logins; the README and UI must say so. Codex subscription authentication remains per device because refresh tokens rotate. Never copy a refreshable authentication file.

## Third-party runtime sketch

An OpenCode package would declare its id, display name and entry in package.json under jevellan.runtime, implement the same adapter, and run the published contract suite. Unsupported permission, isolation or interruption behavior must be reported explicitly rather than advertised as working. No OpenCode implementation ships in v1.
