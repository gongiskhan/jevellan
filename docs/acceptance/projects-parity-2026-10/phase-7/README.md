# Phase 7: Library, attachments and environment

Source verification is complete for the affected checks. The installed Pro hub, member services and Ekoa checkout are unchanged.

## Delivered source

The existing hub database stores versioned library metadata; file bytes stream to private temporary files and are hash checked. The owner can upload, open, download and delete files in Overview → Library. Both composers accept up to ten files, including desktop paste and drop. Uploaded chips survive a failed send. Threads can retain outputs through their scoped library tool. Members fetch files into read-only mirrors, including paths with spaces. The library uses its own content route and image viewer, so these files do not become phantom worktree screenshots.

Project variables and vault-only secrets reach setup, thread turns, publication tests, pull-request verification and command jobs. They do not reach the coordinator. Launch-time secret registration redacts recorded output. New worktrees copy selected untracked regular files; their paths are snapshotted locally and excluded from leftover staging. Every commit since base is checked before publication, so committing then deleting a copied file still stops the push.

Rigging can apply to selected projects. Empty or absent scope means all projects, and Conversations use the same filter. No native agent home, login, shell profile or Basic Memory installation was changed.

## Verification

- Simulated: 121 distinct affected backend cases pass across the recorded runs:116 across eleven files, two additional member/history cases and two streaming regressions in the eleven-case library rerun, and one separate alternate-provider verification setup/environment case.
- Simulated: typecheck, lint and build pass in the recorded gate runs. The final repeated gate is recorded before the phase commit.
- Simulated: PAR7 passes in all four layouts. PAR7b also passes in all four layouts with decoded pixels, gallery controls, retry preservation and deletion. Its final logs contain no ERR_HTTP_HEADERS_SENT.
- Not run: dedicated model vision lacks its test credential. Screenshot inspection is separate from that gate.
- Not run: real-provider image reading and member live journeys remain LP6 after installation. No owner acceptance is claimed.

The backend command is `npx vitest run tests/project-library.test.ts tests/thread-images.test.ts tests/project-publication.test.ts tests/project-turns.test.ts tests/project-git-environment.test.ts tests/thread-worktree.test.ts tests/core.test.ts tests/project-bridge-schemas.test.ts tests/project-bridge.test.ts tests/project-daily.test.ts tests/rigging.test.ts`. The separate merge-gate case is named `verification setup and the alternate provider receive fresh project environment`.

The browser journey is PAR7 in `tests/e2e/projects.spec.ts`, with the existing project fixture and screenshot/vision wrapper, at desktop1440×900 and phone390×844, light and dark.

## Regressions and unsuccessful attempts

Simulated failing-before receipts are retained outside the checkout:

- `/private/tmp/jevellan-parity-p7-first-before.log`: project variables absent; no worktree copy method; already-staged copied file included in a leftover commit.
- `/private/tmp/jevellan-parity-p7-mirror-concurrent-before.log`: concurrent downloads made the other's temporary file inaccessible when restoring read-only modes. Downloads now finish in private temporary storage, then promote synchronously.
- `/private/tmp/jevellan-parity-p7-confinement-before.log`: cached reads did not restore lost read-only modes, and an absolute path was accepted where a worktree-relative output path is required.
- `/private/tmp/jevellan-parity-p7-library-image-before.log`: attachment text created a phantom worktree image reference.
- The publication regression first identified the later deletion instead of the original private-file addition. The history check now visits commits oldest first and considers additions and changes, while still refusing the whole branch.

Initial fixture errors used the wrong result envelope, cleanup method and modal button label. They were corrected to the existing contracts. The assertions about delivered files and reports were retained. Read-only fixture folders are made removable only after their disposable daemons stop; no owner or native folder is involved.

One repeated desktop run stalled at Settings reload with “Loading your workspace…”. Five settings reads completed, while `/hub/secrets/jev` and background reads remained pending. The preceding desktop journey and the quiet repeat passed with unchanged assertions. The trace remains at `/private/tmp/parity-p7-desktop-light-final/`; the closing full suite must assess recurrence. No assertion timeout was increased.

## Decisions and limits

Decisions880–887 are in the run log. The file limit is50MiB and active-project quota2GiB. Metadata is paged in100-item responses to preserve the mesh JSON limit. Upload folders use UTC dates; displayed dates use the browser's time zone. The library is stored on the hub and is not an additional GitHub vault store. Existing full-suite and fixture lifecycle findings remain closing gates.


The member end-to-end case receives the exact attachment line in its prompt, reads the hash-checked read-only mirror through its scoped tools, and adds a regular output file to the hub. Deletion retries preserve the same receipt, and deleted paths stay reserved so a later upload cannot replace the bytes named by an old attachment. Decision886 records that behavior.

The first corrected-stream matrix passes three layouts; phone-dark is blocked at Delete by the deliberately injected, persistent error notice. The journey now verifies that exact error and uses its existing Dismiss message button before continuing. This is an ordinary owner action, with no forced click, hidden overlay, changed deadline or removed assertion. The subsequent final four-layout repeat passes.

Two further regressions fail before the streaming repair: `/private/tmp/jevellan-parity-p7-stream-before.log` and `/private/tmp/jevellan-parity-p7-stream-abort-real-before.log`. The earlier PAR7b UI-only successes are invalid as clean passes because each server crashed during teardown. The corrected four-layout receipt explicitly checks that fatal error as well as the browser result. All11 Library cases pass after repair.

The final capture set contains 40 screenshots and 40 dedicated vision receipts, all not run for the missing test credential. Selected Library, modal and message captures were directly inspected; that is not model vision or physical-phone acceptance.
