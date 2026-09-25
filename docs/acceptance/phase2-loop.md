# Phase 2 manual loop and browser evidence

The owner daemon now connects the conversation journal, account selection, runtime execution, scoped MCP bridge, memory queue, checkpoints, verification and publication. Startup recovers interrupted processes before conversation routes become available. Settings and health routes remain independent of conversation recovery. Nothing was installed as a persistent service.

## Evidence scope

`tests/conversation-service.test.ts` has 39 integration cases, including the eight settlement cases documented in [settlement evidence](phase2-settlement.md) and the corrections/recovery cases in [undo evidence](phase2-undo.md). The HTTP API, passphrase sessions, ledger, SQLite indexes, process ownership, Git operations and local bare origins are real. Model behavior is explicitly simulated by FakeRuntime. These are not real-Jev or live-provider acceptance journeys.

| Behavior | Evidence |
| --- | --- |
| A manual change stays local until verification and publication | Authenticated HTTP launch, actual checkpoint, independent shell test receipt for its exact SHA, bare-origin comparison, closed work and released ownership |
| An answer changes no files; a later request starts fresh work | Real journal replay and duplicate-message calls launch nothing; objectives, counters and work ids checked |
| A correction during preparation cannot launch a stale decision | Delayed credential resolution, incoming correction, zero runtime starts |
| Clean unpublished work still owns its checkout | A second conversation is refused before runtime launch |
| Notes and corrections differ | A note leaves the real disposable process running; a correction interrupts it, repairs the handoff and preserves both texts in the next brief |
| Plan, approval, block and continuation preserve obligations | Full plan, verbatim request and constraints survive in runtime inputs; work id, base SHA and counters remain continuous |
| Agent tests cannot decide completion | An agent claims success, but the daemon test fails on the final checkpoint and origin stays unchanged |
| Manual mode cannot bypass guards | Step-limit pause rejects another choice; a reply extends the same work once, including a retried message |
| A failed Git check cannot become a later publication | A direct agent commit fails its step; a durable checkpoint block also refuses a subsequent done action |
| A publication conflict includes integration memory before final verification | A real conflicting upstream push causes an integration stretch; the original checkpoints are saved, both contributions survive, the handoff's memory note is checkpointed, and the final receipt matches the published code-and-memory SHA |
| External projects retain their own Git state | Changed files are verified without commits or publication; content fingerprints invalidate a command that changes the tested files |
| A correction during verification prevents stale publication | The actual test process waits for a fixture signal; a correction arrives before it finishes; no push follows |
| Cancel during verification cleans up before closing | The owned test process exits, work closes as cancelled, and unpublished checkpoint ownership stays held |
| Reconnect and two viewers see one journal | Both authenticated SSE clients receive matching contiguous ids; Last-Event-ID resumes without gaps or duplicates; native process/session identities stay out of browser responses |
| Startup recovery does not launch a successor | An actual disposable process is recovered from durable running state, terminated and marked interrupted with the restart notice |

Decision records are durable journal events and files, with a hub index updated on outcomes and rebuilt on recovery. SSE subscribes before replay, reads from its last written journal id and observes backpressure. A disconnected viewer does not stop the writer. Verification cancellation uses the same owned-process cleanup as runtime cancellation.

## Browser workflow

`tests/e2e/skeleton.spec.ts` exercises four workflows at 1440×900 and 390×844, in light and dark themes. Each layout has a disposable daemon, home, checkout and bare origin. Provider login and model output are simulated; browser navigation, account storage, project writes, streaming, checkpoints, verification and publication use the application.

The conversation workflow adds a project in Settings, inspects its instruction files, searches its empty memory, starts work, manually chooses a plan, reads the full plan, approves it, implements, opens Why, reloads history, closes with Keep, reloads again, publishes the kept work and inspects the actual diff and verification receipt. It asserts no horizontal overflow or browser script errors and checks that the sidebar reaches Done. A third workflow keeps a real checkpoint, reloads, confirms Discard, checks the saved-ref receipt and starts fresh work. The existing Settings workflow still covers account/login forms, Rigging, configuration import and private-data cache exclusion.

Screenshots:

| View | Desktop | Phone |
| --- | --- | --- |
| Projects | [light](screenshots/phase2-projects-desktop-light.png), [dark](screenshots/phase2-projects-desktop-dark.png) | [light](screenshots/phase2-projects-phone-light.png), [dark](screenshots/phase2-projects-phone-dark.png) |
| Full plan | [light](screenshots/phase2-plan-desktop-light.png), [dark](screenshots/phase2-plan-desktop-dark.png) | [light](screenshots/phase2-plan-phone-light.png), [dark](screenshots/phase2-plan-phone-dark.png) |
| Changes and receipt | [light](screenshots/phase2-changes-desktop-light.png), [dark](screenshots/phase2-changes-desktop-dark.png) | [light](screenshots/phase2-changes-phone-light.png), [dark](screenshots/phase2-changes-phone-dark.png) |
| Completed conversation | [light](screenshots/phase2-conversation-desktop-light.png), [dark](screenshots/phase2-conversation-desktop-dark.png) | [light](screenshots/phase2-conversation-phone-light.png), [dark](screenshots/phase2-conversation-phone-dark.png) |

Representative desktop and phone screenshots were visually inspected for clipping, overlap, readability and accessible controls. This is supplementary inspection, not the required Claude SDK vision judge: that remains blocked by ENV-CLAUDE. The initial new browser test used an unsuitable exact label selector for the nested Project select; its accessible combobox-name selector passes. Screenshot framing was corrected for fixed headers and open dialogs.

## Remaining phase 2 work

This is a working manual path, not completion of phase 2 or J1–J13. Subsequent checkpoints add undo mapping across conflict integration, last-closed undo with newer work open, explicit adoption after checkpoint blocks, hook capture delivery, memory-only publication/conflict rules and context creation/keep/merge application in Projects; see the linked evidence in REPORT.md. Public-repository memory notices, remaining timeline/file navigation and editing controls, and fuller memory-viewer evidence still need completion. The complete manual-loop conflict and integration-memory-queue path now has the actual Git/Basic Memory test described above. Native live-provider conversation journeys and the required vision judge have not run in this checkpoint.

No new build commit or push was attempted while the previously recorded COMMIT-APPROVAL and GH-AUTH blockers remain unchanged. Garrison's HEAD and full status match the latest appended preflight snapshot. The separate original upstream-status drift remains reported; no ref was changed to hide it.
