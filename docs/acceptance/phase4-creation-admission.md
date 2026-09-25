# Initial conversation choices during hub loss

**Live:** local HTTP, SQLite, Git and isolated homes. **Simulated:** Jev responses, runtime execution and the hub outage. No successful live Jev classification is claimed.

The previous UI checkpoint identified a gap between creating a conversation and scheduling its first decision. Saving initial composer choices called the ordinary composer endpoint logic, which reread hub settings and project state between each choice. If a read failed after the first choice, the conversation and request already existed. Repeating creation repaired the remaining choices but only returned the conversation; it never scheduled the first step.

Creation now validates the supplied model and initial action against one settings/project read before creating the conversation. Its local choice records are then saved synchronously, without further hub reads, before scheduling enters the existing owned decision/recovery path. Choice ordering preserves pins followed by one-time overrides. A repeated creation request checks the existing choice identities and returns the current conversation; it does not restore consumed choices or reconstruct an unfinished old admission. An incomplete older record receives an explicit conflict directing the user to its composer.

Initial action checks share the same guard predicate as later decisions. Rejected initial actions no longer create an empty conversation object before validation. The latter mattered because shutdown attempted to read the nonexistent conversation behind that object.

## Verification history

- The first test draft needed its unknown composer document parsed with the versioned schema before typechecking.
- The reproduction then failed in **1.92 seconds**: after hub recovery and a repeated creation request, the saved conversation never reached its first scheduled step.
- The initial fix passed **three creation/precedence cases in 15.43 seconds**.
- The expanded selection passed five cases and failed four in **22.68 seconds**. Three invalid-action cases exposed the empty-conversation shutdown defect, now corrected by moving creation after validation. The restart fixture expected a blocked state, but it explicitly invoked graceful shutdown, which correctly cancelled this unstarted work. Its assertion now verifies that cancellation and zero launches survive reopening.
- The complete automatic-conversation, work and recovery suites passed **60 tests in three files in 143.48 seconds**. **Eight browser workflows passed in 51.2 seconds** on desktop/phone in light/dark, covering initial choices, pins, correction explanations, reload and stable-ID creation retries. Phone-light New conversation and desktop-dark Why captures were inspected.
- Typecheck, lint and the production build passed. This is targeted verification, not a clean full expanded repository suite or completed acceptance.
- Secret scanning and whitespace checks passed. The unchanged commit-approval and GitHub-authentication blockers were not retried.

The new cases cover hub loss immediately after the first choice is durably saved, simultaneous duplicate creation requests, one first execution, unchanged read-only Git state, cancellation, graceful restart, and refusal of Done or review actions prohibited by the initial guards. Existing choice binding, once/pin precedence and unavailable-account recovery remain part of the regression scope.

This completes the identified initial-choice hub gap. It does not complete all UI admission/retry behavior: account creation, provider-login completion and other Settings mutations still need appropriate waits or reconciliation. The private Tailscale preview remains its fixed earlier copy. Commit approval, GitHub authentication and dedicated live-provider credentials remain separately recorded blockers.
