# Mesh preparation — 2026-09-24

**Read-only preparation. No mesh implementation or cross-device pass is claimed.** This was recorded while the sequential phase 3 verification ran.

## Required behavior

- The hub owns configuration, accounts/statuses, project mappings, conversation/decision/correction indexes, device registration, credentials and shared checkout/publication claims. Member requests use device bearer tokens.
- Join uses an eight-character, ten-minute code. The member stores its resulting token at `device.token` with mode 0600. Every persisted and received envelope needs a versioned schema.
- Heartbeats run every thirty seconds. Status is online below ninety seconds, stale below ten minutes and offline afterwards. Include project Git state, running conversations, external-session metadata and load.
- Conversations remain on their creation device. The aggregate list and owner proxy expose those conversations and streams on any member. Starting work must validate this device's project path and allowed-device policy.
- Device switching exchanges a target-bound, single-use, sixty-second token for the target's UI cookie and preserves a validated local route. Both the header and Devices page use the same operation.
- Per-device logins can be driven from another device's Settings grid. Codex subscription credentials remain per device; no shared-refresh implementation belongs in this phase.
- Read-only native session sensors report runtime, cwd and activity; exclude Jevellan's own isolated homes. External activity must block new writing stretches and prevent automatic checkpoint/publication if it begins during one.
- Hub failure leaves an already-launched stretch running, then waits before effects requiring the hub. No offline credential cache beyond the active launch. Settings/new work/login cannot manufacture success during an outage.
- Keep automatic placement disabled and visible. Bind loopback and the Tailscale IPv4 address when present; service installation and offering HTTPS remain installation work.

## Existing seams

`packages/mesh` currently contains the hub SQLite store and single-device UI authentication. `HubDatabase` explicitly refuses member mode. Application construction directly wires that store, its vault and configuration into accounts, rigging, decisions and conversations. This must be addressed before constructing a real member; merely adding devices to the UI would not satisfy the brief.

`DocumentStore` is synchronous, while a member's authoritative hub access is remote. The implementation needs an explicit boundary between local conversation history/materialized configuration and hub mutations/launch prerequisites. Any materialized non-secret state must retain revision and reachability semantics; it must not make unavailable hub-dependent actions appear successful. Checkout ownership, publication, credential fetch and index updates need integration tests at their actual call sites.

The existing conversation HTTP/SSE handlers and browser authentication provide the local behavior to preserve. The proxy needs to retain event identifiers, stream incrementally, propagate caller cancellation, and avoid treating an ordinary quiet stream as failed. File-evidence and correction routes require the same owner lookup as the timeline.

## Reference preparation

Read-only reference paths under `~/dev/garrison`:

| Source inspected | Regression or adaptation |
| --- | --- |
| `src/lib/mesh/staleness.ts` | Missing/invalid timestamps never imply freshness; stale data overrides a healthy claim. Replace its thresholds/vocabulary with Jevellan's exact ninety-second/ten-minute rules. |
| `src/lib/mesh/peer-proxy.ts` route/timeout definitions | Preserve bounded route matching and a connection-only deadline for SSE. Jevellan adds the required member-token authentication and its own conversation routes; do not import the broad historical endpoint table. |
| `tests/node-switch.test.ts` | Preserve current route, normalize origins and distinguish ports; validate paths before constructing switch navigation. Jevellan additionally requires target-bound, expiring, one-use token tests. |
| `tests/mesh-self.test.ts` case inventory | Missing heartbeat, freshness precedence, actual configured URL and porcelain-v2 project state. Read applicable cases in full before porting. |
| `tests/mesh-proxy.test.ts` case inventory | Incremental SSE, unavailable peer, caller disconnect, wrong method/unknown owner and bounded request bodies. Read applicable cases in full before porting. |
| `tests/talk-mesh-sessions.test.ts` case inventory | Failed refresh preserves original activity age; a recovered empty result replaces old sessions; local results survive authority failure. Read applicable cases in full before porting. |
| `fittings/seed/remote-shell-runtime/lib/session-index.mjs`, `listers/{claude,codex,cursor,gemini,common}.mjs` | Located for the sensor port. Read-only metadata extraction, deduplication and activity freshness; terminal control and transcript export remain excluded. |

No source repository, native home, service or Tailscale route changed during this preparation. The source's `remote-shell-runtime/tests` directory does not exist; the relevant regression inventory is under its top-level `tests` directory.

### Follow-up source reading during joined-application verification

The complete session-index, Claude, Codex, Cursor, Gemini and common lister modules have now been read, along with the underlying Claude session/path readers, heartbeat round-trip/pump tests, Git status parser/tests and applicable Claude/Codex/Cursor discovery test bodies. This is preparation for the next implementation, not sensor or heartbeat acceptance.

- Native journals must be read in bounded slices and normalized to runtime, cwd, activity and source metadata. Do not carry prompts, transcript contents, titles or native identifiers into heartbeat documents.
- Codex discovery uses the first `session_meta` record for identity/cwd, including an old creation directory whose journal was modified recently. It skips subagent rows and deduplicates overlapping roots. Title databases and native resume behavior are outside this sensor's scope.
- Claude discovery combines live registry and project journals; native print clients may have no registry entry. Its reader checks process liveness, boot age and process start time before trusting a registry row. Journal recency uses file modification time, not the parent directory's time; scan limits must be explicit.
- Cursor's lossy project-directory slug is insufficient proof of cwd. Prefer metadata and avoid assigning an ambiguous path. Metadata-only sessions and temporary read failures need coverage; cached activity must retain its original timestamp and a successful empty result must clear it.
- Gemini's project mapping and first chat header provide an inexpensive metadata path without CLI calls. No resume ordering or prompt-derived titles are needed.
- The heartbeat pump must tolerate a failed report without disturbing execution. Git state reads use porcelain v2 with branch data and no fetch. Ahead/behind describe the locally known upstream.

The source tests also preserve an unrelated native session in the same cwd as an owned session. Exclusion must use isolated homes or proven identity, not simply the project's path. Jevellan's activity-window guard follows the brief; the source's working/idle heuristics are not a substitute for that contract. Hook status, terminal ownership, attachment, title lookup and resume behavior remain outside the port. Additional test bodies should be read with each behavior actually adapted.

The subsequent [presence checkpoint](phase4-presence.md) records the implemented metadata readers, heartbeat pump and focused activity-guard/browser evidence. The preparation above remains the source-reading record, not a substitute for that verification.

## Evidence still required

J8 uses two isolated local daemons and separate sandbox checkouts when a second live device is unavailable. It must exercise join, switching without another login, owner execution/proxy streaming and correction, remote per-device login via the documented simulated approval, the disabled placement option and a synthetic external journal. J11 adds repository-travelled memory/context behavior between those checkouts. Label the daemons and journal as simulated, keep any real runtime/provider evidence separately labelled, and record outage/recovery assertions rather than only a happy-path screenshot.
