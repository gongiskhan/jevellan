# Prior-phase verification under load

Simulated backend/browser behavior; dedicated screenshot judgments are labelled live separately. No owner acceptance is claimed.

The first current full Mac backend and browser matrix ran together. Observed machine load reached43.59 on10cores, with31GB memory used. Only their known owned CLIs received normal interruption; their partial logs and verdicts remain private.

- Backend: exit130, no complete suite verdict. Two completed files retain13 failures among105 cases.
- Browser: exit130;35passed,15failed,2interrupted,244notrun of296.
- Quiet Mac rerun: all105 cases in git-policy.test.ts and automatic-conversations.test.ts pass with one worker in627.85seconds. No behavior in those services changed.

The new full backend uses a separate main-only source clone on Madrid at7eb99ead3eca8535a0797fe67a357cbb95c880f1, tree979537e23c6c0b9f6c1d09e89a29e4095c8f7f0c. Original owner checkouts and native homes remain untouched. Fresh private dependencies, typecheck and lint pass; full backend is in progress and build is not run yet. Its versioned private receipt is under /home/ggomes/.jevellan-build/full-checks-7eb99ead-20261014-logs. This baseline precedes decision805; affected805 cases are reported separately, and full closing checks remain required.

Affected browser checks use one fixture and one worker per layout. CM5 passes allfour with16 clear dedicated live vision judgments; [the validated receipt](scenarios/2026-10-14/terminal-browser-803.json) retains screenshot hashes and explicit ownerAcceptancefalse. The first one-layout fixture setup had a wrong working directory, started no tests and remains a separate failed preparation record.
