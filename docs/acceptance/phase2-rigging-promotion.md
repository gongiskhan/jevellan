# Managed Rigging promotion

Loose skills, rules and commands can now become managed Rigging items through **Make managed**. The user chooses a name and supported runtimes. The source runtime remains selected during promotion; its toggle can be changed afterwards. This follows the existing reference behavior for file-based primitives. Hooks, MCP entries and settings retain their local edit, park and restore controls.

## Implemented behavior

- Capture the primary instructions and every supporting skill file into a versioned, portable document. Preserve binary bytes and executable scripts. The existing inventory limits apply: 256 files / 10 MB, with editable instructions bounded to 1 MB. Reject stale input, symbolic links and known credentials before saving the capture.
- Preserve the bundle's normalized source name for APM delivery. The display name is separately editable. Skills keep their exact primary text, including instructions without frontmatter. Rules and commands use the existing APM transformations for the selected runtime; Codex commands remain unsupported.
- Deliver through the installed APM into private staging. Check that every captured skill file and its executable flag survived APM before changing an account. A failed delivery retains the original source and exposes **Retry delivery**. Another loose item or an externally edited managed copy is preserved as a conflict.
- Save a durable promotion intent before claiming any original files. Claims record the exact captured source and are scoped to one account. An interrupted claim blocks that account's normal delivery until **Retry** finishes the managed item. A prepared, unclaimed intent can be cancelled with **Keep files as they are**; no source file is removed by cancellation.
- Repeated requests return the same managed item, including after a lost completion receipt. A retry never resets subsequent edits or runtime choices. Requests sharing an identifier but different contents are refused. Disk edits, claims and APM delivery use the same account-home queue.
- Local managed instructions continue to autosave. Supporting assets remain attached through later edits and through disabling/re-enabling runtime delivery. Removing old delivered files also removes empty directories, while unrelated siblings remain intact.
- Settings returns bundle metadata (name, supporting-file count and digest), not encoded asset payloads or private promotion records. The authenticated routes verify the account/runtime boundary before making changes. Pending promotion notices retain the original request for exact retry.

The capture becomes the managed source before delivery. If delivery needs attention, the UI says so and does not treat a saved item as proof that every account received it. The source instructions and assets remain available for recovery.

## Reference behavior

Read-only sources: Garrison's `src/lib/reconcile.ts`, `src/lib/state-transitions.ts`, `tests/state-transitions.test.ts`, `tests/state-transitions.integration.test.ts` and `tests/promoted-overrides.test.ts`. The port retains skill/rule/command promotion, complete skill folders, APM delivery, idempotence, sibling preservation and owned-item park/reinstall. Reference-specific per-target override storage and native-home import/sharing are not brought across.

Jevellan adds portable captured assets, versioned claim/retry records, source fingerprints, staged bundle verification and per-account serialization. The installed APM skill integrator documents and implements verbatim skill-directory copying; the tests below exercise that actual path rather than substituting a copier.

## Verification

- **Actual local tooling:** 34 component/delivery cases in three files passed in 10.46 seconds. This includes ten new promotion cases and the existing delivery/discovery regressions. Real APM delivered complete skills to both runtimes, preserved raw instructions, binary assets and executable scripts, retained assets through editing and runtime toggles, and deployed captured rules/commands without losing siblings. No native agent homes were used.
- **Actual HTTP and APM:** all ten Settings API cases passed in 8.10 seconds, including authenticated promotion, wrong-account/runtime rejection, stale input, private-asset omission, exact replay and completed-operation cancellation refusal.
- **Rendered UI with simulated accounts:** all 12 affected browser workflows passed in 58.9 seconds across 1440-pixel desktop and 390-pixel phone layouts, light and dark. The new flow promotes to both runtimes, edits instructions, checks the supporting file bytes, recovers a lost completion receipt, disables/re-enables one runtime and retains the other runtime's delivery. Existing Settings and account-local recovery workflows remain green.
- Typecheck, lint and the production build passed. The first complete browser run passed 43 workflows and failed five response-wait assertions: four account dialogs were still saving, and one promotion retry was still applying to the accumulated fixture accounts when the five-second assertions expired. Their focused workflows had passed. Both tests now await and verify the actual HTTP responses before checking the UI state. The next full run passed 45 workflows and exposed three analogous five-second startup assertions in the correction workflow while a stretch was still preparing. First-step startup assertions now use the same 30-second allowance already used for other stretch starts. All 16 affected workflows then passed in 1.5 minutes. The final complete browser matrix passed **48 workflows in 5.3 minutes**. The complete unit/integration/contract run passed **461 cases** and timed out one existing Basic Memory index-refresh case at its 60-second allowance (**35 files, 1157.14 seconds overall**). That case then passed alone in **28.02 seconds**, with 68 other cases excluded. The full command is not recorded as green; another complete run remains required before phase closure. Representative desktop/phone and light/dark captures were visually checked.

Interrupted saves and missing APM output are simulated failures against actual private files and hub storage. Provider logins/model responses in browser fixtures are simulated. No live provider acceptance or Claude SDK vision pass is claimed.

| Layout | Promotion choices | Managed instructions |
| --- | --- | --- |
| Desktop, light | [Capture](screenshots/phase2-rigging-promote-desktop-light.png) | [Capture](screenshots/phase2-rigging-managed-desktop-light.png) |
| Desktop, dark | [Capture](screenshots/phase2-rigging-promote-desktop-dark.png) | [Capture](screenshots/phase2-rigging-managed-desktop-dark.png) |
| Phone, light | [Capture](screenshots/phase2-rigging-promote-phone-light.png) | [Capture](screenshots/phase2-rigging-managed-phone-light.png) |
| Phone, dark | [Capture](screenshots/phase2-rigging-promote-phone-dark.png) | [Capture](screenshots/phase2-rigging-managed-phone-dark.png) |

## Remaining phase work

Live manual journeys and native integration/lifecycle evidence remain before phase 2 can close. Jev classification belongs to phase 3; it is not part of this increment. The earlier [Tailscale progress preview](progress-2026-09-24.md) remains a fixed snapshot of its real manually selected Codex run.

The subsequent complete `npm test` run passed **462 tests in 35 files in 824.64 seconds**, with no concurrent browser matrix. The earlier index-refresh timeout is resolved by that authoritative full run; no timeout or implementation change was needed for it.
