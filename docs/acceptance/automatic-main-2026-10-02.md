# Automatic main switch — 2026-10-02

The user requested that Jevellan move a project to main when it is on another branch, with a prominent warning. This supersedes the previous requirement to change branches manually before starting foreground work.

## Behavior and design choices

- Foreground admission and tracked Context setup record the intended move before changing the checkout, then record completion. A persistent warning shows the original branch and main in the conversation heading and timeline, and in Context setup. New-conversation setup also announces the completed move.
- Preserve the original branch pointer. Do not merge it into main, delete it or change the remote default branch.
- Fetch main explicitly so clones that normally fetch only another branch also work. Existing main must fast-forward; source work must already be published.
- If main exists neither locally nor on origin, create it from the published source branch tip. A create-only remote lease prevents overwriting main created concurrently. This handles the reported project, whose only published branch was a feature branch.
- Dirty files, unpublished commits, detached HEAD, pending Git operations and existing ownership/activity blockers still stop the operation. Ignored files cannot be overwritten by the switch. External-policy projects remain untouched, and background maintenance does not switch branches.
- Branch-change receipts have a strict versioned schema. Existing Context documents can optionally include the latest receipt; no migration is required.

## Evidence

**Simulated:** 14 focused tests passed in three files (14.45 seconds): published-branch preservation and pre-mutation warning, single-branch clone fetch/publication, absent-main creation from a published source tip, concurrent remote-main protection, dirty/unpublished/pending/detached blockers, background/external exclusions, Context setup with durable warnings, UI setup notification, and existing first-write/checkpoint/dirty/external regressions. The other 80 cases in those files were excluded by the focused name filter. An initial sandbox attempt could not inspect processes (`/bin/ps` permission); the authorized rerun passed. Typecheck, lint, production build and whitespace checks passed.

**Live:** installed a frozen release outside the checkout and activated it only after the lifecycle gate confirmed idle. The existing tailnet address serves the updated build. Retried the reported project's blocked Context setup through Jevellan's continuation path; the checkout reached main, main was created on origin, and the completed warning receipt was saved. The original branch remains intact. Context setup completed and published successfully; the checkout is clean. The one-time recovery was removed from the launcher afterward.

**Not run:** full unrelated suites, provider execution, authenticated browser inspection and physical-phone checks. The available browser profile was at the sign-in screen; no credentials were borrowed. This report does not claim user acceptance or that the project's application was started.
