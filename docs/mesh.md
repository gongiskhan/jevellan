# Device mesh

Both hub and member applications run conversations in their own checkouts. A member uses authenticated hub interfaces for shared sign-in, accounts, checkout ownership, publication leases, slim indexes, configuration, Rigging and projects. Scheduled heartbeats, read-only native-session sensing, conversation owner routing, Settings synchronization, remote login controls and the device UI are connected. Conversation launch, decision preparation, checkpoints, queued memory, publication, settlement, undo, admitted context operations, closing and cancellation cleanup, guard settings and final account reports can wait for a disconnected hub and continue after its next successful heartbeat. Browser requests use the recovery rules below. Phase 4 passed the complete backend and browser suites; J8 and J11 have local simulated-device evidence. Those results do not establish operation on a real second machine or user acceptance.

Hub waits belong to the current daemon. Their versioned ledger evidence records a boundary and its outcome without storing a credential or executable continuation. Restart interrupts the wait and never relaunches the step. A deferred checkpoint rechecks the completed files, Git snapshot and outside activity; later edits require Changes review. See [the wait evidence and remaining boundaries](acceptance/phase4-hub-waits.md).

Memory waits retain their current queue and written-note results. Publication settles a failed lease attempt before obtaining fresh authority, and retries a lost release separately from a successful push. Lease acquisition reconciles a lost reply for the same device/work owner; release reconciles only the exact token, never a newer lease. Closing cleanup can wait without reopening completed work. See [memory and publication recovery](acceptance/phase4-memory-publication-waits.md).

An interrupted integration waits at its abort. A local fingerprint covers files, refs, staged entries and Git's rebase metadata, without contacting the remote. Fresh ownership and outside-activity checks precede comparison and cleanup. Intervening edits leave the pending integration intact; an unchanged abort returns publication to fresh authority and recorded rewrite reconciliation. Restart does not recreate the continuation. See [integration recovery](acceptance/phase4-integration-waits.md).

An admitted Keep, Discard or Publish settlement waits for checkout authority. Discard can resume from its exact saved recovery ref, with fresh guards against changed files, commits or refs. Release after closure waits separately, so lost cleanup replies cannot repeat a reset. A stopped writing runtime gets one guarded checkpoint attempt after termination; cancellation never waits for an offline hub. See [settlement recovery](acceptance/phase4-settlement-waits.md).

An admitted undo waits separately for project and ownership reads, preparation, application and the guards before redo. Recovery retains its exact prepared plan and recognizes a completed Git result without repeating it. Transfer between two works in one conversation never releases the checkout. A newer message, cancellation or restart interrupts the waiting request; outside edits remain protected by the existing Git checks. See [undo recovery](acceptance/phase4-undo-waits.md).

Cancellation closes the work after confirmed process termination. Hub-dependent ownership cleanup can then wait separately, preserving unpublished changes and acknowledging the closed outcome without a shared configuration read. A lost release reconciles only the exact previous owner; repeated Cancel keeps that cleanup pending, while shutdown interrupts it without automatic restart recovery. New requests still require hub authentication before admission. See [cancellation recovery](acceptance/phase4-cancellation-waits.md).

An admitted context operation waits before draft launch and at its project, ownership, metadata and checkpoint boundaries. It preserves already applied files and the exact prepared checkpoint rather than replaying the whole operation. Outside changes require the existing context review; explicit acceptance retains that reviewed plan across a wait. Drafts still require Apply, and restart never recreates the continuation. Unfinished cleanup stays blocked even if the work was already Done, with explicit Retry for that recorded work. See [context recovery](acceptance/phase4-context-waits.md).

## Authority and credentials

The hub's SQLite database owns the device registry, encrypted device tokens, consumed join-code receipts, heartbeat receipts, switch grants, passphrase hash and session revocations. Members use bearer authentication over HTTP and never open that database. Their local daemon-ownership database is only a process lock.

Join codes contain eight characters and expire after ten minutes. A registration commits the new device, its encrypted token and the consumed code in one transaction. An identical request can recover its original token during that interval. Device tokens contain 256 random bits. The database keeps their authentication hashes and encrypted values; revoking a member removes its encrypted token and invalidates its sign-ins and outstanding switches.

