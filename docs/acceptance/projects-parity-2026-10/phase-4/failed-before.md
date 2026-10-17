# Phase 4 regressions before repair

All evidence here is simulated, with real local Git/HTTP/ledgers and disposable provider/GitHub fixtures. Raw traces stay outside the checkout.

| Case | Observed before repair | Change |
| --- | --- | --- |
| Same-thread checks loop | Expected two turns, got one. | The tracker queues the existing runner and publication path. |
| Early review comment | Expected one comment, got zero. | The initial cursor starts at thread creation. |
| Previously handled failing head and new conflict | Expected another turn, got one total. | An ineligible check candidate no longer suppresses another eligible kind. |
| CI recovers after the round cap | The question had no withdrawn time. | Recovery withdraws it; a later failure gets a fresh question id. |
| Disable an automatic fix queued for resources | Expected one turn, got two. | Unstarted automatic work rechecks the setting and cancels; rounds are charged at launch. |
| Resume internal verification | Its pending turn remained after completion. | A resumed continuation clears pending work without charging the attempt again. |

Both same-timestamp comment-batch checks pass without a repair, including a refresh beyond the cache window. They are coverage, not a claimed failure.

The initial resumed-verification fixture did not mark an admission wait, so the sweep did not resume it. The corrected fixture calls the runner's actual resume path. With the pre-repair compiled behavior restored just for that regression, it fails with the pending verification still present; the compiled fix was restored immediately afterwards.

The first larger run passes97/107 cases. Manual-action fixtures conflict with the newly enabled automatic policy and now explicitly turn it off; the production default stays on. Several new multi-turn cases exceeded the15-second default and now have a120-second integration bound, which covers process shutdown as well. The remote answer fixture must drive the member inbox, as its periodic timers are disabled. One remote publication was refused after a system ps command failed; no process-ownership guard was weakened. The simultaneous request-budget run hit its unchanged300-second test deadline and remains a failed attempt pending an isolated rerun. These attempts are not passes.

The three affected legacy thread cases pass after their manual-policy fixtures are explicit and the setup-restart case is rerun at lower contention. The corrected resume regression fails under the pre-repair compiled behavior with the pending verification present, then the compiled fix is restored. Multi-turn test bounds change, but their behavioral assertions remain.

A prompt regression catches an older GitHub-awareness bullet still telling the coordinator to send failed logs to the thread unconditionally. Removing that sentence leaves the new automatic-fix rule as the single instruction. The old owner-actions case also exceeds15seconds in isolation; its120-second bound covers its four native turns without changing any behavioral assertion. Both remote owner-action and automatic-limit answer cases pass on the corrected member inbox driver.

Direct inspection of the first passing desktop-dark capture finds Loading chat still visible. The owner-request capture also occurs during managed publication. The journey now waits for chat and for the new head to finish publication before its final screenshot; its assertions are strengthened. The original passing behavior runs are retained, and the settled four-layout rerun supplies the final captures. No product source changes are needed for capture timing.

The strengthened desktop journey then fails at zero automatic labels because a full navigation falls back to the reconnect page. Its trace records the service worker's eight-second navigation abort while the document request later returns200. The offline page has no automatic health recovery. Three VM regressions fail before repair (no healthy retry, unnecessary reload on online while unreachable, and no visibility recovery), then all pass. The repair adds bounded visible-page health retries; it reads no owner document. A deterministic browser case injects one503 navigation while the network stays online.

The final phone-light recovery run passes both behavior journeys but retains the existing kill EPERM fixture cleanup warning. An isolated owned-zombie experiment accepts SIGTERM, so it does not explain that warning and supplies no repair claim. Process-ownership rules remain unchanged; full-suite cleanup remains a closing concern.
