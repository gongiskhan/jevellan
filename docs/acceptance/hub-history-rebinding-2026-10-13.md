# Imported history recovery — 13 October 2026

Live: the owner authenticated the Pro through its ordinary HTTPS form. A separate real browser context also signed in through that form; its state is private, mode 600, outside Git. No password was saved. Gmail Claude refreshed to Ready (1% five-hour, 10% week); Ekoa Claude reached its configured usage ceiling (98% week). Codex still needs its separate OpenAI sign-in. Jev returns jev-latest and jev-preview; the stable jev-latest selection saves and tests successfully (278 ms). Credentials and other model/settings choices remain intact.

The old browser application rejected v3 project responses. Its existing update-ready reload resolves that mismatch. The new project page is valid, but `/hub/projects` returns 400: “A conversation directory belongs to another device.” The importer rebound current metadata while preserving original ledger entries. Replay reconstructs Mini ownership from those entries and rejects startup recovery, blocking Project Settings and checkout binding. The installed 0.3.0 service remains healthy; this does not make imported histories usable.

## Repair and checks

Append conversation-owner-rebound-v1 through the existing ledger control path, only when the import receipt's source owns the conversation and its destination is this device. Preserve the original entries and blobs, request/work contents, timestamps and generation. Repeated recovery adds no duplicate event; a mismatched source/destination stays refused. A later migration can transfer the already rebound owner in sequence. No turn starts from this bookkeeping operation.

Simulated: the new real encrypted-import/startup regression fails before the repair with the live error. The final migration/work run passes 39 cases in two files (24.10 seconds), including receipt mismatch guards, repeat handling and another transfer. A broader affected run passes 131 cases in three files (1,481.07 seconds). These overlapping runs are not added together. Typecheck, lint and build pass.

Simulated: four browser layouts pass in 16.4 seconds, checking Project Settings, the editable destination checkout, original conversation content over HTTP and on screen, and the original ledger prefix. Eight dedicated live vision judgments of those fixture screens are clear. Three earlier fixture attempts remain failed evidence: an incomplete login wait, an ambiguous duplicated message locator, and mobile sidebar/fixture SSE teardown. The fixture now waits for authenticated Runtimes, reads the timeline explicitly and closes only its own connections; history/settings assertions remain intact. These checks do not establish real provider or phone acceptance.

## Release and pending work

0.3.1 packages this repair and the corrected Ekoa Settings wording, “merge questions.” Keep published 0.3.0 and earlier cold restores immutable. Publication, platform package verification and the preserved Pro update follow this source checkpoint. Take a complete cold 0.3.0 snapshot before updating: its older replay cannot read the new ownership control, so application-only rollback is insufficient.

Blocked: OpenAI needs its own password/sign-in and 1Password remains locked. GitHub token management requires its existing passkey confirmation. Connecting Madrid/Mini creates persistent member credentials and awaits the specific computer-use access confirmation. Madrid remains below Ekoa's 20 GiB guard. GitHub/MCP tokens, checkout bindings, member joins, retained Mini URLs, real gate journeys, A/B/C/D, LJ9, two watch nights and physical-phone acceptance remain incomplete. No ten-hour scenario clock started, and actual scenario usage/cost remain unknown.

No additional review pass ran. Ekoa's CI, scheduler variable, PR208 merge and automatic-merge choice remain unchanged. Native homes, owner checkouts and Garrison remain untouched. The ordered [activation handoff](loop-activation.md) leads with the remaining owner actions.
