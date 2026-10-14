# Terminal startup record correction

Decision803 refines decision732. Owner acceptance is not claimed.

Live: the fourth phone-light D fails its unchanged D1 assertion in [the original receipt](scenarios/2026-10-13/D-run_6bf3f9a768ba4aa4aa81ff77da7e13e9.json). A subsequent read-only snapshot shows two records for one pwd entered during startup:

| Record | Approximate | Output | Exit | Ended UTC |
| --- | --- | --- | --- | --- |
| 0 | yes | pwd echo only | 0 | 23:48:32.089 |
| 1 | no | actual dedicated checkout path | 0 | 23:48:32.119 |

The first shell prompt completes the inferred echo record before the real command's semantic start arrives. The recorder now knows when the launched shell supports integration and waits for its own boundaries. Input and Ctrl-C still reach the shell during startup. Unsupported shells and nested SSH retain approximate records.

Simulated: delayed-start real disposable Bash/zsh tests both reproduce duplicate records before repair. All48 affected cases in four files pass afterwards, including unsupported shells, SSH, hidden input, multiline owner actions, restart, relay and clipboard coverage. Fixture shell files are byte-identical after execution. Typecheck, lint and build pass. The clipboard harness's initial typecheck also catches an untyped test predicate; its explicit string type passes the rerun.

Not run yet: private-profile activation and a complete new D run. Installed Pro0.3.3, member installations and source releases stay unchanged; no native home or owner checkout is edited.


Decision803 affected-browser closure: CM5 passes all4 layouts with simulated providers, actual disposable PTYs/relay and16 current dedicated live vision judgments, all clear. The versioned terminal-browser-803.json receipt validates every screenshot hash and marks ownerAcceptance false. The first isolated browser attempt had an incorrect fixture working directory and started no tests; its separate failed setup log remains private. Real phone D1–D7 pass on both corrected private daemons; full real D remains pending the original D8 timeout and corrected setup rerun. The overloaded full-run results remain interrupted and are not promoted by these four affected passes.
