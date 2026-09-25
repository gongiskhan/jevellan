# Memory recall after checkout updates

A device that had already opened project memory could miss notes later pulled from another checkout. Registration refreshed the Basic Memory index once, and writing stretches explicitly synchronized it, but read-only searches reused the older index. This contradicted the cross-device recall requirement in J11.

Project memory searches now synchronize the isolated local index from the current checkout before querying it. A missing memory directory still returns no notes without creating the directory. Refreshing the index does not need checkout ownership: Basic Memory's configuration disables note/frontmatter rewrites, and the existing sync implementation writes its database in Jevellan's isolated home.

The new regression uses two real Git checkouts and the installed Basic Memory service. It opens B's index, verifies that no Vitest note exists, commits the note in A, pulls into B and asks the existing reader to recall it. Before the fix, recall returned no chosen notes. After the fix, the note and its globals convention are recalled, while the imported bytes, HEAD and clean Git status stay unchanged. The reader's ownership callback always rejects writes.

**36 tests in four affected suites passed in 49.73 seconds**, covering the regression, actual Basic Memory isolation and file preservation, memory recall/selection, proposal queues and stretch bridge permissions. Typecheck, lint and production build also passed. The separate browser journey and its evidence are recorded in [J11](J11.md).

This change refreshes on search for a simple, consistent view of checkout contents. It adds index synchronization cost to searches; no performance improvement is claimed. It does not turn simulated provider evidence into live model or judge acceptance.
