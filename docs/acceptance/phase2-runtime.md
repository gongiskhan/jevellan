# Phase 2 stretch execution and scoped bridge

Date: 2026-09-24. Component evidence; no complete acceptance journey is claimed.

## Local process and bridge tests

`tests/daemon-ownership.test.ts` uses real child processes to prove exclusive data-home ownership, recovery after exit, rejection of a live second owner and protection from a stale instance releasing its replacement.

`tests/stretch-execution.test.ts` uses a scripted FakeRuntime with real owned processes. It covers unchanged native handoffs, preservation of output, one same-session repair, a fresh read-only repair with ledger context when continuation is unsupported, failed repair, correction, cancellation, an in-flight partial handoff after cancellation, bounded repair timeout and failure to settle when process cleanup fails. The executor leaves checkpointing and stretch-end recording to the owner loop, which is now connected as recorded in [the manual loop evidence](phase2-loop.md).

`tests/stretch-bridge.test.ts` exercises the actual `jevellan mcp-bridge` command with the installed MCP SDK over stdio and the actual authenticated local HTTP endpoint. Two simultaneous grants have different conversation and project scopes. Tests cover inline result blobs, immutable/idempotent handoffs, token expiry, malformed input, secret redaction, read-only proposal queuing, ownership before memory writes, loss of memory permissions during repair and draining pending writes during shutdown. The memory provider in these tests is simulated; this is not evidence for completed Basic Memory integration.

`tests/runtime-contracts.test.ts` additionally verifies both production adapters through their real SDKs and simulated CLIs. A writing turn has a positive permission control; continuation retains its session and switches to read-only. Claude's callback denies file, shell and memory writes while permitting the handoff tool. Codex's resumed invocation receives the read-only sandbox and disabled network setting.

The latest complete local run passed 221 tests in 24 files, typecheck, lint, build and secret scanning. A later notification regression plus execution tests passed 19 focused tests. The four existing Settings browser workflows also passed again with installed Chrome; this does not cover the future conversation screens or Claude vision checks.

## Live Codex repair permission check

Command:

```sh
node scripts/spikes/codex-adapter.mjs --root ~/.jevellan-build/live-home --account acc_test --mode repair
```

Evidence: **live runtime, dedicated test login, disposable local project**.

- The initial writing turn created a control file successfully.
- The repair continued the same native session and remembered its earlier context.
- A test script actually attempted a file write; the read-only sandbox denied it.
- The forbidden file did not exist afterwards.
- The owned process group was gone before the temporary project was removed.

The first two attempts asked the model to execute the write directly. It declined without a tool call, so those attempts were inconclusive and were not counted as enforcement passes. The final attempt executed the fixture test and observed its permission error. No native session identifier, credential or raw transcript was saved in this evidence.

Live Claude repair remains blocked by the missing dedicated Claude credential. The complete loop, restart recovery, memory backend and conversation UI remain in progress.
