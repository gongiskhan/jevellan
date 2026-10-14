# Prior live scenarios — 14 October 2026

Owner actions remain in the single ordered list at the top of [the activation handoff](/Users/ggomes/dev/jevellan/docs/acceptance/loop-activation.md). No new credentials or sign-ins are requested.

Evidence: **live**. Owner acceptance: **not claimed**. Original first scenario: 2026-10-13T18:15:59.903Z. New-scenario stop: 2026-10-14T04:15:59.903Z.

## Current gates

- A/B consecutive pairs: 0/2.
- C consecutive passes: 2/2.
- D qualified layouts: phone-light, phone-dark, desktop-light, desktop-dark. [D-matrix-passed.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-matrix-passed.json)

The original receipts stay unchanged. Historical C/D failures are superseded by their qualified passing gates; the eighth D setup-only passes remain explicitly withdrawn.

## Every retained failed assertion

| Scenario | Step | Assertion | Receipt | Current gate |
| --- | --- | --- | --- | --- |
| A | A1 | Exactly two owner-request tasks, both named in the reply; both active with Jev placement within ten minutes. | [A-run_ac984a21f87540febdc44c69c4073e00.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/A-run_ac984a21f87540febdc44c69c4073e00.json) | unpassed |
| A | A3 | A failed result check is diagnosed through its job log and CHANGELOG message; both PRs merge within 45 minutes; the rounding regression fails at baseline. | [A-run_5053b441bb2d4a0b8176008d5c88985d.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/A-run_5053b441bb2d4a0b8176008d5c88985d.json) | unpassed |
| C | C4 | A real Codex thread compacts without rotating, receives Task, Project memory and Project now after compaction, and reaches done. | [C-run_7ed9f3cb5ec8472fad9c91661e1e61c5.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/C-run_7ed9f3cb5ec8472fad9c91661e1e61c5.json) | later passed |
| C | C4 | A real Codex thread compacts without rotating, receives Task, Project memory and Project now after compaction, and reaches done. | [C-run_508dab527f2f42c48b2987ce139ff9f7.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/C-run_508dab527f2f42c48b2987ce139ff9f7.json) | later passed |
| C | C4 | A real Codex thread compacts without rotating, receives Task, Project memory and Project now after compaction, and reaches done. | [C-run_d7afb32303944840ba59422c6171ac16.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/C-run_d7afb32303944840ba59422c6171ac16.json) | later passed |
| D phone-light | D6 | The copy buttons include exactly the requested command range and strip every escape code. | [D-run_c37da2a2348f46f08383ae5c2f00703a.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/D-run_c37da2a2348f46f08383ae5c2f00703a.json) | later passed |
| D phone-light | D1 | The Pro project terminal opens in its registered dedicated checkout. | [D-run_4e0ed15f7ce54a8a9d7da8c818846db9.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/D-run_4e0ed15f7ce54a8a9d7da8c818846db9.json) | later passed |
| D phone-light | D6 | The copy buttons include exactly the requested command range and strip every escape code. | [D-run_02e516b8c9454b7e92e3c3bdd3a65090.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/D-run_02e516b8c9454b7e92e3c3bdd3a65090.json) | later passed |
| D phone-light | D1 | The Pro project terminal opens in its registered dedicated checkout. | [D-run_6bf3f9a768ba4aa4aa81ff77da7e13e9.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-13/D-run_6bf3f9a768ba4aa4aa81ff77da7e13e9.json) | later passed |
| D phone-light | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_fa72422d3cb44d30b9b71fa88d99ced9.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_fa72422d3cb44d30b9b71fa88d99ced9.json) | later passed |
| D phone-light | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_fe1a087a5af84289b1188f4f9ac4faae.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_fe1a087a5af84289b1188f4f9ac4faae.json) | later passed |
| D phone-light | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_1bb817b2d1874988bbb06d6e5587f028.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_1bb817b2d1874988bbb06d6e5587f028.json) | later passed |
| D desktop-light | D9 | Every captured screen passes the dedicated live vision rubric in this layout. | [D-run_2a6ebd4de81545c883ded96d4d3dc9aa.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_2a6ebd4de81545c883ded96d4d3dc9aa.json) | later passed |
| D phone-light | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_01a49ce65e58450eabcc549f4bdafa8a.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_01a49ce65e58450eabcc549f4bdafa8a.json) | later passed |
| D phone-dark | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_e9b04fe79b9f4927a11e96323be82ff1.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_e9b04fe79b9f4927a11e96323be82ff1.json) | later passed |
| D phone-dark | D8 | Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan. | [D-run_7e6c3d0e88594c8d9c8258cecb83129d.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_7e6c3d0e88594c8d9c8258cecb83129d.json) | later passed |
| D desktop-light | D9 | Every captured screen passes the dedicated live vision rubric in this layout. | [D-run_66c9ca8cc55f4443bcf88d4e60e7083e.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/D-run_66c9ca8cc55f4443bcf88d4e60e7083e.json) | later passed |
| A | A3 | A failed result check is diagnosed through its job log and CHANGELOG message; both PRs merge within 45 minutes; the rounding regression fails at baseline. | [A-run_3c899b05bc5946c7a346d06ef377d8f1.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/A-run_3c899b05bc5946c7a346d06ef377d8f1.json) | unpassed |

Full original failure reasons and timings are preserved in each receipt and in [prior-live-closing.json](/Users/ggomes/dev/jevellan/docs/acceptance/scenarios/2026-10-14/prior-live-closing.json).

## Unrun steps

- A4: The latest exact A ended before this step; retain its failed assertion.
- A5: The latest exact A ended before this step; retain its failed assertion.
- A6: The latest exact A ended before this step; retain its failed assertion.
- A7: The latest exact A ended before this step; retain its failed assertion.
- A8: The latest exact A ended before this step; retain its failed assertion.
- A9: The latest exact A ended before this step; retain its failed assertion.
- A10: The latest exact A ended before this step; retain its failed assertion.
- A11: The latest exact A ended before this step; retain its failed assertion.
- B1: B requires the successful A state; no successful A receipt exists.
- B2: B requires the successful A state; no successful A receipt exists.
- B3: B requires the successful A state; no successful A receipt exists.
- B4: B requires the successful A state; no successful A receipt exists.
- B5: B requires the successful A state; no successful A receipt exists.

The requested non-gating Codex Sol coordinator run is blocked by model availability. Optional Ekoa mirror checks are blocked by unsupported OAuth/PKCE/refresh. These are not missing-credential passes.

## Runtime usage

Costs below are cumulative runtime estimates from the receipts, not invoices. Missing prices remain unknown; session minutes may overlap.

| Runtime | Input tokens | Output tokens | Known estimated USD | Sessions with unknown cost | Session minutes |
| --- | ---: | ---: | ---: | ---: | ---: |
| claude | 2442102 | 1372500 | 149.344444 | 0 | 61.62 |
| codex | 12619825 | 130362 | 0.000000 | 18 | 80.41 |

## Verification boundaries

The full Linux backend result remains failed. The targeted Mac comparison is separate; the quiet full Pro baseline has its own immutable source receipt. Browser/provider simulation, live vision, real-provider scenarios and physical-phone acceptance remain separate claims.

Cache/journal implementation starts only after this prior live window closes. Its build and live clocks are recorded separately; the owner-selected release is 0.3.4.
