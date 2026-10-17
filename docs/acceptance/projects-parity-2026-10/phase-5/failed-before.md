# Phase5 failing regressions

All results here are simulated. Raw logs remain outside the checkout because fixtures can print native session identifiers. Excerpts below omit them.

| Regression | Before result | Evidence |
| --- | --- | --- |
| Project model/effort bounds, lone mapped effort, v3 guidance/trouble | Four failures; packet-size case already passed | projects-placement.test.ts PAR5 cases; placement-before log outside checkout |
| Quota before verification | An unavailable launch consumed turn2 instead of keeping turn1 | projects-account-recovery.test.ts; expected turns1, received2 |
| Owner follow-up at quota | Corrected regression timed out with one queued owner message and no retry state | Same file; the earlier immediate assertion did not drive delivery long enough and is not claimed as the regression |
| Mid-turn usage limit | Only one launch instead of a second account; cooling confirmed | Same file; expected2 starts, received1 |
| Long automatic wait and real blocked report | Kept original placement reason start | Same file; two failures; fixed-model guard already passed |
| Coordinator usage-limit retry | Retry observed failedTurnsInARow1 instead of0 | project-coordinator-loop.test.ts |
| Account exhausts during a-v1 selection | Missing accountWait metadata | project-turns.test.ts |
| Usage rebuild during hub outage | Readiness rejected instead of retaining counters | project-usage.test.ts |
| Large usage read across mesh | HubProtocolError at the existing2MiB response bound | project-hub-store.test.ts; three days with2,000 rows each |

The first broader schema run also caught an obsolete test derivation that did not omit daemon-only fix metadata. The actual report input already refused it. The broader launcher run caught an expected-shape assertion that needed the new account-wait metadata. Neither is claimed as a newly discovered product vulnerability.


Additional valid regressions: a mid-turn account change had no account-limit reason/event; its notices were absent from the thread view; the new account's prompt omitted the old partial output; and an owner follow-up overwrote escalation with follow-up. Each failed before its corresponding repair. The existing verification-attempt journey is also extended to assert one escalation while retaining the same eligible native session.


Further valid before-fix regressions: provider account resets were dropped (missing resetsAt,30minutes instead of the supplied hour); unchanged usage polls read ledgers twice instead of zero times; a project time-zone change returned0 instead of12 input tokens; a hub outage left no retry state for a pending verification; an owner-command wait incorrectly recorded one escalation. Each exact assertion remains in the final tests.
