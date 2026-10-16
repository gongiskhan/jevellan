# GitHub job with no downloadable log

Decision845, 16 October2026. The owner reported “Could not read GitHub: GitHub answered with HTTP404.”

**Live diagnosis:** Ekoa Code coordinator ledger event3024, turn96, at17:17:24UTC requested `job_log` for job117098454562. The job belongs to [run38938066981](https://github.com/gongiskhan/ekoa-code/actions/runs/38938066981), PR277. Job metadata reads successfully: name result, completed/failure, no runner name, no steps. GitHub's signed log storage returns404/BlobNotFound. The check's failure annotation reads:

> The job was not started because recent account payments have failed or your spending limit needs to be increased.

The same annotation asks the owner to check Billing & plans. Nothing here proves which of those two account conditions applies. No payment or spending setting was changed; no log or failed test was invented. Repository access is working for this request.

**Change:** only a log404 triggers a job metadata/check-diagnostics fallback in GitHubClient.workflowJobLog. The result explicitly says no downloadable log exists, then gives job status and check summary/annotations. Normal logs retain their single-request path. Existing scope checks, request accounting,60-second result cache, secret redaction and8,000-character bound remain. The fallback accepts only a check id linked from the readable job under the configured API and same repository; it never forwards a token to the signed log download. Missing jobs and authorization failures remain errors.

**Simulated:** before repair, six of the initial seven regressions fail and the normal-log fast-path case passes. Afterwards,34 checks pass across github-job-log, github-client, project-github-awareness and project-coordinator-tools; the later cache/current-head regression passes separately, for35 distinct passing cases. The initial sandbox attempt cannot start its localhost fixtures (EPERM):25 failures are infrastructure failures, not passes; the new client cases pass. The unrestricted fixture run passes without source/assertion/timeout changes. Typecheck, lint and production build pass; Vite retains its existing large-chunk warning.

**Live:** staged compatible0.3.6 and installed-module reads use Jevellan's existing project-scoped credential, ephemeral in memory, to return the real failure annotation. No native agent credential is borrowed. See staged-diagnosis.json and installed-diagnosis.json. The Pro update changes only workflowJobLog, in both packaged and loaded copies of github.js. Normal launchd shutdown completes before exclusive maintenance and replacement; health returns0.3.6/ok. Rollback is at `/Users/ggomes/.jevellan-build/github-404-2026-10-16/before`. No web assets, settings, Ekoa code/CI/PRs, Madrid installation or native homes change. Historical error entries remain historical.

**Not run:** full backend/browser suites, new paid provider turn, physical phone and model vision. A closing crucial-issues source inspection found no serious issue; no second review. The live module read proves the actual credential and diagnosis path, not the coordinator's next natural-language response or resolution of GitHub billing.

**Live recovery:** activation at20:20:52UTC retains the two queued coordinator events. Natural recovery processes turns97/98 and returns Idle; no test task or manual coordinator message was sent. The project page reload initially hits the already-recorded Pro latency and the offline page. Local health exceeds15seconds on one probe, while the following tailnet health returns200 in113ms. Try again eventually loads the complete project chat; live-project-header.png shows the restored Ekoa page/Idle state. This is not a claim that the Pro responsiveness issue was fixed. Historical errors remain in history, and the coordinator has not been asked to repeat the log read.

Working-tree secret scan and whitespace checks pass. A redundant standalone history scan was interrupted; it is not passing evidence. Publication uses the normal mandatory full-history pre-push hook.

The owner needs to resolve the account issue in [GitHub billing](https://github.com/settings/billing). Jevellan cannot make that financial decision. Then rerun the failed check normally; do not treat this missing log as a passing check.
