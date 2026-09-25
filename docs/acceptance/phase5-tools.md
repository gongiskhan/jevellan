# Isolated installation dependencies

Status: dependency component verified with simulated command failures and live disposable installations. The later combined installer and guided first-run journey passes all four layouts; see [J9](J9.md). The checks below preserve this component's earlier evidence.

`packages/cli/src/toolchain.ts` installs APM 0.10.0 and Jevellan's own Basic Memory 0.22.1 with managed Python 3.12. It reuses an existing APM or uv only when its version matches the tested pin. An existing Basic Memory is never reused. Native tools are only probed under the private environment; their packages, profiles and settings are not changed.

Without a compatible uv, `uv-bootstrap.ts` downloads the pinned 0.11.23 release archive through Node, checks the published SHA-256 digest and extracts the two executables. It does not execute an installation shell script. The six release digests come from the [pinned official installer](https://astral.sh/uv/0.11.23/install.sh). macOS and Linux ARM64/x64 archive selection is covered, including GNU and musl; only macOS ARM64 was exercised live here.

The installation manifest records a versioned pending dependency plan before work starts. Successful tools are probed and reused after interruption or a lost completion receipt. Python environments, executables, configuration, temporary files and caches remain under the Jevellan home. Dependency directories include the APM, Basic Memory and Python versions; older environments remain recorded for application rollback. uv has its own versioned directory. No service is started by this component.

## Checks

- Simulated: eight toolchain cases cover compatible native reuse, incompatible versions, owned Basic Memory, interrupted install, lost completion receipt, old-version retention, cancellation, owned executable scope and executable lookup. Some cases cover more than one behavior.
- Simulated archives/real extraction: six bootstrap cases cover release selection, checksum rejection, cache reuse/replacement, incomplete archives, HTTP failure and cancellation.
- Final affected matrix: **49 tests in seven suites passed in 2.76 seconds**, including all fourteen new cases, fourteen application-file cases, seven service-adapter cases and existing application-path/HTTP/web-request checks. An initial toolchain run exposed validation of the pending record's metadata as if it were a version; the helper now validates only its four version fields. The final HTTP selection initially hit the sandbox's listener restriction (47 passed, two could not bind); the same selection passed with loopback access.
- Typecheck, lint and production build passed. Logs: `/private/tmp/jevellan-toolchain-typecheck-final.log`, `/private/tmp/jevellan-toolchain-lint-final.log`, `/private/tmp/jevellan-toolchain-build.log`, `/private/tmp/jevellan-toolchain-final-focused.log`.
- Live: `scripts/spikes/installed-toolchain.mjs` forced a fresh official uv download and installed both Python packages in a disposable home. All three executable versions were verified. Repeating setup issued **zero package-install commands**. Native-home/Garrison fixture canaries remained unchanged; no native service manager was invoked. The strict `installed-toolchain-check-v1` result is `/private/var/folders/2g/q17sw47d5m5cfm_sybhjrb140000gn/T/jevellan-installed-toolchain-1yPNFF/result.json`; the command log is `/private/tmp/jevellan-installed-toolchain-live.log`. This is an actual dependency installation, not a fake package-manager response.

The earlier full backend result (**878 passed, one skipped**) predates these dependency checks. Follow-up evidence for install, update, rollback, uninstall, doctor, purge and first-run setup is consolidated in [J9](J9.md). None of this claims the user's acceptance.