A member stores `device.token` and `ui-auth.json` as private authentication files, plus `device.json` and `hub-device.json` as versioned metadata. Each is written with mode 0600. `ui-auth.json` contains the signing key shared at join; it does not contain the passphrase or its hash. Ordinary browser Settings responses contain no credential readback.

## Hub HTTP protocol

Device calls use `/hub/mesh/`. Except for joining, they require `Authorization: Bearer …`. Browser Origin/Fetch Metadata headers are refused on these credential-exchange endpoints. Payloads and replies have versioned zod schemas, JSON bodies are bounded, and responses are not cached. Device clients refuse redirects and validate the expected device identity.

| Method and path | Purpose |
| --- | --- |
| POST `/hub/mesh/join` | Consume a join code; return membership and shared signing material. |
| GET `/hub/mesh/devices` | Read the roster and the requesting device identity. |
| POST `/hub/mesh/heartbeat` | Report only the authenticated device's heartbeat. |
| POST `/hub/mesh/invitations` | Create a join invitation after the hub passphrase exists. |
| GET `/hub/mesh/auth/material` | Recover shared signing material for an authenticated member. |
| POST `/hub/mesh/auth/login` | Validate the hub passphrase and issue a session bound to the requesting member. |
| POST `/hub/mesh/auth/check` | Check signature, device, expiry, generation and hub-held revocation. |
| POST `/hub/mesh/auth/peer-check` | Check a source UI session, both memberships and the receiving device's indexed conversation ownership. |
| POST `/hub/mesh/auth/logout` | Revoke that member's session. |
| POST `/hub/mesh/switch` | Create a sixty-second, target-bound switch grant. |
| POST `/hub/mesh/switch/consume` | Consume the target's grant and issue its session. |
| POST `/hub/mesh/accounts` | Read or change shared account data and exchange the current account-scoped credential. |
| POST `/hub/mesh/checkout` | Read or compare-and-swap a checkout claim for the authenticated device. |
| POST `/hub/mesh/publication` | Acquire, renew, assert or release a publication lease using the hub clock. |
| POST `/hub/mesh/indexes` | Publish owner-bound indexes and read paginated conversation/correction lists. |
| POST `/hub/mesh/state` | Read or revise configuration, projects and rigging; save, remove or summarize the GitHub token; fetch the Jev and GitHub credentials separately. |
| POST `/hub/mesh/projects/<collection>` | Read or revise project work state (`settings`, `coordinators`, `threads`, `decisions`, `notebooks`) with operation bodies that must belong to the collection; lists are filtered by project and paged at 100. |

Browser-authenticated routes on either role expose the roster at `/hub/devices/roster`, create invitations at `/hub/devices/invitations` and create switch grants at `/api/devices/switch`. The `/switch?token=…` handler exchanges a grant for an HttpOnly, SameSite=Strict cookie and redirects with HTTP 303 to its recorded local route. The exchange forbids caching and referrer forwarding. A member uses the authenticated hub client for its exchange. Hub-only `/hub/mesh/` authority endpoints return 404 on members.

The member sign-in client checks the shared signature locally and asks the hub about revocation before accepting a new authenticated request. A transport failure uses the brief's hub-unreachable notice; malformed or mismatched responses are separate protocol errors. An already authorized SSE connection may continue during a network outage while its signature remains valid and unexpired. It checks revocation when connectivity returns and closes on rejection. Asynchronous stream checks are serialized with ledger replay and backpressure.

Shared account operations use a discriminated, versioned request schema. The member's account service runs login, probes, discovery and preparation locally while awaiting authoritative account data from the hub. Credential exchange is an explicit response carrying only the selected account's current shared credential; ordinary account views expose its saved suffix. The client adds delivered credentials to its redactor. There is no authoritative member account database or offline credential fallback.

Replacing a credential atomically changes its encrypted reference, removes the previous secret and invalidates all known device statuses. Status reports include the reference actually used, so an old probe or runtime cannot overwrite the replacement. The bearer identity binds each status to its reporting device. Native per-device authentication remains in its isolated runtime home. See [account evidence](acceptance/phase4-accounts.md) for the implemented boundary and the remaining member integration.

