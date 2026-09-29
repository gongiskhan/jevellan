# Saved decision cases

`decision-cases-v1.json` contains 27 hand-written engineering fixtures, each with a complete versioned state packet and acceptable actions, models and requested efforts. Several choices may be acceptable. These fixtures are regression checks, not a benchmark or claims about model quality.

The evaluator uses the ordinary two-call decision engine. It replaces the saved routing profile and effort guide with the configuration under examination, and uses that configuration's menu descriptions, including the current model's description. Expected answers never enter Jev's request.

Model availability is fixed by each case with synthetic ready accounts; no account login or generative runtime is used. This isolates routing guidance from changing credentials and subscription quota. A model missing from the configuration blocks the evaluation rather than silently replacing it. Models declared available by a fixture participate even when disabled on the machine.

Run `npm run eval:decisions` with the dedicated `JEVELLAN_TEST_JEV_KEY` to evaluate the seed configuration using real Jev. Optional arguments are `--configuration path/to/apm.yml` and `--proposed path/to/proposed.yml`. The latter checks every case against both configurations. The command prints versioned JSON evidence; a missing key exits as blocked and never becomes a pass. It does not change configuration or read native agent credentials.

Each case passes only when its chosen action and, where applicable, model and requested effort are all acceptable. A before/after comparison calls a case better when it changes from failing to passing, worse for the reverse, and unchanged when acceptability stays the same. Both choices remain recorded, including changes between two acceptable alternatives. Request and returned model metadata are retained. Simulated unit tests validate this machinery; they do not establish the live choices Jev will make.
