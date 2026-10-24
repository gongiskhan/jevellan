# Jevellan 0.7.8

Verification and landing checks now use a separate environment. Configure check variables, vault secrets and file mappings in Project settings → Environment. The configured setup and check commands run in a fresh candidate checkout. Work inputs stay in their work scope. A missing check input keeps a durable waiting item; available inputs resolve it with a reason and retry verification automatically. Profile, secret and file changes invalidate cached or in-progress results. Owner tools, member routes and hidden secret entry share the same explicit check scope.

Account status now reports weekly budget use independently from the five-hour window, with observation source, time and reset information. Missing readings remain unknown.

Managed Codex launches preserve bounded project instructions up to256KiB using the supported native configuration. The coordinator shows a pending fresh start until it happens. Repeated identical verification failures stop with a reason and preserve the worktree.

The check-environment source gate passes522 assertions in28complete files with zero skips. Build, typecheck and lint pass; desktop settings save, thread interaction and the new check form pass with retained matching screenshots. Combined release verification and installation receipts are recorded separately. No live authentication or production action is claimed.

The combined release gate passes866 assertions in64complete affected files with zero failures or skips, static checks/build, and all five first-attempt desktop-light core journeys with20retained matching screenshots. The full unfiltered backend is not run on this release source; the focused affected gate follows the latest manager authorization.
