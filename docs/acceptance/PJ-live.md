# PJ-live - a live coordinator thread to a merged pull request

**Evidence label: blocked.** On 2026-10-05 (goncalos-macbook-pro), `node scripts/spikes/live-journeys.mjs --journey PJ-live` found none of its credentials. It wrote the blocked receipt [PJ-live.json](PJ-live.json) and exited 0. It created no Jevellan home and started no daemon, browser or clone. A blocked journey is not a pass. PJ-live has not run live, nothing below claims a live result, and the owner's acceptance is not claimed.

| ID | Required | Why the journey is blocked here |
| --- | --- | --- |
| ENV-JEV | yes | `JEVELLAN_TEST_JEV_KEY` is not set, so placement cannot ask the real Jev. |
| ENV-CODEX | yes | `JEVELLAN_TEST_CODEX_KEY` is not set, so no real Codex account can run the coordinator or the thread. |
| ENV-GITHUB | yes | `JEVELLAN_TEST_GITHUB_TOKEN` and `JEVELLAN_TEST_GITHUB_REPO` are not set, so there is no disposable GitHub repository for the pull request. |
| ENV-CLAUDE | no | `JEVELLAN_TEST_CLAUDE_TOKEN` is not set. A live run would keep Claude off and run Codex alone; the vision checks need this token too. |