## Configuration and local context

Configuration, rigging and project reads contact the hub before new work; their previous values are not an offline authority. Configuration and project writes use revisions, and held checkouts prevent project settings changes. Jev key delivery is a separate authenticated operation; browser Settings receives masked summaries. Rigging promotion keeps its local source claim while awaiting the hub, so an interrupted successful save can be reconciled by identity. Context drafts remain in owner-local files and migrate without deleting shared originals until all local copies have been saved. See [shared-state evidence](acceptance/phase4-state.md).

The application refetches delayed configuration replies older than a revision it has already materialized. Model discovery refreshes current configuration rather than writing its older response over a newer manifest. Rigging delivery reads current configuration first and saves its application receipt locally. Existing shared receipts migrate only after the local copy has been saved; conflicting copies remain intact. This is operation-time refresh, not periodic synchronization.

A member opens its private registration files and never creates an authoritative hub database. Partial join files prevent accidental initialization as a hub. Local ledgers reopen after restart without launching a second step. Shutdown terminates owned runtime processes even during hub unavailability, retaining unsettled work and pending index delivery for recovery. See [joined application evidence](acceptance/phase4-member.md).

## Checkout ownership and publication

Checkout claims use a device-and-path key and revision checks. The hub binds each request to its authenticated device and timestamps accepted records; the owner keeps the returned claim in its local lock file. Kept or unsettled checkpoints retain ownership. If a successful reply is lost, retry reconciles the exact recorded owner and local file. A later owner's claim cannot be removed by that retry.

Publication operations run on the hub, using its clock for the 120-second lease and 30-second renewal interval. The stored owner includes the authenticated device and work identity. A member's supplied expiry cannot extend a lease. An unavailable hub prevents new claims and publication checks; a failed renewal continues to prevent pushing if connectivity returns during the same attempt. The conversation service accepts these asynchronous interfaces, and member implementation, independent verification and publication have real local Git/HTTP coverage with a simulated runtime. See [coordination evidence](acceptance/phase4-coordination.md) and [joined execution](acceptance/phase4-member.md). Automatic boundary resumption remains unfinished.

## Shared indexes and owner history

The hub stores slim conversation and decision indexes. Full requests, constraints, messages, decision details, probabilities and memory choices stay in the owning device's ledger and projections. Startup migrates earlier full hub documents in one transaction. The conversation-list API uses `conversations-list-v2` and supplies only the fields needed by the shared sidebar. Detailed views and streaming are routed to the owner.

Each published record carries its source ledger event sequence. The hub checks conversation ownership and saves the record with its acknowledgement cursor atomically. Older requests cannot overwrite newer records, identical replay is idempotent, and conflicting content at the same event is refused. Conversation/correction lists use pages of at most one hundred records.

The owner sends indexes asynchronously, coalesces pending updates and retries failed delivery after thirty seconds. Its durable ledger reconstructs undelivered records on restart without relaunching work. A delayed acknowledgement cannot erase a newer pending update. This queue is not an offline read authority: list reads and decision correction queries still contact the hub. See [index evidence](acceptance/phase4-indexes.md).

## Owner routing

Foreign `/api/conversations/:id/*` requests resolve the immutable owner from the hub index and that device's registered URL. The local daemon proxies only the existing conversation detail/control route table to `/api/mesh/owner/:id/*`. The receiving application serves only local history. Creation stays local, a stale owner is refused, and opening or replaying a view never launches work or creates history on the viewer's device.

The source sends its device identity and original source-bound UI session as explicit peer authentication. The receiver validates that session and conversation ownership through the hub; members use their own device token for this check. Ordinary cookies stay device-bound and peer requests cannot set them. Source or target revocation prevents new requests and closes an admitted stream when the hub is reachable. The existing signed-stream outage rule remains limited to previously admitted connections.

