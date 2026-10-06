# PJ-live - a live coordinator thread to a merged pull request

**Evidence label: blocked.** On 2026-10-06, Mac.lan selected Codex subscription sign-in and the user's explicitly authorized `gh` client. The new preflight ran with `--codex-subscription --github-auth gh --github-repo gongiskhan/jevellan-live-sandbox`. It wrote [PJ-live.json](PJ-live.json), exited 0 and started no daemon, browser or clone because `gh` authentication could not be verified (AUTH-GITHUB). Direct read-only `gh api user --jq .login` checks returned HTTP 401, even after the user reported completing login. No repository was created or changed, and the proposed disposable repository's existence was not checked. A blocked journey is not a pass, and the owner's acceptance is not claimed.

| Input | Required in the selected mode | Check on Mac.lan, 2026-10-06 |
| --- | --- | --- |
| Jev key | yes | `JEVELLAN_TEST_JEV_KEY` is present. All four earlier live Jev tests passed. |
| Codex subscription | yes, sign-in through the UI | Selected; sign-in has not started because GitHub preflight is blocked. The missing `JEVELLAN_TEST_CODEX_KEY` does not block this mode. |
| Authorized `gh` login | yes | AUTH-GITHUB: authentication cannot be verified. The environment GitHub token is missing and is not required in this mode. |
| Disposable repository | yes | Supplied explicitly in owner/repository form; not created, cloned or verified. The environment repository variable is not required in this mode. |
| Claude token | no | `JEVELLAN_TEST_CLAUDE_TOKEN` is present. Earlier J1 and its three screenshot judgments passed live. |

