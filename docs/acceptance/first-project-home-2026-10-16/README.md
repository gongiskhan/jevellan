# First project on opening — 16 October 2026

## Decision844 — the first sidebar project is Home

Replaces the New conversation landing page at `/` for registered projects. Use the same sorted project list already loaded by the sidebar, so its first entry determines the opening page without a fixed Ekoa id or another API request. The current first project on the Pro is ekoa-code.

The opening page waits for the project list, then replaces the root history entry with the project URL. A late reply cannot move someone who has already chosen another page. Opening `/` after sign-in uses the same path. Explicit New conversation moves to `/new`; a successful empty project list uses that as its fallback. Existing project, task, thread, terminal and Settings URLs remain available. The PWA already launches at `/`, so the installed app uses this default too.

Only web navigation changes. Existing conversation journeys now visit `/new` when they intend to use its composer, or `/settings/runtimes` when their sign-in setup needs Settings. Their assertions and task behaviour remain intact.

## Verification

- **Simulated:** 40 focused project UI cases pass. Typecheck, lint, production build and the compatible Pro0.3.6 web build pass.
- **Simulated:** the first four-layout check passed navigation, reload, explicit New conversation and Back. Expanded coverage adds fresh sign-in and empty-list fallback. Its initial phone-light attempt opened the menu during the still-pending home redirect; the redirect correctly closed it. The shared Projects test entry helper now waits for the project URL before acting on its navigation. Assertions and timeouts remain unchanged. Final expanded matrix result follows below.
- **Not run:** full backend/browser suites, dedicated model vision and physical-phone acceptance. Browser screenshots have the fixture's explicit vision availability receipts; direct visual inspection is recorded separately.
- Compatible staging first missed the root tsconfig and failed before activation. Copied the existing configuration into the temporary build and rebuilt successfully. No installed files were changed by that failed stage.

## Activation and rollback

The supported scoped update replaces only Pro0.3.6 web files. It preserves old assets for open windows and a full previous-web backup. No daemon restart, runtime/account configuration, model turn, task, PR or Madrid deployment is needed. Browser update activation only reloads the window whose Reload button is pressed; other drafts remain intact. Activation and live opening-page evidence follow below.


## Final checks and live update

The final expanded browser journey passes **4/4** layouts (2.1 minutes), covering the selected first row, reload, explicit New conversation, Back, fresh sign-in and a validated empty project list. The empty-list stub initially fetched the server during test teardown; replaced that stub with its versioned empty fixture and awaited route cleanup. No product assertion or timeout was relaxed. These initial fixture failures remain recorded above and here.

Final typecheck and lint pass, as do the production and compatible web builds. The build retains its existing bundle-size warning. One closing crucial-issues inspection of navigation, delayed replies and history finds no serious issue; no second review is needed.

Live compatible web-only activation completed at14:53:10UTC on Pro0.3.6, with index hash024aa99543f8d56874eb48eb4d0110fd5e31d0cb5945f491068a166dbdc81954. The first two operational health probes timed out at three seconds and changed no installed files. Given the already documented Pro latency, the deployment probe then allowed15 seconds and required the exact healthy0.3.6 document. This changes no product or test timeout and makes no performance claim. The full prior web remains at ~/.jevellan-build/first-project-2026-10-16/web-before. No daemon or session was restarted. See activation.json.

The actual owner browser opened `/`, then selected the ekoa-code project URL. Applied its waiting worker through Reload in the verification window; other windows retain their drafts. Final live screenshot and navigation checks follow this receipt.


Live verification: `/` opens the ekoa-code project, the first sidebar row; New conversation opens `/new`; the Jevellan Home button returns to ekoa-code. The waiting update prompt is cleared. The header screenshot shows the settled real project and its selected first row. Four simulated screenshots were directly inspected without a blocking visual finding. No claim of physical-phone acceptance. The current Pro latency remains a separate limitation.
