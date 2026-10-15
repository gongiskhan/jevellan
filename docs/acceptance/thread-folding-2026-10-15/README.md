# Focused thread transcript — 15 October 2026

Decision839 implements the owner’s request to keep only current work and thinking expanded. Completed tool groups/calls, messages/prompts, queued messages and reports start folded and remain available through their disclosure controls. The active assistant block opens while the thread runs. A completed tool closes; an old Recorded/unknown tool is never reopened as current work. Thinking starts open. Owners may open history without polling closing their selection. This applies to Projects threads; other transcript surfaces keep their existing presentation.

## Evidence

- **Simulated:**45 focused tests pass. The targeted Projects browser journey passes in35.4seconds (1.3minutes including fixture startup), checking collapsed history, preserved tool results, manual expansion, expanded thinking, automatic opening of a pending tool and closure after its result. The fixture uses fake providers/Jev; no live provider task created.
- **Live:** Pro’s existing thread shows79 tool groups closed, all4 thinking blocks open, historical messages and reports closed. Clicking the final report opens it. Screenshots cover1440×900 and390×844, light/dark, each directly inspected. System theme/viewport restored.
- Typecheck, lint and production builds pass. Source basec86e11a7. A compatible frontend build uses the retained0.3.6 web source plus the prior header patch and this change, binding core/client to the installed0.3.6 contract. Private build-launcher tsconfig omissions were corrected before activation; no product assertion changed. The Pro backend stays0.3.6. Web rollback/hash receipt: private ~/.jevellan-build/thread-folding-2026-10-15/.
- **Not run:** full backend/browser matrix, dedicated model vision, physical-phone acceptance. One closing scoped crucial-issues inspection found no serious issue; no second pass.

No thread messages, model turn, Ekoa code, PR action, account change or daemon restart was needed. The earlier admission retry patch remains unactivated while its lifecycle gate is busy; this UI change does not claim to resolve that separate blocker.