The current `live-journey-v3` receipt records explicit authentication sources using `live-authentication-v1` and the status of resolved logical inputs only. It has `blockedBy` AUTH-GITHUB, no optional missing credential, `passed: false`, no checks or screenshots, and `daemonStarted: false`. A repository status of `present` means the argument is syntactically valid, not that a repository exists. The earlier API-key preflight at `f4dfd92` was blocked by ENV-CODEX and ENV-GITHUB; its version-2 receipt and the 2026-10-05 missing-all receipt remain historical evidence in Git. See [REPORT.md](REPORT.md#projects-definition-of-done-audit).

The regression journey J1 used fresh isolated homes, a new TypeScript sandbox and a local bare origin under `/tmp/jevellan-live-2026-10-06-72on58gb`. All seven checks passed: finished work, a real Jev decision, an answer, unchanged clean Git and origin, read-only launches, the Why drawer and no browser errors. One completed `claude-opus-5-5` reply used low effort. All three screenshot judgments are live and ok, with zero blocking findings and eleven cosmetic notes. [J1 receipt](first-live-2026-10-06/J1/evidence.json), [vision receipt](first-live-2026-10-06/J1/vision.json), [J1 report](J1.md).

PJ-live's coordinator, placement, thread, added file and test, pull request, checks, UI merge, conclusion and screenshots remain **blocked, not run**. The optional Projects browser vision run was not run because the required live sequence did not pass PJ-live. This follow-up changes the runner authentication setup; product behavior and test assertions are unchanged.

## Verification on Mac.lan (2026-10-06)

| Check | Evidence label | Result |
| --- | --- | --- |
| Setup | Live local tools | Node 22.22.0, Git 2.50.1, APM 0.10.0 and Basic Memory on PATH; `npm ci` (including build), typecheck and lint passed. |
| Five-file Projects sanity | Simulated | 30 tests in 5 files passed. |
| Jev decision selection | Live (4); simulated (18) | 22 of 22 tests passed, including all four credential-gated live tests; no skips. |
| J1 conversation | Live | All seven checks passed; one completed read-only Claude Opus reply at low effort, no Git change. |
| J1 screenshots | Live | Three judgments passed; zero blocking findings, eleven cosmetic notes. |
| PJ-live authentication preflight | Blocked | AUTH-GITHUB in explicit subscription/gh mode; read-only CLI authentication failed, with no daemon, browser, clone or repository changes. All later PJ-live checks remain not run. |
| Full backend regression | Simulated | 1601 passed, 2 failed, 4 deliberate credential-gated skips; both failures passed unchanged in isolated reruns. The original full run remains failed. |
| Full browser regression | Simulated; new vision not run | 189 passed, 14 failed, 5 not run out of 208; installation 4 of 4 passed. The affected whole files then passed 119 of 119 with one worker, including all fourteen failures and the five unrun cases; the other 89 cases passed originally. No skip, retry or flake in the rerun. The original matrix remains failed. |
| Authentication follow-up checks | Simulated | Typecheck and lint, 27 new authentication tests, 69 related backend tests and three focused desktop browser workflows passed. Live subscription sign-in remains not run; the shared deep-link fixture uses Claude and the Codex login fixture is separate. |
| Optional Projects browser vision | Not run | Its required live PJ-live prerequisite is blocked. Historical live judgments were preserved. |

The full regression processes deliberately omitted test credentials; the backend's four Jev skips are separate from the four successful live Jev tests. [REPORT.md](REPORT.md#latest-verification) records the original failures, isolated reruns and private evidence paths. No product source, test assertion or timeout changed. The authentication follow-up has its own verification entry in REPORT.md.

## What the specification asks

BRIEF-projects.md section 13, phase 8 (local and untracked, like BRIEF.md): a live journey through `scripts/spikes/live-journeys.mjs --journey PJ-live` with a real Codex account and, if present, a real Claude token, real Jev, and a disposable GitHub repository given by `JEVELLAN_TEST_GITHUB_TOKEN` and `JEVELLAN_TEST_GITHUB_REPO`. The coordinator starts a thread that adds a small file with a test, the pull request opens, the checks state is read, and the merge happens from the interface. Missing credentials make the journey blocked, never passed.

## Credentials

Environment credentials are read once, before the journey runs, and every `JEVELLAN_TEST_*` variable is then removed from the runner's environment. No agent, worker or Git process inherits one. Jevellan receives the values only through its own API, into the encrypted vault, as for the conversation journeys.

| Variable | Receipt ID | What it is | How it enters Jevellan |
| --- | --- | --- | --- |
| `JEVELLAN_TEST_JEV_KEY` | ENV-JEV | The dedicated Jev key. | `PUT /hub/secrets/jev`. |
| `JEVELLAN_TEST_CODEX_KEY` (API-key mode only) | ENV-CODEX | An OpenAI API key of a dedicated test project. | `POST /hub/accounts` as a Codex API-key account with paid use `always`. Jevellan logs Codex in to the account's own home (`codex login --with-api-key`). |
| `JEVELLAN_TEST_GITHUB_TOKEN` | ENV-GITHUB | A fine-grained token for the disposable repository only, with Contents read and write, Pull requests read and write, Checks read and Commit statuses read. | `PUT /hub/secrets/github` (Jevellan's GitHub token) and, for Git pushes, an in-memory credential cache of the isolated user home (below). |
| `JEVELLAN_TEST_GITHUB_REPO` | ENV-GITHUB | `owner/repository` of the disposable repository. Any other form is `invalid`, which also blocks. | Cloned by the runner; never written to evidence (see Redaction). |
| `JEVELLAN_TEST_CLAUDE_TOKEN` | ENV-CLAUDE (optional) | The dedicated Claude token. | `POST /hub/accounts` as a Claude subscription. Claude is enabled only when it is present. |

The original API-key mode remains the default for unattended tests. `--codex-subscription` creates a Codex subscription account without a secret, opens a visible authenticated Chrome window at Settings → Runtimes and starts the existing device login panel. Complete sign-in there. The runner waits up to 30 minutes for that account to become Ready on the current device before discovering models or starting work. It neither reads nor copies a native Codex account home, and it needs no Codex API key. If sign-in does not reach Ready, the receipt is blocked by AUTH-CODEX, with source `subscription-login` and `daemonStarted: true`; preparation ran but no Projects work started. It stores no login instructions or codes.

`--github-auth gh` first verifies the explicitly authorized current CLI login using `gh api user`, then privately captures `gh auth token` in memory. It does not change any native login or save the token in a file or `.env`. The token enters Jevellan's encrypted vault through the existing GitHub secret API and the isolated Git credential cache. Other required missing inputs prevent any `gh` call. Failed authentication produces AUTH-GITHUB with a constant reason; CLI output and credentials never enter the receipt. `--github-repo owner/repository` overrides the environment repository input. Receipt statuses describe resolved inputs; authentication metadata identifies their source. Native provider logins and Basic Memory remain isolated.

The disposable repository must have `main` as its default branch and a root `package.json` named `jevellan-acceptance-sandbox` whose `npm test` needs no install (for example `node --test`). The journey merges a pull request into its main, so it must never be a repository that matters. The runner never changes any repository's visibility.

## Running it

- Blocked check: `node scripts/spikes/live-journeys.mjs --journey PJ-live [--output <new directory>]` writes `docs/acceptance/PJ-live.json` (or `<output>/evidence.json`) and exits 0 when a required credential is missing.
- Live run with environment credentials: `node scripts/spikes/live-journeys.mjs --journey PJ-live --home <new directory> --user-home <directory> --sandbox <new path> --output <new directory> --port <9871-9879>`, after `npm run build`. It writes `<output>/evidence.json` and six screenshots. It exits 1 when any check fails or the journey stops on an error. Judge the screenshots afterwards with `node --import tsx scripts/spikes/live-vision.mjs <output>` (needs `JEVELLAN_TEST_CLAUDE_TOKEN`).

For subscription and authorized CLI authentication, add `--codex-subscription --github-auth gh --github-repo owner/disposable-repository` to either command. The live run opens the subscription login UI and waits for the user; it does not inherit a native Codex login. The repository must already be prepared before a live run. A preflight without live paths writes a blocked receipt when authentication fails; successful authentication requires the live paths to continue.

`live-journeys.mjs` now only dispatches: PJ-live runs from `scripts/spikes/live-projects-journey.mjs`. The conversation journeys (J1, J2, J4, J5, J6, J7-off, J7-on, J13) moved unchanged, byte for byte, to `scripts/spikes/live-conversation-journeys.mjs`. An ES module cannot return early from its top level, so the move is what lets the blocked receipt start nothing.

## What a live run does and checks

1. **Isolation.** Before Jevellan starts, the runner reads the repository with the test token (default branch `main`, not archived). It then writes the isolated user home's Git configuration: an empty `credential.helper` resets every inherited helper, then `credential-cache` keeps the token in memory behind a private socket. Homebrew Git's system configuration on this machine names `osxkeychain`, the owner's keychain, so the reset matters, and the runner asserts that no inherited helper is left. The runner clones `https://github.com/<repository>.git` into the new `--sandbox` path and checks the marker, the origin and `main`. It sets the machine's normal Git identity in the clone. It then points `HOME` at the isolated user home and drops the SSH agent, ambient GitHub tokens and native `gh`/XDG configuration overrides, so Jevellan's own Git never reaches the owner's configuration, keychain, SSH agent or `gh` login. The repository visibility comes from the resolved token’s read. Explicit `gh` authentication is resolved before this isolation boundary.
2. **Setup through the product API.** Jev key and GitHub token go into the vault, plus the Codex key in API-key mode and the Claude token when present. Subscription mode signs in through the UI into the isolated Codex account home. Codex is enabled and Claude only with its token. The project `live_projects` uses external branch policy (Jevellan never publishes to main itself, so the thread works in a worktree and opens a pull request), `npm test` and device memory. The coordinator is pinned to the first enabled Codex model, so the Codex account always works; Jev places the thread on any enabled model. One running thread at a time. Global timers stay off, so no improver spends Jev or model calls. The Projects loops run (pull request polls every 15 seconds), and the runner sends this device's heartbeat every minute because placement reads it.
3. **The owner's request** goes through the Projects page composer: "Start one thread for this: add a small file with one exported function that returns a greeting for a name, and a test for that function that npm test runs. Keep the change to those two files. I will review and merge the pull request myself." Checks `coordinatorStartedThread` (the thread's owner-local record says the coordinator created it) and `worktreeIsolation`. Screenshot `chat`.
4. **The pull request opens.** Checks `pullRequestOpened` (open, on a `jv/` branch) and `jevPlaced` (placement source `jev` with Jev calls recorded). The placement record goes into the evidence. A thread that waits for the owner or ends without a pull request stops the journey with its reason, as does a thread left idle for ten minutes on a blocked report Jevellan wrote for it (a failed push, pull request or turn) that the coordinator did not act on. Screenshot `thread`.
5. **The checks state is read** by Jevellan from GitHub through `pr/refresh`. `none` counts only after it held for a minute, so a workflow that has not registered yet is not mistaken for no checks. Checks `checksRead` (passing or none) and `verifiedBeforePublishing` (a passing Jevellan verification of the pull request's head commit). Failing checks stop the journey; it never merges failing work.
6. **The merge happens from the Projects page:** the pull request's Merge button, then Merge in the `Squash and merge #n?` confirmation. The runner records the page's own `POST .../pr/merge` answer. Check `mergedFromThePage`. Screenshots `pull-request` and `merge`.
7. **The thread concludes.** Checks `threadDone` (done, pull request merged), `worktreeRemoved`, `localBranchRemoved` and `checkoutUntouched` (the clone's HEAD and status are the same as before).
8. **GitHub's own record:** `mergedOnGitHub` (merged into main), `addedFileWithTest` (an added source file and a test file) and `noTrailers` (no attribution trailers in the pull request's commits).
9. **Coordinator and browser:** `oneThread`, `coordinatorOnCodex` (a completed coordinator turn on Codex) and `noBrowserErrors`. Screenshots `concluded` and `phone` (390 x 844). Every turn launch is recorded without secrets: owner, runtime, permissions, model, effort, account id, resumed and status.

**Redaction.** Evidence passes through the hub redactor and replaces every credential with `[redacted]`. Because the secret scanner blocks the exact bytes of every `JEVELLAN_TEST_*` value, the repository name appears as `[repository]`, so pull request URLs read `https://github.com/[repository]/pull/n`. Identifiers shaped like native session ids are omitted. The runner asserts that no credential and no repository name reached the file before it writes it.

## Historical verification on goncalos-macbook-pro (2026-10-05)

- **Real, blocked run:** the command above, with no `JEVELLAN_TEST_*` variable set, wrote the receipt and exited 0. Nothing else was created.
- **Real, receipt cases** (scratch output directories, fixture values that are not credentials): ENV-GITHUB alone blocks when only the token is missing, and the receipt shows the other variables as `present` without their values. A repository given as a URL, `a/b.git`, `a/b/c`, `a/..` or with a space is `invalid` and blocks. An existing `--output` directory is refused (exit 1). `--home` is never created in a blocked run.
- **Real, start of the live path** with fixture values: the option checks passed and the run reached the repository read, which GitHub answered with 401 for the fixture token. The evidence was written with label `live`, `passed: false`, the error and `[repository]` in place of the name, and contained none of the fixture values. `--home` was not created, no Git configuration was written, and the run exited 1. This sent one request with a fixture token to api.github.com.
- **Real, Git credential isolation** in a scratch home with a fixture value for a fake host (`jevellan-test.invalid`), through the same Git calls as the runner: the helper list is `osxkeychain`, empty, `cache ...`. A traced `git credential fill` consulted only `credential-cache`. A store went only to the cache (nothing reached the keychain), the cache answered it, and `credential-cache exit` stopped it.
- **Real, conversation journeys unchanged:** `live-conversation-journeys.mjs` is byte-identical to the previous `live-journeys.mjs`. Through the dispatcher, J1 without options, an unknown journey, a port outside 9871-9879 and missing credentials fail with the same messages and exit codes as running the moved file directly.
- **Not run:** everything after the GitHub read. That covers the Codex and Claude turns, Jev placement, the push, the pull request, its checks, the merge, the screenshots and the vision checks.

## Limits

- The live path follows the routes, page controls and schemas that PJ1, PJ3 and the live conversation journeys exercise, but it has never run past the GitHub read. Its first live run may need fixes in the runner itself.
- GitHub's documentation for fine-grained tokens lists the merge endpoint (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) under Contents write and the combined status endpoint (`GET /repos/{owner}/{repo}/commits/{ref}/status`, which Jevellan reads beside check runs) under Commit statuses read. The Settings help line for the GitHub token now names these permissions too (REPORT decision 579, a deliberate deviation from the specification's line, which named only Pull requests read and write, Contents read and Checks read). It is unverified until a live run.
- The journey merges into the disposable repository's main and leaves its `jv/` branch on GitHub (remote branches are never deleted, a non-goal). Reruns need a new `--home`, `--sandbox` and `--output`; the repository can be reused.
- One device: the second-device parts of Projects stay simulated (DEVICE).
