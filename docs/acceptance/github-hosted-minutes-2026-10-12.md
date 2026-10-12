# Ekoa GitHub-hosted minutes: last 14 days

Live read-only API collection for gongiskhan/ekoa-code. Runs created from **2026-09-28T10:28:35.820Z** through **2026-10-12T10:28:35.820Z** (UTC). 850 unique runs, 4818 jobs including rerun attempts, 0 collection errors. No CI, scheduler variable, runner or production setting changed.

Observed GitHub-hosted job execution: **19,469.68 minutes**. macos-15: **33.72 minutes**. Pull-request events on hosted runners: **13,055.40 minutes**.

These are elapsed job minutes derived from started_at/completed_at, clipped to the report interval, not billed invoice minutes. They exclude queue time, do not apply billing rounding or OS multipliers, and include failed/cancelled executions. A still-running job is measured only through the collection cutoff. Run selection is by creation within the interval; jobs of older runs that began inside it are outside this collection.

## By workflow and runner

| Workflow | Runner | Jobs | Observed minutes |
| --- | --- | ---: | ---: |
| ci | ubuntu-latest | 2840 | 14,941.33 |
| ci-full | ubuntu-latest | 1104 | 2,855.32 |
| PRs and Push to main Checks | ubuntu-latest | 95 | 900.47 |
| images | ubuntu-latest | 213 | 586.20 |
| deploy | ubuntu-latest | 42 | 129.18 |
| desktop launch probe | macos-15 | 1 | 20.28 |
| deploy | macos-15 | 2 | 13.43 |
| nightly | ubuntu-latest | 26 | 13.07 |
| mobile-responsive | ubuntu-latest | 1 | 6.02 |
| nightly-triage | ubuntu-latest | 4 | 2.52 |
| security-review-trial | ubuntu-latest | 3 | 1.42 |
| nightly-watchdog | ubuntu-latest | 6 | 0.45 |
| nightly-deploy | macos-15 | 1 | 0.00 |

## By workflow, job and runner