The receipt uses the `live-journey-v2` document: the `live-journey-v1` fields of the conversation journeys plus a `blocked` label, `blockedBy` (the required credentials, each with its REPORT blocker ID and a reason), `optionalMissing` (ENV-CLAUDE) and `variables`, which records only `present`, `missing` or `invalid` per variable, never a value. The blocker rows are in [REPORT.md](REPORT.md#blockers-and-historical-attempts).

## What the specification asks

BRIEF-projects.md section 13, phase 8 (local and untracked, like BRIEF.md): a live journey through `scripts/spikes/live-journeys.mjs --journey PJ-live` with a real Codex account and, if present, a real Claude token, real Jev, and a disposable GitHub repository given by `JEVELLAN_TEST_GITHUB_TOKEN` and `JEVELLAN_TEST_GITHUB_REPO`. The coordinator starts a thread that adds a small file with a test, the pull request opens, the checks state is read, and the merge happens from the interface. Missing credentials make the journey blocked, never passed.

## Credentials

Every value is read once, before anything else runs, and every `JEVELLAN_TEST_*` variable is then removed from the runner's environment. No agent, worker or Git process inherits one. Jevellan receives the values only through its own API, into the encrypted vault, as for the conversation journeys.

| Variable | Receipt ID | What it is | How it enters Jevellan |
| --- | --- | --- | --- |
| `JEVELLAN_TEST_JEV_KEY` | ENV-JEV | The dedicated Jev key. | `PUT /hub/secrets/jev`. |
| `JEVELLAN_TEST_CODEX_KEY` (new) | ENV-CODEX | An OpenAI API key of a dedicated test project. | `POST /hub/accounts` as a Codex API-key account with paid use `always`. Jevellan logs Codex in to the account's own home (`codex login --with-api-key`). |
| `JEVELLAN_TEST_GITHUB_TOKEN` | ENV-GITHUB | A fine-grained token for the disposable repository only, with Contents read and write, Pull requests read and write, Checks read and Commit statuses read. | `PUT /hub/secrets/github` (Jevellan's GitHub token) and, for Git pushes, an in-memory credential cache of the isolated user home (below). |
| `JEVELLAN_TEST_GITHUB_REPO` | ENV-GITHUB | `owner/repository` of the disposable repository. Any other form is `invalid`, which also blocks. | Cloned by the runner; never written to evidence (see Redaction). |
| `JEVELLAN_TEST_CLAUDE_TOKEN` | ENV-CLAUDE (optional) | The dedicated Claude token. | `POST /hub/accounts` as a Claude subscription. Claude is enabled only when it is present. |

Why the Codex credential is an API key: before this step no variable existed for a live Codex credential. A Codex subscription sign-in belongs to a device and cannot be given as a value (`add-account-v1` refuses a Codex subscription secret). The earlier live Codex runs used a prepared account home that was moved, never copied, and that is not reproducible from a variable. An API-key account is a real Codex account in Jevellan, enters through the same product API as the other test credentials, and keeps the key in the vault and the account's runtime authentication file only.

The disposable repository must have `main` as its default branch and a root `package.json` named `jevellan-acceptance-sandbox` whose `npm test` needs no install (for example `node --test`). The journey merges a pull request into its main, so it must never be a repository that matters. The runner never changes any repository's visibility.

## Running it

- Blocked check: `node scripts/spikes/live-journeys.mjs --journey PJ-live [--output <new directory>]` writes `docs/acceptance/PJ-live.json` (or `<output>/evidence.json`) and exits 0 when a required credential is missing.
- Live run: `node scripts/spikes/live-journeys.mjs --journey PJ-live --home <new directory> --user-home <directory> --sandbox <new path> --output <new directory> --port <9871-9879>`, after `npm run build`. It writes `<output>/evidence.json` and six screenshots. It exits 1 when any check fails or the journey stops on an error. Judge the screenshots afterwards with `node --import tsx scripts/spikes/live-vision.mjs <output>` (needs `JEVELLAN_TEST_CLAUDE_TOKEN`).

`live-journeys.mjs` now only dispatches: PJ-live runs from `scripts/spikes/live-projects-journey.mjs`. The conversation journeys (J1, J2, J4, J5, J6, J7-off, J7-on, J13) moved unchanged, byte for byte, to `scripts/spikes/live-conversation-journeys.mjs`. An ES module cannot return early from its top level, so the move is what lets the blocked receipt start nothing.

## What a live run does and checks

1. **Isolation.** Before Jevellan starts, the runner reads the repository with the test token (default branch `main`, not archived). It then writes the isolated user home's Git configuration: an empty `credential.helper` resets every inherited helper, then `credential-cache` keeps the token in memory behind a private socket. Homebrew Git's system configuration on this machine names `osxkeychain`, the owner's keychain, so the reset matters, and the runner asserts that no inherited helper is left. The runner clones `https://github.com/<repository>.git` into the new `--sandbox` path and checks the marker, the origin and `main`. It sets a test commit identity in the clone. It then points `HOME` at the isolated user home and drops `SSH_AUTH_SOCK`, `GH_TOKEN` and `GITHUB_TOKEN`, so Jevellan's own Git never reaches the owner's configuration, keychain, SSH agent or `gh` login. The repository visibility comes from the test token's read, not from `gh`.
2. **Setup through the product API.** Jev key, GitHub token and Codex key go into the vault, plus the Claude token when present. Codex is enabled and Claude only with its token. The project `live_projects` uses external branch policy (Jevellan never publishes to main itself, so the thread works in a worktree and opens a pull request), `npm test` and device memory. The coordinator is pinned to the first enabled Codex model, so the Codex account always works; Jev places the thread on any enabled model. One running thread at a time. Global timers stay off, so no improver spends Jev or model calls. The Projects loops run (pull request polls every 15 seconds), and the runner sends this device's heartbeat every minute because placement reads it.
3. **The owner's request** goes through the Projects page composer: "Start one thread for this: add a small file with one exported function that returns a greeting for a name, and a test for that function that npm test runs. Keep the change to those two files. I will review and merge the pull request myself." Checks `coordinatorStartedThread` (the thread's owner-local record says the coordinator created it) and `worktreeIsolation`. Screenshot `chat`.
4. **The pull request opens.** Checks `pullRequestOpened` (open, on a `jv/` branch) and `jevPlaced` (placement source `jev` with Jev calls recorded). The placement record goes into the evidence. A thread that waits for the owner or ends without a pull request stops the journey with its reason, as does a thread left idle for ten minutes on a blocked report Jevellan wrote for it (a failed push, pull request or turn) that the coordinator did not act on. Screenshot `thread`.
5. **The checks state is read** by Jevellan from GitHub through `pr/refresh`. `none` counts only after it held for a minute, so a workflow that has not registered yet is not mistaken for no checks. Checks `checksRead` (passing or none) and `verifiedBeforePublishing` (a passing Jevellan verification of the pull request's head commit). Failing checks stop the journey; it never merges failing work.
6. **The merge happens from the Projects page:** the pull request's Merge button, then Merge in the `Squash and merge #n?` confirmation. The runner records the page's own `POST .../pr/merge` answer. Check `mergedFromThePage`. Screenshots `pull-request` and `merge`.
7. **The thread concludes.** Checks `threadDone` (done, pull request merged), `worktreeRemoved`, `localBranchRemoved` and `checkoutUntouched` (the clone's HEAD and status are the same as before).
8. **GitHub's own record:** `mergedOnGitHub` (merged into main), `addedFileWithTest` (an added source file and a test file) and `noTrailers` (no attribution trailers in the pull request's commits).
9. **Coordinator and browser:** `oneThread`, `coordinatorOnCodex` (a completed coordinator turn on Codex) and `noBrowserErrors`. Screenshots `concluded` and `phone` (390 x 844). Every turn launch is recorded without secrets: owner, runtime, permissions, model, effort, account id, resumed and status.

**Redaction.** Evidence passes through the hub redactor and replaces every credential with `[redacted]`. Because the secret scanner blocks the exact bytes of every `JEVELLAN_TEST_*` value, the repository name appears as `[repository]`, so pull request URLs read `https://github.com/[repository]/pull/n`. Identifiers shaped like native session ids are omitted. The runner asserts that no credential and no repository name reached the file before it writes it.

## What was verified on this machine

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
