# Madrid member connection — 16 October 2026

Evidence: live unless marked otherwise. Source tested: 5731f7c6. No product source or runtime defaults changed.

## Decision 843 — retain both installations and restore the existing member

Refines the operational status of the independent Madrid hub decision, without replacing its authority or migrating data. The owner is using the Pro 0.3.6 project URL and needs its retained Madrid thread. Madrid is reachable by SSH; the Pro roster's offline state described the missing member daemon, not the machine. Native-conversation SSH connections and mesh membership are separate.

The current `jevellan.service` runs the independent 0.4.1 hub from `~/.jevellan-hub` on 9771. The retained `~/.jevellan-member` still contains its original registration, isolated account homes, thread and worktree, but its application and service were uninstalled. Its last Pro heartbeat was 15 October at 06:38 local time. HTTPS 443 was pointing at the separate hub.

Restored the member's retained 0.3.6 application from the existing pre-continuation backup. Created the separate `jevellan-member.service`, enabled under the same user's systemd, running the member home on 9772. Restored only the existing `https://dev-madrid.tail31efa.ts.net` root proxy to that member. Every other Tailscale route compares unchanged. The independent 0.4.1 hub remains healthy on 9771; no authority, identity, accounts, Ekoa checkout or native login was changed.

## Live checks

- SSH succeeds; both local health endpoints return their expected versions, 0.3.6 on 9772 and 0.4.1 on 9771.
- Member HTTPS health returns 0.3.6. Member service is active, enabled and has zero restarts. Native systemd unit validation passes; the existing user has lingering enabled, so the service can run without an interactive login.
- Registration and authentication files have the same fingerprints before and after activation. No secret content was printed or copied into this evidence.
- The Pro Devices page shows dev-madrid Online with a current heartbeat.
- The original legal-verification thread opens through the Pro UI; the offline warning is gone, its two saved reports remain, and its message composer is available. The original worktree exists. No replacement task, new message, turn or PR was created.
- The isolated Codex executable starts and reports version 0.153.4. This is not a provider turn or sign-in acceptance.

## Remaining limitation

This thread had already failed to start Codex twice before the member disappeared. Its old reports still read “Codex Exec exited with code 1: Codex could not start.” No saved transcript is available. Reconnection does not establish that a new provider turn succeeds, and no diagnosis of those historic failures is claimed. A fresh thread turn, provider authentication and PR creation are **not run** in this connection repair.

Unit/browser matrices, build, physical-phone acceptance and a model review are **not run**: this change restores retained services and routing, with no source change. Live browser and service checks provide the operational evidence.

## Recovery and future operations

Private operational receipts remain on Madrid under `~/.jevellan-build/member-reconnect-2026-10-16/`. The original backup and independent hub are retained. The member uses a dedicated service name; a generic install/update against its home must not replace the independent `jevellan.service`. Check both homes and service names before future maintenance.

To undo only this repair, stop/disable `jevellan-member.service` and restore HTTPS 443's root proxy from 9772 to its recorded previous target 9771; retain the member data and restored application. Do not run this rollback during active member work.

Screenshots: `thread-recovered.png`, `madrid-online.png`.
