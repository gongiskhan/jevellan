# Real scenario harness

Run from the Jevellan checkout:

```sh
node scripts/live/scenarios.mjs --scenario all --coordinator claude --config /private/live-config.json
```

Individual runs accept A, B, C or D. D runs all four layouts unless --layout is supplied. Codex all runs only the prescribed non-gating A. --failing-suite runs the extra B failure case, after a successful A. The default real sequence is A/B twice, C twice, D in four layouts, an extra non-gating A followed by failing B, and Codex A. A/B pairs remain consecutive; the extra A preserves B's state after reset scenarios.

The private config uses live-scenarios-config-v1: hub, storageState, stateFile, repository (always gongiskhan/jevellan-live-sandbox), proDeviceId, madridDeviceId, proCheckout, madridCheckout, madridHost, madridNode and hubHome. Optional output changes the receipt folder; ekoaLabel enables the optional mirror assertion. Checkout paths must be dedicated Jevellan project clones. storageState is Playwright state from a real owner UI sign-in, stored outside git with mode 600. Never put a passphrase or token in arguments/config/evidence. Scoped tokens stay in Settings. Dedicated Jev/vision credentials use JEVELLAN_TEST_JEV_KEY and JEVELLAN_TEST_CLAUDE_TOKEN, supplied ephemerally by the test runner.

Preparation is automatic after read-only preflight succeeds. It seeds the real Node20 invoices/customers app and workflows, creates sandbox-baseline and sets only the sandbox scheduler variable. Ekoa CI and its switch are untouched. The app contains the specified rounding bug, undocumented TZ and customer-data requirements, required CHANGELOG check and reserved owner script. Reset closes sandbox PRs, removes non-main branches and restores that tag; clean dedicated clones and stopped prior work are required. Earlier Jevellan histories remain retained under prior logical project ids.

B/C use real accounts and GitHub on an uninstalled disposable hub/member profile. NODE_ENV=test, JEVELLAN_TEST_COMPACT_PERCENT=20 and JEVELLAN_TEST_NIGHTLY_FIX_MINUTES=30 are test-only inputs. Both are refused when install.json exists; never set them on the installed production service. The configured production behavior stays 70 percent and a 150-minute cutoff. Scenario C asserts the actual threshold and unchanged native session key; a missing compaction fails rather than being simulated.

Receipts are live-scenario-receipt-v1 under date/scenario-run.json. Every step includes its assertion, verdict, timeout reason and sanitized evidence. Full owner messages/replies, tool arguments and redacted prompt excerpts explain failures. Tokens/cost come from runtime outcomes, grouped by session/provider; unknown values remain explicit. The private state atomically retains the first real start time. Missing inputs leave zero elapsed scenario time. After ten hours no new scenario starts; the in-progress one finishes. Product failures stop the run and require a product fix plus rerun from the start. No assertion is weakened or owner message supplemented with hints.

A5's page-size PR assertion and A6's immediate cancellation are both retained. If cancellation prevents publication, the harness records that exact failing assertion instead of waiving it. Phone-width Playwright and live vision evidence do not claim physical iOS acceptance.

Current real runs are blocked on the owner's pending activation/sign-in/join/Settings inputs. Blocked receipts have no live start, no usage and no acceptance claim. Unit/integration harness checks use simulated fixtures.