Forwarding retains queries, Last-Event-ID, bodies, response status and bytes. It streams with backpressure and closes the upstream reader when the viewer disconnects. Normal requests have a twenty-second deadline; SSE has a 125-second connection deadline that is released once live stream headers arrive. Redirects and upstream Set-Cookie headers are not forwarded. See [owner-routing evidence](acceptance/phase4-owner-routing.md) for actual local transport and three-direction application checks; no live second-machine acceptance is claimed.

## Interrupted registration

`joinMember` reserves the data home with the existing process-ownership lock. It refuses an active daemon home or an existing hub home. `join-pending.json` contains only stable request/device metadata, never the join code. `device.json` is written last as the completed-registration marker.

If the response is lost, retry uses the saved request identity. If the device token was saved before the process stopped, retry uses that token to recover the roster and shared signing material, even when the original code is no longer valid. An expired code with no locally saved token remains an unavailable registration; it does not silently create a different device. Changing the pending device settings is refused. Existing authentication files without a matching registration are preserved.

## Presence and switching

The daemon reports presence after local recovery and every thirty seconds. Each pulse reads registered local checkout state without fetching, the locally running conversation identifiers, system load and metadata from the read-only external-session sensor. Discovery and delivery failures do not stop an executing runtime. Concurrent pulses coalesce, and shutdown drains the current pulse before closing shared services.

Native session discovery excludes Jevellan's isolated runtime homes, maps canonical paths to projects and retains original activity timestamps across a temporary read failure. It does not publish transcript text, titles or native session identifiers. Main-policy conversations block new writing steps on recent external activity and require explicit Changes review if an outside agent becomes active during a step. Context changes have a separate exact diff review, partial queued-memory writes use the durable Changes barrier, and undo/discard/revert publication await fresh activity checks. External-policy Changes records acknowledgement without a Jevellan Git mutation. Settings → Devices displays this activity, online state and running counts; the header switcher opens an online device without another passphrase entry. See [presence evidence](acceptance/phase4-presence.md), [activity boundaries](acceptance/phase4-activity-boundaries.md) and [J8](acceptance/J8.md).

A quiet journal does not make an outside commit part of the work. Main-policy writing, publication and discard compare HEAD with the work's recorded checkpoint/integration/undo/context history. An unexplained commit remains untouched and requires reconciliation. A completed discard with a lost result recovers only from its exact saved ref and clean base. See [recorded-history evidence](acceptance/phase4-checkout-history.md).

The hub timestamps receipt separately from the member's reported clock. Devices are online below ninety seconds, stale below ten minutes and offline afterwards. A malformed, missing or future receipt time never implies online. Last known running conversations and external activity remain attached to the heartbeat as it ages.

Switch tokens are stored as hashes, target-bound, expiring and single-use. A wrong-target request does not consume one. Offline targets cannot receive new grants, and revoked sources/targets cannot complete them. The saved local route cannot select another origin. Device origins preserve scheme and port; HTTPS is accepted, and direct HTTP is limited to loopback or Tailscale IPv4. The daemon binds loopback and the detected Tailscale address. Optional HTTPS is an installation-owned Tailscale Serve route; see [network evidence](acceptance/phase4-sync-network.md) and [installation](install.md).

See [HTTP and registration evidence](acceptance/phase4-http.md) and [registry evidence](acceptance/phase4-registry.md) for component checks. The combined local journeys are recorded separately in [J8](acceptance/J8.md) and [J11](acceptance/J11.md); an actual second device remains unavailable.

## UI request recovery

Supported UI callers wait on an explicit typed hub-unavailable response with request-specific retry permission. Sign-in retries stateless session issuance; configuration saves use atomic device-scoped request receipts, and new conversations retain stable request IDs. A configuration retry returns its original revision without overwriting a newer save. Pending browser request bodies remain in memory and stop waiting on cancellation or navigation. Generic network/HTTP failures are not replay authority. Account, managed Rigging, project, Jev, local Rigging and device Settings cover their own recovery boundaries; see [Settings saves](acceptance/phase4-settings-saves.md) and [Settings boundaries](acceptance/phase4-settings-boundaries.md). Initial composer choices validate before creation and save locally before the first decision boundary, as verified in [creation admission](acceptance/phase4-creation-admission.md).
