# Saved accounts on Projects threads — 14 October 2026

The owner reported Ready Claude accounts in Settings but a Madrid thread blocked on login. The member had never probed the shared account: its synthetic `missing` observation was newer than the hub’s genuine Ready observation. Account ranking consequently refused a valid saved credential before delivery. Shared vault accounts now use genuine observations across devices; synthetic missing rows do not revoke them. Real failures, token rotation, usage ceilings, cooling and device-local Codex sign-ins still apply.

Jev also now chooses the account from the eligible saved accounts after choosing the model/provider and device. The versioned a-v1 record captures candidate usage, eligibility, probabilities and any explicit resource fallback. Why shows these snapshots. Eligible resumed accounts remain sticky; when an automatic account becomes unavailable, Jev chooses again. Fixed account choices stay fixed. Credentials still travel through the existing vault and isolated homes; native machine logins are not a fallback.

## Verification

- **Simulated:** 174 affected backend tests passed, four skipped, in nine files. Fail-before regressions reproduced the shared-status error and deterministic account selection. Two real local daemons verify shared credential delivery into an owned isolated home while the native-home canary remains unchanged.
- **Simulated:** typecheck, lint and production build passed. One closing crucial-issues inspection of the changed account paths found no serious issue; no second inspection.
- **Live:** normal 0.3.5 updates on Pro and Madrid preserve device identity, membership and authentication, with complete cold backups retained. Both health endpoints report 0.3.5. Seven changed compiled modules match each platform archive.
- **Blocked:** the existing four-layout PJ4b browser fixture exceeded its unchanged 60-second server startup deadline before a journey began. No assertion or timeout was weakened. Dedicated automated vision credentials are unavailable. Manual live UI observations are recorded separately.
- **Not run:** full backend/full browser suites for this scoped patch. Earlier readiness failures are not relabelled as passing.

The stopped Madrid UX task stays stopped; its replacement on the MacBook finished independently and was not duplicated. Ekoa autoMerge stays off. No native home, owner checkout, Mini app or Ekoa CI change.

## Live result

A real coordinator-chat request created `thread_01M4XPPJH6AFCF9KPTBSMH0743` on Madrid. Provider/device were fixed to reproduce the remote Claude bug; Jev chose Sonnet, low effort and Gmail (0.97; Ekoa 0.03). At selection Gmail used 9% five-hour / 26% weekly, Ekoa 35% / 28%, both under the 90% ceiling. Both were eligible shared logins, based on Pro observations. The real Claude session read the remote and hostname, then reported done in one turn, with no changed files, commits or PR. It started at 17:17:29 UTC and ended 17:18:49 UTC. Its no-change worktree was already removed when the collector tried to inspect it: the receipt records that limit rather than inventing a post-run git check.

[Live placement and report](madrid-live.json) · [Completed session](madrid-done.jpg). The Why view was inspected directly in [desktop light](why-desktop-light.jpg), [desktop dark](why-desktop-dark.jpg), [phone light](why-phone-light.jpg) and [phone dark](why-phone-dark.jpg). The candidate usage text wraps and stays readable. The temporary viewport and theme were restored. This is manual live UI/vision evidence, separate from the blocked automated browser fixture.

The first coordinator request selected the wrong device ID from an old job record. Its tools could not edit that pin. The owned test thread was stopped before its model turn; the coordinator recorded the corrected Madrid ID and created the replacement after a chat correction. That device-discovery/task-edit limitation remains; this run does not claim an unassisted device-selection pass. The account/model/effort decision on Madrid itself is real Jev, without a manual account or model picker. All unrelated owner work and four draft tasks were retained.

To check: open ekoa-code, ask the coordinator for one small task, then open the thread’s **Why**. **Account** should say **Jev**, and **Accounts when chosen** lists the saved candidates and usage. An existing stopped thread stays stopped; start new work rather than duplicate the completed UX review. Claude shared accounts need no machine login. Codex subscription authentication remains device-local.