| Workflow | Job | Runner | Executions | Minutes | Example run |
| --- | --- | --- | ---: | ---: | --- |
| ci | per-pr | ubuntu-latest | 213 | 4,360.78 | [run 36544997644](https://github.com/gongiskhan/ekoa-code/actions/runs/36544997644) |
| ci-full | full | ubuntu-latest | 13 | 1,219.80 | [run 36515988250](https://github.com/gongiskhan/ekoa-code/actions/runs/36515988250) |
| PRs and Push to main Checks | result | ubuntu-latest | 95 | 900.47 | [run 37917689746](https://github.com/gongiskhan/ekoa-code/actions/runs/37917689746) |
| ci | security-gates | ubuntu-latest | 213 | 846.00 | [run 36544997644](https://github.com/gongiskhan/ekoa-code/actions/runs/36544997644) |
| ci | typecheck | ubuntu-latest | 191 | 824.82 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci-full | e2e | ubuntu-latest | 149 | 753.83 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | lint | ubuntu-latest | 191 | 624.63 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci | build | ubuntu-latest | 191 | 619.70 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci-full | unit | ubuntu-latest | 149 | 603.48 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (web) | ubuntu-latest | 91 | 402.13 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| images | build (api) | ubuntu-latest | 54 | 374.62 | [run 37600548702](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548702) |
| ci | tests (bridge canary) | ubuntu-latest | 89 | 256.83 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (clients/cortex-cli) | ubuntu-latest | 92 | 249.58 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (clients/bridge) | ubuntu-latest | 94 | 236.43 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (e2e (1 spec)) | ubuntu-latest | 42 | 230.90 | [run 37590051472](https://github.com/gongiskhan/ekoa-code/actions/runs/37590051472) |
| ci | tests (shard 2/4) | ubuntu-latest | 20 | 227.10 | [run 37504485560](https://github.com/gongiskhan/ekoa-code/actions/runs/37504485560) |
| ci | tests (shard 3/4) | ubuntu-latest | 20 | 206.15 | [run 37504485560](https://github.com/gongiskhan/ekoa-code/actions/runs/37504485560) |
| ci | tests (clients/desktop) | ubuntu-latest | 95 | 204.73 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| images | build (web) | ubuntu-latest | 54 | 203.73 | [run 37600548702](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548702) |
| ci | tests (clients/mcp-server) | ubuntu-latest | 70 | 198.12 | [run 37762659088](https://github.com/gongiskhan/ekoa-code/actions/runs/37762659088) |
| ci | tests (shard 4/4) | ubuntu-latest | 20 | 191.65 | [run 37504485560](https://github.com/gongiskhan/ekoa-code/actions/runs/37504485560) |
| ci | tests (shard 1/4) | ubuntu-latest | 20 | 191.53 | [run 37504485560](https://github.com/gongiskhan/ekoa-code/actions/runs/37504485560) |
| ci | tests (shared) | ubuntu-latest | 92 | 151.85 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (web 1/2) | ubuntu-latest | 22 | 114.97 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (web 2/2) | ubuntu-latest | 22 | 110.07 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci-full | mobile / mobile | ubuntu-latest | 12 | 82.80 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci-full | gates | ubuntu-latest | 149 | 82.35 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (api (15 files)) | ubuntu-latest | 19 | 79.83 | [run 37589300738](https://github.com/gongiskhan/ekoa-code/actions/runs/37589300738) |
| deploy | release | ubuntu-latest | 14 | 70.90 | [run 37131731685](https://github.com/gongiskhan/ekoa-code/actions/runs/37131731685) |
| ci | plan | ubuntu-latest | 191 | 70.58 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci | tests (e2e (3 specs)) | ubuntu-latest | 8 | 67.58 | [run 37803542277](https://github.com/gongiskhan/ekoa-code/actions/runs/37803542277) |
| ci | tests (api 2/8 (845 files)) | ubuntu-latest | 7 | 57.32 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 2/8 (849 files)) | ubuntu-latest | 5 | 54.87 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 3/4 (194 files)) | ubuntu-latest | 7 | 54.85 | [run 37772514596](https://github.com/gongiskhan/ekoa-code/actions/runs/37772514596) |
| ci | tests (api 7/8 (845 files)) | ubuntu-latest | 7 | 54.73 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 7/8 (849 files)) | ubuntu-latest | 5 | 53.78 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 1/4 (194 files)) | ubuntu-latest | 7 | 52.32 | [run 37772514596](https://github.com/gongiskhan/ekoa-code/actions/runs/37772514596) |
| ci | tests (api 3/4 (195 files)) | ubuntu-latest | 5 | 51.98 | [run 37788061602](https://github.com/gongiskhan/ekoa-code/actions/runs/37788061602) |
| ci | tests (api (16 files)) | ubuntu-latest | 15 | 51.43 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci | tests (api 4/4 (194 files)) | ubuntu-latest | 7 | 51.35 | [run 37772514596](https://github.com/gongiskhan/ekoa-code/actions/runs/37772514596) |
| ci | tests (api 1/8 (849 files)) | ubuntu-latest | 5 | 50.22 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 2/4 (194 files)) | ubuntu-latest | 7 | 49.70 | [run 37772514596](https://github.com/gongiskhan/ekoa-code/actions/runs/37772514596) |
| ci | tests (api 5/8 (845 files)) | ubuntu-latest | 7 | 49.50 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 4/8 (845 files)) | ubuntu-latest | 7 | 48.85 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 3/4 (183 files)) | ubuntu-latest | 6 | 48.78 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci-full | security | ubuntu-latest | 149 | 48.55 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (api 1/8 (845 files)) | ubuntu-latest | 7 | 47.65 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 1/4 (183 files)) | ubuntu-latest | 6 | 47.28 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (api 4/8 (849 files)) | ubuntu-latest | 5 | 47.13 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 1/4 (186 files)) | ubuntu-latest | 5 | 47.08 | [run 37851554409](https://github.com/gongiskhan/ekoa-code/actions/runs/37851554409) |
| ci | tests (e2e (5 specs)) | ubuntu-latest | 10 | 46.23 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 2/4 (183 files)) | ubuntu-latest | 6 | 45.90 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (api 6/8 (845 files)) | ubuntu-latest | 7 | 45.77 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 5/8 (849 files)) | ubuntu-latest | 5 | 45.55 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 3/8 (849 files)) | ubuntu-latest | 5 | 43.58 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 3/8 (845 files)) | ubuntu-latest | 7 | 43.47 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 3/4 (186 files)) | ubuntu-latest | 5 | 43.42 | [run 37851554409](https://github.com/gongiskhan/ekoa-code/actions/runs/37851554409) |
| ci | tests (api 8/8 (845 files)) | ubuntu-latest | 7 | 42.67 | [run 37732713397](https://github.com/gongiskhan/ekoa-code/actions/runs/37732713397) |
| ci | tests (api 1/4 (195 files)) | ubuntu-latest | 5 | 42.40 | [run 37788061602](https://github.com/gongiskhan/ekoa-code/actions/runs/37788061602) |
| ci | tests (api (23 files)) | ubuntu-latest | 6 | 41.75 | [run 37505376496](https://github.com/gongiskhan/ekoa-code/actions/runs/37505376496) |
| ci | tests (api 6/8 (849 files)) | ubuntu-latest | 5 | 41.40 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 4/4 (195 files)) | ubuntu-latest | 5 | 41.37 | [run 37788061602](https://github.com/gongiskhan/ekoa-code/actions/runs/37788061602) |
| ci | tests (api 4/4 (183 files)) | ubuntu-latest | 6 | 40.78 | [run 37589638891](https://github.com/gongiskhan/ekoa-code/actions/runs/37589638891) |
| ci | tests (api 8/8 (849 files)) | ubuntu-latest | 5 | 40.70 | [run 37739401313](https://github.com/gongiskhan/ekoa-code/actions/runs/37739401313) |
| ci | tests (api 2/4 (195 files)) | ubuntu-latest | 5 | 39.53 | [run 37788061602](https://github.com/gongiskhan/ekoa-code/actions/runs/37788061602) |
| ci | tests (api 2/4 (186 files)) | ubuntu-latest | 5 | 39.20 | [run 37851554409](https://github.com/gongiskhan/ekoa-code/actions/runs/37851554409) |
| ci | tests (e2e (2 specs)) | ubuntu-latest | 5 | 39.18 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci | tests (api 1/4 (237 files)) | ubuntu-latest | 5 | 39.05 | [run 37797244385](https://github.com/gongiskhan/ekoa-code/actions/runs/37797244385) |
| ci | tests (api 4/4 (186 files)) | ubuntu-latest | 5 | 38.53 | [run 37851554409](https://github.com/gongiskhan/ekoa-code/actions/runs/37851554409) |
| ci | tests (api 2/4 (237 files)) | ubuntu-latest | 5 | 37.57 | [run 37797244385](https://github.com/gongiskhan/ekoa-code/actions/runs/37797244385) |
| ci | tests (api 4/4 (237 files)) | ubuntu-latest | 5 | 36.82 | [run 37797244385](https://github.com/gongiskhan/ekoa-code/actions/runs/37797244385) |
| deploy | build-images | ubuntu-latest | 5 | 36.18 | [run 37131731685](https://github.com/gongiskhan/ekoa-code/actions/runs/37131731685) |
| ci | tests (api 3/4 (237 files)) | ubuntu-latest | 5 | 36.02 | [run 37797244385](https://github.com/gongiskhan/ekoa-code/actions/runs/37797244385) |
| ci | tests (api 3/5 (245 files)) | ubuntu-latest | 5 | 35.23 | [run 37548465627](https://github.com/gongiskhan/ekoa-code/actions/runs/37548465627) |
| ci | tests (api 2/3 (162 files)) | ubuntu-latest | 3 | 34.15 | [run 37810110385](https://github.com/gongiskhan/ekoa-code/actions/runs/37810110385) |
| ci | tests (api 4/5 (245 files)) | ubuntu-latest | 5 | 33.97 | [run 37548465627](https://github.com/gongiskhan/ekoa-code/actions/runs/37548465627) |
| ci-full | security-review / security-review-skill | ubuntu-latest | 12 | 32.62 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (api 3/3 (145 files)) | ubuntu-latest | 3 | 31.77 | [run 37762659088](https://github.com/gongiskhan/ekoa-code/actions/runs/37762659088) |
| ci | tests (api 3/3 (162 files)) | ubuntu-latest | 3 | 30.77 | [run 37810110385](https://github.com/gongiskhan/ekoa-code/actions/runs/37810110385) |
| ci | tests (api 2/5 (245 files)) | ubuntu-latest | 5 | 30.28 | [run 37548465627](https://github.com/gongiskhan/ekoa-code/actions/runs/37548465627) |
| ci | tests (api 3/4 (219 files)) | ubuntu-latest | 3 | 30.22 | [run 37828215713](https://github.com/gongiskhan/ekoa-code/actions/runs/37828215713) |
| ci | tests (api 3/6 (351 files)) | ubuntu-latest | 7 | 29.97 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 1/5 (245 files)) | ubuntu-latest | 5 | 29.82 | [run 37548465627](https://github.com/gongiskhan/ekoa-code/actions/runs/37548465627) |
| ci | tests (api 1/6 (351 files)) | ubuntu-latest | 7 | 29.78 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 5/6 (351 files)) | ubuntu-latest | 7 | 29.22 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 6/6 (351 files)) | ubuntu-latest | 7 | 29.08 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 1/8 (826 files)) | ubuntu-latest | 3 | 28.98 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 1/4 (219 files)) | ubuntu-latest | 3 | 28.75 | [run 37828215713](https://github.com/gongiskhan/ekoa-code/actions/runs/37828215713) |
| ci | tests (api 4/7 (394 files)) | ubuntu-latest | 5 | 28.67 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 1/3 (142 files)) | ubuntu-latest | 3 | 28.33 | [run 37517535809](https://github.com/gongiskhan/ekoa-code/actions/runs/37517535809) |
| ci | tests (api 2/6 (351 files)) | ubuntu-latest | 7 | 28.02 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 7/8 (826 files)) | ubuntu-latest | 3 | 27.95 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 4/6 (351 files)) | ubuntu-latest | 7 | 27.87 | [run 37874171930](https://github.com/gongiskhan/ekoa-code/actions/runs/37874171930) |
| ci | tests (api 2/3 (126 files)) | ubuntu-latest | 4 | 27.27 | [run 37662255038](https://github.com/gongiskhan/ekoa-code/actions/runs/37662255038) |
| ci | tests (api 4/8 (826 files)) | ubuntu-latest | 3 | 27.23 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 1/3 (162 files)) | ubuntu-latest | 3 | 27.22 | [run 37810110385](https://github.com/gongiskhan/ekoa-code/actions/runs/37810110385) |
| ci | tests (api 2/5 (253 files)) | ubuntu-latest | 3 | 27.08 | [run 37818188097](https://github.com/gongiskhan/ekoa-code/actions/runs/37818188097) |
| ci | tests (api 6/7 (394 files)) | ubuntu-latest | 5 | 27.07 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 3/5 (248 files)) | ubuntu-latest | 4 | 26.77 | [run 37811767463](https://github.com/gongiskhan/ekoa-code/actions/runs/37811767463) |
| ci | tests (api 5/5 (245 files)) | ubuntu-latest | 5 | 26.45 | [run 37548465627](https://github.com/gongiskhan/ekoa-code/actions/runs/37548465627) |
| ci | tests (api 2/8 (826 files)) | ubuntu-latest | 3 | 26.30 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 2/7 (394 files)) | ubuntu-latest | 5 | 26.18 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 5/8 (826 files)) | ubuntu-latest | 3 | 26.17 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 3/7 (394 files)) | ubuntu-latest | 5 | 25.97 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 3/4 (181 files)) | ubuntu-latest | 4 | 25.35 | [run 37546608314](https://github.com/gongiskhan/ekoa-code/actions/runs/37546608314) |
| ci | tests (api 4/4 (219 files)) | ubuntu-latest | 3 | 25.27 | [run 37828215713](https://github.com/gongiskhan/ekoa-code/actions/runs/37828215713) |
| ci | tests (api 7/7 (394 files)) | ubuntu-latest | 5 | 25.15 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 1/6 (352 files)) | ubuntu-latest | 3 | 25.03 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 2/3 (135 files)) | ubuntu-latest | 2 | 24.77 | [run 37582745192](https://github.com/gongiskhan/ekoa-code/actions/runs/37582745192) |
| ci | tests (api 4/5 (253 files)) | ubuntu-latest | 3 | 24.65 | [run 37818188097](https://github.com/gongiskhan/ekoa-code/actions/runs/37818188097) |
| ci | tests (api 2/3 (127 files)) | ubuntu-latest | 3 | 24.60 | [run 37747491585](https://github.com/gongiskhan/ekoa-code/actions/runs/37747491585) |
| ci | tests (api 5/7 (394 files)) | ubuntu-latest | 5 | 24.60 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api 3/5 (253 files)) | ubuntu-latest | 3 | 24.48 | [run 37818188097](https://github.com/gongiskhan/ekoa-code/actions/runs/37818188097) |
| ci | tests (api 1/5 (248 files)) | ubuntu-latest | 4 | 24.30 | [run 37811767463](https://github.com/gongiskhan/ekoa-code/actions/runs/37811767463) |
| ci-full | scope | ubuntu-latest | 149 | 24.28 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (api 1/7 (394 files)) | ubuntu-latest | 5 | 24.25 | [run 37708282611](https://github.com/gongiskhan/ekoa-code/actions/runs/37708282611) |
| ci | tests (api (19 files)) | ubuntu-latest | 6 | 24.18 | [run 37510147342](https://github.com/gongiskhan/ekoa-code/actions/runs/37510147342) |
| ci | tests (api 3/3 (160 files)) | ubuntu-latest | 2 | 24.13 | [run 37789419689](https://github.com/gongiskhan/ekoa-code/actions/runs/37789419689) |
| ci | tests (api 1/4 (181 files)) | ubuntu-latest | 4 | 24.07 | [run 37546608314](https://github.com/gongiskhan/ekoa-code/actions/runs/37546608314) |
| ci | tests (api 6/8 (826 files)) | ubuntu-latest | 3 | 24.07 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 2/3 (145 files)) | ubuntu-latest | 3 | 23.95 | [run 37762659088](https://github.com/gongiskhan/ekoa-code/actions/runs/37762659088) |
| ci | tests (api 4/5 (248 files)) | ubuntu-latest | 4 | 23.87 | [run 37811767463](https://github.com/gongiskhan/ekoa-code/actions/runs/37811767463) |
| ci | tests (api 5/5 (248 files)) | ubuntu-latest | 4 | 23.33 | [run 37811767463](https://github.com/gongiskhan/ekoa-code/actions/runs/37811767463) |
| ci | tests (api 1/3 (163 files)) | ubuntu-latest | 3 | 23.30 | [run 37791749792](https://github.com/gongiskhan/ekoa-code/actions/runs/37791749792) |
| ci | tests (api 2/5 (248 files)) | ubuntu-latest | 4 | 23.22 | [run 37811767463](https://github.com/gongiskhan/ekoa-code/actions/runs/37811767463) |
| ci | tests (api 2/4 (181 files)) | ubuntu-latest | 4 | 22.87 | [run 37546608314](https://github.com/gongiskhan/ekoa-code/actions/runs/37546608314) |
| ci | tests (api 2/3 (163 files)) | ubuntu-latest | 3 | 22.13 | [run 37791749792](https://github.com/gongiskhan/ekoa-code/actions/runs/37791749792) |
| ci | tests (api 3/8 (826 files)) | ubuntu-latest | 3 | 21.92 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 3/3 (163 files)) | ubuntu-latest | 3 | 21.65 | [run 37791749792](https://github.com/gongiskhan/ekoa-code/actions/runs/37791749792) |
| ci | tests (api 2/3 (153 files)) | ubuntu-latest | 2 | 21.50 | [run 37794244668](https://github.com/gongiskhan/ekoa-code/actions/runs/37794244668) |
| ci | tests (api 4/6 (352 files)) | ubuntu-latest | 3 | 21.48 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 2/3 (141 files)) | ubuntu-latest | 2 | 21.13 | [run 37812158147](https://github.com/gongiskhan/ekoa-code/actions/runs/37812158147) |
| ci | tests (api 1/3 (145 files)) | ubuntu-latest | 3 | 20.75 | [run 37762659088](https://github.com/gongiskhan/ekoa-code/actions/runs/37762659088) |
| deploy | resolve | ubuntu-latest | 14 | 20.68 | [run 37131731685](https://github.com/gongiskhan/ekoa-code/actions/runs/37131731685) |
| ci | tests (api 1/3 (143 files)) | ubuntu-latest | 2 | 20.67 | [run 37655372767](https://github.com/gongiskhan/ekoa-code/actions/runs/37655372767) |
| ci | tests (api 2/3 (160 files)) | ubuntu-latest | 2 | 20.65 | [run 37789419689](https://github.com/gongiskhan/ekoa-code/actions/runs/37789419689) |
| desktop launch probe | probe | macos-15 | 1 | 20.28 | [run 38165596884](https://github.com/gongiskhan/ekoa-code/actions/runs/38165596884) |
| ci | tests (api 2/4 (219 files)) | ubuntu-latest | 3 | 20.18 | [run 37828215713](https://github.com/gongiskhan/ekoa-code/actions/runs/37828215713) |
| ci | tests (api 2/3 (143 files)) | ubuntu-latest | 2 | 20.10 | [run 37655372767](https://github.com/gongiskhan/ekoa-code/actions/runs/37655372767) |
| ci | tests (api 4/4 (181 files)) | ubuntu-latest | 4 | 19.97 | [run 37546608314](https://github.com/gongiskhan/ekoa-code/actions/runs/37546608314) |
| ci | tests (api 6/6 (352 files)) | ubuntu-latest | 3 | 19.95 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 2/6 (352 files)) | ubuntu-latest | 3 | 19.77 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 5/5 (253 files)) | ubuntu-latest | 3 | 19.77 | [run 37818188097](https://github.com/gongiskhan/ekoa-code/actions/runs/37818188097) |
| ci | tests (api 5/6 (352 files)) | ubuntu-latest | 3 | 19.70 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 2/3 (138 files)) | ubuntu-latest | 2 | 19.57 | [run 37629850051](https://github.com/gongiskhan/ekoa-code/actions/runs/37629850051) |
| ci | tests (api 1/3 (141 files)) | ubuntu-latest | 2 | 19.57 | [run 37812158147](https://github.com/gongiskhan/ekoa-code/actions/runs/37812158147) |
| ci | tests (api 3/6 (352 files)) | ubuntu-latest | 3 | 19.10 | [run 37883643720](https://github.com/gongiskhan/ekoa-code/actions/runs/37883643720) |
| ci | tests (api 1/5 (253 files)) | ubuntu-latest | 3 | 19.05 | [run 37818188097](https://github.com/gongiskhan/ekoa-code/actions/runs/37818188097) |
| ci | tests (api 3/3 (141 files)) | ubuntu-latest | 2 | 19.05 | [run 37812158147](https://github.com/gongiskhan/ekoa-code/actions/runs/37812158147) |
| ci | tests (api 1/3 (160 files)) | ubuntu-latest | 2 | 19.02 | [run 37789419689](https://github.com/gongiskhan/ekoa-code/actions/runs/37789419689) |
| ci | tests (api 3/3 (138 files)) | ubuntu-latest | 2 | 18.90 | [run 37629850051](https://github.com/gongiskhan/ekoa-code/actions/runs/37629850051) |
| ci | tests (api 3/3 (143 files)) | ubuntu-latest | 2 | 18.75 | [run 37655372767](https://github.com/gongiskhan/ekoa-code/actions/runs/37655372767) |
| ci | tests (api 1/3 (153 files)) | ubuntu-latest | 2 | 18.63 | [run 37794244668](https://github.com/gongiskhan/ekoa-code/actions/runs/37794244668) |
| ci | tests (api 4/4 (200 files)) | ubuntu-latest | 2 | 18.62 | [run 37611604134](https://github.com/gongiskhan/ekoa-code/actions/runs/37611604134) |
| ci | tests (api 1/3 (138 files)) | ubuntu-latest | 2 | 18.48 | [run 37629850051](https://github.com/gongiskhan/ekoa-code/actions/runs/37629850051) |
| ci | tests (api 3/4 (208 files)) | ubuntu-latest | 2 | 18.17 | [run 37767321093](https://github.com/gongiskhan/ekoa-code/actions/runs/37767321093) |
| ci | tests (api 3/3 (135 files)) | ubuntu-latest | 2 | 18.05 | [run 37582745192](https://github.com/gongiskhan/ekoa-code/actions/runs/37582745192) |
| ci | tests (api 2/3 (142 files)) | ubuntu-latest | 3 | 17.83 | [run 37517535809](https://github.com/gongiskhan/ekoa-code/actions/runs/37517535809) |
| ci | tests (api 2/4 (200 files)) | ubuntu-latest | 2 | 17.82 | [run 37611604134](https://github.com/gongiskhan/ekoa-code/actions/runs/37611604134) |
| ci | tests (api 3/3 (153 files)) | ubuntu-latest | 2 | 17.55 | [run 37794244668](https://github.com/gongiskhan/ekoa-code/actions/runs/37794244668) |
| ci | tests (api 1/4 (200 files)) | ubuntu-latest | 2 | 17.40 | [run 37611604134](https://github.com/gongiskhan/ekoa-code/actions/runs/37611604134) |
| ci | tests (api 3/3 (142 files)) | ubuntu-latest | 3 | 17.28 | [run 37517535809](https://github.com/gongiskhan/ekoa-code/actions/runs/37517535809) |
| ci | tests (api (20 files)) | ubuntu-latest | 4 | 17.00 | [run 37510675526](https://github.com/gongiskhan/ekoa-code/actions/runs/37510675526) |
| ci | tests (api 1/3 (135 files)) | ubuntu-latest | 2 | 16.92 | [run 37582745192](https://github.com/gongiskhan/ekoa-code/actions/runs/37582745192) |
| ci | tests (api 1/4 (208 files)) | ubuntu-latest | 2 | 16.80 | [run 37767321093](https://github.com/gongiskhan/ekoa-code/actions/runs/37767321093) |
| ci | tests (api 4/4 (208 files)) | ubuntu-latest | 2 | 16.78 | [run 37767321093](https://github.com/gongiskhan/ekoa-code/actions/runs/37767321093) |
| ci | tests (api (45 files)) | ubuntu-latest | 3 | 16.60 | [run 37746133093](https://github.com/gongiskhan/ekoa-code/actions/runs/37746133093) |
| ci | tests (api 2/4 (208 files)) | ubuntu-latest | 2 | 16.47 | [run 37767321093](https://github.com/gongiskhan/ekoa-code/actions/runs/37767321093) |
| ci | tests (api 3/3 (126 files)) | ubuntu-latest | 4 | 15.52 | [run 37662255038](https://github.com/gongiskhan/ekoa-code/actions/runs/37662255038) |
| ci | tests (api 2/8 (860 files)) | ubuntu-latest | 1 | 14.80 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api (31 files)) | ubuntu-latest | 3 | 14.27 | [run 37791947556](https://github.com/gongiskhan/ekoa-code/actions/runs/37791947556) |
| ci | tests (api 3/4 (200 files)) | ubuntu-latest | 2 | 14.00 | [run 37611604134](https://github.com/gongiskhan/ekoa-code/actions/runs/37611604134) |
| ci | tests (api 1/3 (126 files)) | ubuntu-latest | 4 | 13.90 | [run 37662255038](https://github.com/gongiskhan/ekoa-code/actions/runs/37662255038) |
| ci | tests (api 8/8 (826 files)) | ubuntu-latest | 3 | 13.80 | [run 37514217294](https://github.com/gongiskhan/ekoa-code/actions/runs/37514217294) |
| ci | tests (api 3/3 (127 files)) | ubuntu-latest | 3 | 13.65 | [run 37747491585](https://github.com/gongiskhan/ekoa-code/actions/runs/37747491585) |
| deploy | desktop | macos-15 | 2 | 13.43 | [run 38212105370](https://github.com/gongiskhan/ekoa-code/actions/runs/38212105370) |
| ci | tests (api 2/2 (83 files)) | ubuntu-latest | 3 | 13.42 | [run 37753879812](https://github.com/gongiskhan/ekoa-code/actions/runs/37753879812) |
| ci | tests (api 1/3 (127 files)) | ubuntu-latest | 3 | 13.20 | [run 37747491585](https://github.com/gongiskhan/ekoa-code/actions/runs/37747491585) |
| ci | tests (api 1/8 (860 files)) | ubuntu-latest | 1 | 13.12 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 7/8 (860 files)) | ubuntu-latest | 1 | 12.72 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 7/8 (859 files)) | ubuntu-latest | 1 | 12.65 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 6/8 (859 files)) | ubuntu-latest | 1 | 12.60 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 1/2 (66 files)) | ubuntu-latest | 3 | 12.53 | [run 37543242795](https://github.com/gongiskhan/ekoa-code/actions/runs/37543242795) |
| ci | tests (api 1/8 (859 files)) | ubuntu-latest | 1 | 12.22 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 4/8 (859 files)) | ubuntu-latest | 1 | 12.18 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | result | ubuntu-latest | 191 | 12.03 | [run 37600548835](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548835) |
| ci | tests (api 4/8 (860 files)) | ubuntu-latest | 1 | 11.97 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 2/8 (859 files)) | ubuntu-latest | 1 | 11.97 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 5/8 (860 files)) | ubuntu-latest | 1 | 11.73 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 5/8 (859 files)) | ubuntu-latest | 1 | 11.68 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 6/8 (860 files)) | ubuntu-latest | 1 | 11.35 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 8/8 (859 files)) | ubuntu-latest | 1 | 11.25 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 2/3 (147 files)) | ubuntu-latest | 1 | 10.98 | [run 37515582637](https://github.com/gongiskhan/ekoa-code/actions/runs/37515582637) |
| ci | tests (api 1/2 (83 files)) | ubuntu-latest | 3 | 10.93 | [run 37753879812](https://github.com/gongiskhan/ekoa-code/actions/runs/37753879812) |
| ci | tests (api 3/8 (860 files)) | ubuntu-latest | 1 | 10.77 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 8/8 (860 files)) | ubuntu-latest | 1 | 10.65 | [run 37798006406](https://github.com/gongiskhan/ekoa-code/actions/runs/37798006406) |
| ci | tests (api 2/2 (66 files)) | ubuntu-latest | 3 | 10.37 | [run 37543242795](https://github.com/gongiskhan/ekoa-code/actions/runs/37543242795) |
| ci | tests (api 2/2 (80 files)) | ubuntu-latest | 2 | 9.30 | [run 37845513188](https://github.com/gongiskhan/ekoa-code/actions/runs/37845513188) |
| ci | tests (api 3/3 (147 files)) | ubuntu-latest | 1 | 8.93 | [run 37515582637](https://github.com/gongiskhan/ekoa-code/actions/runs/37515582637) |
| ci | tests (api (50 files)) | ubuntu-latest | 2 | 8.93 | [run 37809672394](https://github.com/gongiskhan/ekoa-code/actions/runs/37809672394) |
| ci | tests (api 1/2 (65 files)) | ubuntu-latest | 2 | 8.87 | [run 37815555378](https://github.com/gongiskhan/ekoa-code/actions/runs/37815555378) |
| ci | tests (api 3/8 (859 files)) | ubuntu-latest | 1 | 8.65 | [run 37795217662](https://github.com/gongiskhan/ekoa-code/actions/runs/37795217662) |
| ci | tests (api 2/7 (387 files)) | ubuntu-latest | 1 | 8.37 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci | tests (api 4/7 (387 files)) | ubuntu-latest | 1 | 7.82 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci | tests (api (18 files)) | ubuntu-latest | 3 | 7.73 | [run 37881714155](https://github.com/gongiskhan/ekoa-code/actions/runs/37881714155) |
| ci | tests (api 1/7 (387 files)) | ubuntu-latest | 1 | 7.60 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci | tests (api 1/3 (147 files)) | ubuntu-latest | 1 | 7.52 | [run 37515582637](https://github.com/gongiskhan/ekoa-code/actions/runs/37515582637) |
| ci | tests (api 1/2 (80 files)) | ubuntu-latest | 2 | 7.47 | [run 37845513188](https://github.com/gongiskhan/ekoa-code/actions/runs/37845513188) |
| ci | tests (api 6/7 (387 files)) | ubuntu-latest | 1 | 7.40 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci | tests (api 5/7 (387 files)) | ubuntu-latest | 1 | 7.18 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| nightly | security-review / security-review-skill | ubuntu-latest | 4 | 7.08 | [run 37560980589](https://github.com/gongiskhan/ekoa-code/actions/runs/37560980589) |
| ci | tests (api 2/2 (65 files)) | ubuntu-latest | 2 | 6.55 | [run 37815555378](https://github.com/gongiskhan/ekoa-code/actions/runs/37815555378) |
| ci | tests (api 7/7 (387 files)) | ubuntu-latest | 1 | 6.22 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| mobile-responsive | mobile | ubuntu-latest | 1 | 6.02 | [run 37495290536](https://github.com/gongiskhan/ekoa-code/actions/runs/37495290536) |
| ci | tests (api 2/2 (78 files)) | ubuntu-latest | 1 | 5.45 | [run 37805516334](https://github.com/gongiskhan/ekoa-code/actions/runs/37805516334) |
| ci | tests (api 2/2 (77 files)) | ubuntu-latest | 1 | 5.10 | [run 37662261878](https://github.com/gongiskhan/ekoa-code/actions/runs/37662261878) |
| ci | tests (api 2/2 (81 files)) | ubuntu-latest | 1 | 5.03 | [run 37750596874](https://github.com/gongiskhan/ekoa-code/actions/runs/37750596874) |
| ci | tests (api 3/7 (387 files)) | ubuntu-latest | 1 | 4.55 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci | tests (api 1/2 (77 files)) | ubuntu-latest | 1 | 4.53 | [run 37662261878](https://github.com/gongiskhan/ekoa-code/actions/runs/37662261878) |
| ci | tests (api 1/2 (78 files)) | ubuntu-latest | 1 | 4.35 | [run 37805516334](https://github.com/gongiskhan/ekoa-code/actions/runs/37805516334) |
| ci | tests (api 1/2 (81 files)) | ubuntu-latest | 1 | 4.18 | [run 37750596874](https://github.com/gongiskhan/ekoa-code/actions/runs/37750596874) |
| ci-full | security-review / range | ubuntu-latest | 12 | 3.98 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| images | prune (web) | ubuntu-latest | 51 | 3.97 | [run 37600548702](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548702) |
| images | prune (api) | ubuntu-latest | 51 | 3.88 | [run 37600548702](https://github.com/gongiskhan/ekoa-code/actions/runs/37600548702) |
| nightly | triage | ubuntu-latest | 7 | 3.22 | [run 37566262148](https://github.com/gongiskhan/ekoa-code/actions/runs/37566262148) |
| ci | legal-eval | ubuntu-latest | 9 | 2.98 | [run 37887956402](https://github.com/gongiskhan/ekoa-code/actions/runs/37887956402) |
| ci-full | security-review / verdict | ubuntu-latest | 12 | 2.83 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| nightly-triage | triage | ubuntu-latest | 4 | 2.52 | [run 37600685332](https://github.com/gongiskhan/ekoa-code/actions/runs/37600685332) |
| nightly | security-review / range | ubuntu-latest | 4 | 1.43 | [run 37560980589](https://github.com/gongiskhan/ekoa-code/actions/runs/37560980589) |
| deploy | record | ubuntu-latest | 9 | 1.42 | [run 37537930220](https://github.com/gongiskhan/ekoa-code/actions/runs/37537930220) |
| nightly | security-review / verdict | ubuntu-latest | 4 | 1.02 | [run 37560980589](https://github.com/gongiskhan/ekoa-code/actions/runs/37560980589) |
| security-review-trial | review / security-review-skill | ubuntu-latest | 1 | 0.90 | [run 37104972295](https://github.com/gongiskhan/ekoa-code/actions/runs/37104972295) |
| ci-full | result | ubuntu-latest | 149 | 0.78 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| nightly-watchdog | check | ubuntu-latest | 6 | 0.45 | [run 37575125755](https://github.com/gongiskhan/ekoa-code/actions/runs/37575125755) |
| nightly | when | ubuntu-latest | 7 | 0.32 | [run 37566262148](https://github.com/gongiskhan/ekoa-code/actions/runs/37566262148) |
| security-review-trial | review / range | ubuntu-latest | 1 | 0.28 | [run 37104972295](https://github.com/gongiskhan/ekoa-code/actions/runs/37104972295) |
| security-review-trial | review / verdict | ubuntu-latest | 1 | 0.23 | [run 37104972295](https://github.com/gongiskhan/ekoa-code/actions/runs/37104972295) |
| ci-full | expensive | ubuntu-latest | 149 | 0.00 | [run 37114747845](https://github.com/gongiskhan/ekoa-code/actions/runs/37114747845) |
| ci | tests (${{ matrix.label }}) | ubuntu-latest | 1 | 0.00 | [run 37515583323](https://github.com/gongiskhan/ekoa-code/actions/runs/37515583323) |
| images | prune | ubuntu-latest | 3 | 0.00 | [run 37691555836](https://github.com/gongiskhan/ekoa-code/actions/runs/37691555836) |
| nightly-deploy | deploy / desktop | macos-15 | 1 | 0.00 | [run 38194862249](https://github.com/gongiskhan/ekoa-code/actions/runs/38194862249) |

## Pull-request checks

| Workflow | Job | Runner | Executions | Minutes |
| --- | --- | --- | ---: | ---: |
| ci | per-pr | ubuntu-latest | 137 | 2,837.73 |
| PRs and Push to main Checks | result | ubuntu-latest | 95 | 900.47 |
| ci-full | e2e | ubuntu-latest | 149 | 753.83 |
| ci-full | unit | ubuntu-latest | 149 | 603.48 |
| ci | typecheck | ubuntu-latest | 137 | 582.68 |
| ci | security-gates | ubuntu-latest | 137 | 549.57 |
| ci | lint | ubuntu-latest | 137 | 443.45 |
| ci | build | ubuntu-latest | 137 | 440.27 |
| ci | tests (web) | ubuntu-latest | 67 | 299.32 |
| ci | tests (shard 2/4) | ubuntu-latest | 16 | 193.35 |
| ci | tests (bridge canary) | ubuntu-latest | 66 | 188.75 |
| ci | tests (clients/cortex-cli) | ubuntu-latest | 69 | 185.28 |
| ci | tests (clients/bridge) | ubuntu-latest | 70 | 170.93 |
| ci | tests (shard 3/4) | ubuntu-latest | 16 | 167.88 |
| ci | tests (shard 1/4) | ubuntu-latest | 16 | 161.45 |
| ci | tests (e2e (1 spec)) | ubuntu-latest | 31 | 158.12 |
| ci | tests (shard 4/4) | ubuntu-latest | 16 | 156.27 |
| ci | tests (clients/mcp-server) | ubuntu-latest | 54 | 152.75 |
| ci | tests (clients/desktop) | ubuntu-latest | 71 | 148.37 |
| ci | tests (shared) | ubuntu-latest | 69 | 113.00 |
| ci | tests (web 1/2) | ubuntu-latest | 17 | 83.10 |
| ci-full | mobile / mobile | ubuntu-latest | 12 | 82.80 |
| ci-full | gates | ubuntu-latest | 149 | 82.35 |
| ci | tests (web 2/2) | ubuntu-latest | 17 | 78.98 |
| ci | tests (e2e (3 specs)) | ubuntu-latest | 7 | 61.07 |
| ci | plan | ubuntu-latest | 137 | 50.57 |
| ci-full | security | ubuntu-latest | 149 | 48.55 |
| ci | tests (api (15 files)) | ubuntu-latest | 13 | 47.97 |
| ci | tests (api 3/4 (194 files)) | ubuntu-latest | 6 | 46.35 |
| ci | tests (api 1/4 (194 files)) | ubuntu-latest | 6 | 43.87 |
| ci | tests (api 2/8 (845 files)) | ubuntu-latest | 6 | 43.17 |
| ci | tests (api 4/4 (194 files)) | ubuntu-latest | 6 | 43.02 |
| ci | tests (api 2/8 (849 files)) | ubuntu-latest | 4 | 42.20 |
| ci | tests (api 2/4 (194 files)) | ubuntu-latest | 6 | 41.53 |
| ci | tests (api 7/8 (845 files)) | ubuntu-latest | 6 | 41.18 |
| ci | tests (api 7/8 (849 files)) | ubuntu-latest | 4 | 40.73 |
| ci | tests (e2e (5 specs)) | ubuntu-latest | 9 | 39.72 |
| ci | tests (api 4/8 (849 files)) | ubuntu-latest | 4 | 38.65 |
| ci | tests (api 1/8 (849 files)) | ubuntu-latest | 4 | 38.55 |
| ci | tests (api 5/8 (845 files)) | ubuntu-latest | 6 | 36.97 |
| ci | tests (api (16 files)) | ubuntu-latest | 11 | 36.88 |
| ci | tests (api 4/8 (845 files)) | ubuntu-latest | 6 | 36.88 |
| ci | tests (api 1/8 (845 files)) | ubuntu-latest | 6 | 36.00 |
| ci | tests (api 8/8 (845 files)) | ubuntu-latest | 6 | 34.18 |
| ci | tests (api 6/8 (845 files)) | ubuntu-latest | 6 | 34.10 |
| ci | tests (api 6/8 (849 files)) | ubuntu-latest | 4 | 34.03 |
| ci | tests (api 3/4 (195 files)) | ubuntu-latest | 3 | 33.72 |
| ci | tests (api 5/8 (849 files)) | ubuntu-latest | 4 | 33.38 |
| ci | tests (api 3/8 (845 files)) | ubuntu-latest | 6 | 32.95 |
| ci | tests (api 3/8 (849 files)) | ubuntu-latest | 4 | 32.88 |
| ci-full | security-review / security-review-skill | ubuntu-latest | 12 | 32.62 |
| ci | tests (api 1/4 (237 files)) | ubuntu-latest | 4 | 32.50 |
| ci | tests (api 1/4 (183 files)) | ubuntu-latest | 4 | 32.18 |
| ci | tests (api 2/4 (237 files)) | ubuntu-latest | 4 | 31.05 |
| ci | tests (api 3/4 (183 files)) | ubuntu-latest | 4 | 30.90 |
| ci | tests (api 4/4 (237 files)) | ubuntu-latest | 4 | 30.25 |
| ci | tests (api 3/6 (351 files)) | ubuntu-latest | 7 | 29.97 |
| ci | tests (api 1/6 (351 files)) | ubuntu-latest | 7 | 29.78 |
| ci | tests (api 8/8 (849 files)) | ubuntu-latest | 4 | 29.57 |
| ci | tests (api 3/4 (237 files)) | ubuntu-latest | 4 | 29.50 |
| ci | tests (api 2/4 (183 files)) | ubuntu-latest | 4 | 29.47 |
| ci | tests (api 5/6 (351 files)) | ubuntu-latest | 7 | 29.22 |
| ci | tests (api 1/4 (186 files)) | ubuntu-latest | 3 | 29.22 |
| ci | tests (api 6/6 (351 files)) | ubuntu-latest | 7 | 29.08 |
| ci | tests (api 4/7 (394 files)) | ubuntu-latest | 5 | 28.67 |
| ci | tests (api 2/6 (351 files)) | ubuntu-latest | 7 | 28.02 |
| ci | tests (api 4/6 (351 files)) | ubuntu-latest | 7 | 27.87 |
| ci | tests (api 3/5 (245 files)) | ubuntu-latest | 4 | 27.43 |
| ci | tests (api 2/3 (126 files)) | ubuntu-latest | 4 | 27.27 |
| ci | tests (api 6/7 (394 files)) | ubuntu-latest | 5 | 27.07 |
| ci | tests (api 3/5 (248 files)) | ubuntu-latest | 4 | 26.77 |
| ci | tests (api 4/4 (183 files)) | ubuntu-latest | 4 | 26.73 |
| ci | tests (api 2/7 (394 files)) | ubuntu-latest | 5 | 26.18 |
| ci | tests (api 4/5 (245 files)) | ubuntu-latest | 4 | 26.10 |
| ci | tests (api 3/7 (394 files)) | ubuntu-latest | 5 | 25.97 |
| ci | tests (api 3/4 (181 files)) | ubuntu-latest | 4 | 25.35 |
| ci | tests (api 1/4 (195 files)) | ubuntu-latest | 3 | 25.22 |
| ci | tests (api 7/7 (394 files)) | ubuntu-latest | 5 | 25.15 |
| ci | tests (api 3/4 (186 files)) | ubuntu-latest | 3 | 24.82 |
| ci | tests (api 5/7 (394 files)) | ubuntu-latest | 5 | 24.60 |
| ci | tests (api 2/4 (195 files)) | ubuntu-latest | 3 | 24.57 |
| ci | tests (api 1/5 (248 files)) | ubuntu-latest | 4 | 24.30 |
| ci-full | scope | ubuntu-latest | 149 | 24.28 |
| ci | tests (api 1/7 (394 files)) | ubuntu-latest | 5 | 24.25 |
| ci | tests (api 3/3 (145 files)) | ubuntu-latest | 2 | 24.12 |
| ci | tests (api 1/4 (181 files)) | ubuntu-latest | 4 | 24.07 |
| ci | tests (api 4/5 (248 files)) | ubuntu-latest | 4 | 23.87 |
| ci | tests (api 2/5 (245 files)) | ubuntu-latest | 4 | 23.85 |
| ci | tests (api 5/5 (248 files)) | ubuntu-latest | 4 | 23.33 |
| ci | tests (api 2/5 (248 files)) | ubuntu-latest | 4 | 23.22 |
| ci | tests (api 1/5 (245 files)) | ubuntu-latest | 4 | 23.02 |
| ci | tests (api 2/4 (181 files)) | ubuntu-latest | 4 | 22.87 |
| ci | tests (api 4/4 (195 files)) | ubuntu-latest | 3 | 22.78 |
| ci | tests (e2e (2 specs)) | ubuntu-latest | 3 | 22.50 |
| ci | tests (api 2/4 (186 files)) | ubuntu-latest | 3 | 22.22 |
| ci | tests (api 5/5 (245 files)) | ubuntu-latest | 4 | 21.82 |
| ci | tests (api 1/3 (163 files)) | ubuntu-latest | 2 | 21.75 |
| ci | tests (api 4/4 (186 files)) | ubuntu-latest | 3 | 21.15 |
| ci | tests (api 2/3 (162 files)) | ubuntu-latest | 2 | 20.80 |
| ci | tests (api 3/3 (162 files)) | ubuntu-latest | 2 | 20.73 |
| ci | tests (api 2/3 (163 files)) | ubuntu-latest | 2 | 20.63 |
| desktop launch probe | probe | macos-15 | 1 | 20.28 |
| ci | tests (api 3/3 (163 files)) | ubuntu-latest | 2 | 20.13 |
| ci | tests (api 4/4 (181 files)) | ubuntu-latest | 4 | 19.97 |
| ci | tests (api (23 files)) | ubuntu-latest | 4 | 19.95 |
| ci | tests (api 3/4 (219 files)) | ubuntu-latest | 2 | 19.85 |
| ci | tests (api 2/3 (127 files)) | ubuntu-latest | 2 | 19.73 |
| ci | tests (api 2/5 (253 files)) | ubuntu-latest | 2 | 19.27 |
| ci | tests (api 1/4 (219 files)) | ubuntu-latest | 2 | 19.05 |
| ci | tests (api 1/8 (826 files)) | ubuntu-latest | 2 | 18.23 |
| ci | tests (api 1/3 (162 files)) | ubuntu-latest | 2 | 18.13 |
| ci | tests (api 1/6 (352 files)) | ubuntu-latest | 2 | 16.78 |
| ci | tests (api 2/8 (826 files)) | ubuntu-latest | 2 | 16.75 |
| ci | tests (api 7/8 (826 files)) | ubuntu-latest | 2 | 16.33 |
| ci | tests (api 3/5 (253 files)) | ubuntu-latest | 2 | 16.33 |
| ci | tests (api (19 files)) | ubuntu-latest | 4 | 16.25 |
| ci | tests (api 4/8 (826 files)) | ubuntu-latest | 2 | 15.87 |
| ci | tests (api 4/5 (253 files)) | ubuntu-latest | 2 | 15.68 |
| ci | tests (api 1/3 (142 files)) | ubuntu-latest | 1 | 15.57 |
| ci | tests (api 3/3 (126 files)) | ubuntu-latest | 4 | 15.52 |
| ci | tests (api 4/4 (219 files)) | ubuntu-latest | 2 | 15.28 |
| ci | tests (api 5/8 (826 files)) | ubuntu-latest | 2 | 14.87 |
| ci | tests (api 2/4 (219 files)) | ubuntu-latest | 2 | 14.78 |
| ci | tests (api 2/3 (135 files)) | ubuntu-latest | 1 | 14.72 |
| ci | tests (api 6/6 (352 files)) | ubuntu-latest | 2 | 14.30 |
| ci | tests (api 4/6 (352 files)) | ubuntu-latest | 2 | 14.18 |
| ci | tests (api 3/3 (160 files)) | ubuntu-latest | 1 | 14.15 |
| ci | tests (api 5/5 (253 files)) | ubuntu-latest | 2 | 14.10 |
| ci | tests (api 1/3 (126 files)) | ubuntu-latest | 4 | 13.90 |
| ci | tests (api 2/3 (145 files)) | ubuntu-latest | 2 | 13.78 |
| ci | tests (api 3/8 (826 files)) | ubuntu-latest | 2 | 13.42 |
| ci | tests (api 1/3 (145 files)) | ubuntu-latest | 2 | 13.42 |
| ci | tests (api 6/8 (826 files)) | ubuntu-latest | 2 | 13.25 |
| ci | tests (api 2/6 (352 files)) | ubuntu-latest | 2 | 13.07 |
| ci | tests (api 5/6 (352 files)) | ubuntu-latest | 2 | 12.67 |
| ci | tests (api 7/8 (859 files)) | ubuntu-latest | 1 | 12.65 |
| ci | tests (api 6/8 (859 files)) | ubuntu-latest | 1 | 12.60 |
| ci | tests (api 8/8 (826 files)) | ubuntu-latest | 2 | 12.53 |
| ci | tests (api 1/5 (253 files)) | ubuntu-latest | 2 | 12.23 |
| ci | tests (api 1/8 (859 files)) | ubuntu-latest | 1 | 12.22 |
| ci | tests (api 4/8 (859 files)) | ubuntu-latest | 1 | 12.18 |
| ci | tests (api 2/8 (859 files)) | ubuntu-latest | 1 | 11.97 |
| ci | tests (api 3/6 (352 files)) | ubuntu-latest | 2 | 11.93 |
| ci | tests (api 5/8 (859 files)) | ubuntu-latest | 1 | 11.68 |
| ci | tests (api (45 files)) | ubuntu-latest | 2 | 11.30 |
| ci | tests (api 8/8 (859 files)) | ubuntu-latest | 1 | 11.25 |
| ci | tests (api 2/3 (147 files)) | ubuntu-latest | 1 | 10.98 |
| ci | tests (api 2/3 (153 files)) | ubuntu-latest | 1 | 10.98 |
| ci | tests (api 1/3 (143 files)) | ubuntu-latest | 1 | 10.88 |
| ci | tests (api 2/3 (141 files)) | ubuntu-latest | 1 | 10.78 |
| ci | tests (api 2/2 (83 files)) | ubuntu-latest | 2 | 10.67 |
| ci | tests (api 1/3 (141 files)) | ubuntu-latest | 1 | 10.45 |
| ci | tests (api 2/3 (160 files)) | ubuntu-latest | 1 | 10.33 |
| ci | tests (api 2/3 (143 files)) | ubuntu-latest | 1 | 9.82 |
| ci | tests (api 4/4 (200 files)) | ubuntu-latest | 1 | 9.80 |
| ci | tests (api 1/3 (160 files)) | ubuntu-latest | 1 | 9.77 |
| ci | tests (api 3/3 (127 files)) | ubuntu-latest | 2 | 9.60 |
| ci | tests (api 3/3 (141 files)) | ubuntu-latest | 1 | 9.58 |
| ci | tests (api 1/3 (135 files)) | ubuntu-latest | 1 | 9.47 |
| ci | tests (api 2/3 (138 files)) | ubuntu-latest | 1 | 9.38 |
| ci | tests (api 3/3 (138 files)) | ubuntu-latest | 1 | 9.38 |
| ci | tests (api (31 files)) | ubuntu-latest | 2 | 9.35 |
| ci | tests (api 3/3 (143 files)) | ubuntu-latest | 1 | 9.30 |
| ci | tests (api 3/3 (135 files)) | ubuntu-latest | 1 | 9.25 |
| ci | tests (api 3/4 (208 files)) | ubuntu-latest | 1 | 9.07 |
| ci | tests (api 1/3 (138 files)) | ubuntu-latest | 1 | 9.02 |
| ci | tests (api 1/4 (200 files)) | ubuntu-latest | 1 | 9.02 |
| ci | tests (api 1/3 (153 files)) | ubuntu-latest | 1 | 8.95 |
| ci | tests (api 3/3 (147 files)) | ubuntu-latest | 1 | 8.93 |
| ci | tests (api 2/4 (200 files)) | ubuntu-latest | 1 | 8.83 |
| ci | result | ubuntu-latest | 137 | 8.67 |
| ci | tests (api 3/8 (859 files)) | ubuntu-latest | 1 | 8.65 |
| ci | tests (api 1/2 (66 files)) | ubuntu-latest | 2 | 8.55 |
| ci | tests (api 4/4 (208 files)) | ubuntu-latest | 1 | 8.43 |
| ci | tests (api 2/4 (208 files)) | ubuntu-latest | 1 | 8.38 |
| ci | tests (api 1/4 (208 files)) | ubuntu-latest | 1 | 8.38 |
| ci | tests (api 2/7 (387 files)) | ubuntu-latest | 1 | 8.37 |
| ci | tests (api 1/3 (127 files)) | ubuntu-latest | 2 | 8.18 |
| ci | tests (api (20 files)) | ubuntu-latest | 2 | 8.17 |
| ci | tests (api 1/2 (83 files)) | ubuntu-latest | 2 | 8.17 |
| ci | tests (api 4/7 (387 files)) | ubuntu-latest | 1 | 7.82 |
| ci | tests (api 3/4 (200 files)) | ubuntu-latest | 1 | 7.62 |
| ci | tests (api 1/7 (387 files)) | ubuntu-latest | 1 | 7.60 |
| ci | tests (api 1/3 (147 files)) | ubuntu-latest | 1 | 7.52 |
| ci | tests (api 6/7 (387 files)) | ubuntu-latest | 1 | 7.40 |
| ci | tests (api 3/3 (153 files)) | ubuntu-latest | 1 | 7.35 |
| ci | tests (api 5/7 (387 files)) | ubuntu-latest | 1 | 7.18 |
| ci | tests (api 2/2 (66 files)) | ubuntu-latest | 2 | 6.60 |
| ci | tests (api 7/7 (387 files)) | ubuntu-latest | 1 | 6.22 |
| ci | tests (api 2/2 (78 files)) | ubuntu-latest | 1 | 5.45 |
| ci | tests (api 1/2 (65 files)) | ubuntu-latest | 1 | 5.13 |
| ci | tests (api 2/2 (77 files)) | ubuntu-latest | 1 | 5.10 |
| ci | tests (api 2/2 (81 files)) | ubuntu-latest | 1 | 5.03 |
| ci | tests (api (50 files)) | ubuntu-latest | 1 | 4.90 |
| ci | tests (api 2/2 (80 files)) | ubuntu-latest | 1 | 4.80 |
| ci | tests (api 3/7 (387 files)) | ubuntu-latest | 1 | 4.55 |
| ci | tests (api 1/2 (77 files)) | ubuntu-latest | 1 | 4.53 |
| ci | tests (api 2/3 (142 files)) | ubuntu-latest | 1 | 4.48 |
| ci | tests (api 1/2 (78 files)) | ubuntu-latest | 1 | 4.35 |
| ci | tests (api 1/2 (81 files)) | ubuntu-latest | 1 | 4.18 |
| ci-full | security-review / range | ubuntu-latest | 12 | 3.98 |
| ci | tests (api (18 files)) | ubuntu-latest | 2 | 3.93 |
| ci | tests (api 1/2 (80 files)) | ubuntu-latest | 1 | 3.75 |
| ci | tests (api 3/3 (142 files)) | ubuntu-latest | 1 | 3.55 |
| ci | tests (api 2/2 (65 files)) | ubuntu-latest | 1 | 3.48 |
| ci-full | security-review / verdict | ubuntu-latest | 12 | 2.83 |
| ci | legal-eval | ubuntu-latest | 6 | 2.28 |
| security-review-trial | review / security-review-skill | ubuntu-latest | 1 | 0.90 |
| ci-full | result | ubuntu-latest | 149 | 0.78 |
| security-review-trial | review / range | ubuntu-latest | 1 | 0.28 |
| security-review-trial | review / verdict | ubuntu-latest | 1 | 0.23 |
| ci-full | expensive | ubuntu-latest | 149 | 0.00 |
| ci | tests (${{ matrix.label }}) | ubuntu-latest | 1 | 0.00 |

## Self-hosted and unassigned jobs

Jobs on the registered dev-madrid-nightly-1/2/3 runners are self-hosted, inferred from the jobs' runner names and the repository runner registry snapshot. Their **2,060.02 minutes** are excluded from hosted totals. 356 unassigned/skipped jobs contribute zero observed execution minutes. 0 executing jobs remain unclassified.

Sources: paginated [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs), [jobs API](https://docs.github.com/en/rest/actions/workflow-jobs) with filter=all, and the read-only repository runner registry. Full sanitized job metadata stays in the private acceptance folder on the Pro; the tables preserve job and runner distinctions, including the macos-15 Mac app deploy and PR checks.
