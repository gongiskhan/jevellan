# Installer service adapter

The CLI now has a service-manager adapter with versioned, strict Zod schemas for its specification and service definition. File creation, removal and install-manifest ownership remain the installer's responsibility. Before controlling a service, the adapter checks its exact path and saved contents; a changed file or path alias is rejected.

The macOS definition uses `dev.jevellan.daemon`, absolute Node/application paths, Jevellan's own home and explicit PATH. Start loads the definition if needed and requests execution without killing an existing process. Stop targets only that service. An already absent service is accepted only after confirming an accessible user domain and the missing target.

The Linux definition uses the user unit `jevellan.service`, an explicit application directory and environment, and direct execution with variable expansion disabled. Literal percent signs are escaped for systemd. The adapter enables/starts and disables/stops only its unit, and reloads the user manager after removal. Command-line behavior follows the official [systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Command%20lines).

Seven tests passed in 460 milliseconds. The native command runner is replaced by a fake in every lifecycle test, so a temporary HOME can never cause these tests to operate the real user's services. The macOS property-list parser also validated the generated document and exact arguments containing spaces and XML characters. Changed and aliased files, failures, repeated starts and absent-service handling are covered. These tests validate the adapter, not a complete install or J9.

No service or installed application was created. The full installer, update/rollback coordination, manifest-driven removal, dependency setup, doctor and first-run walkthrough remain implementation work. Linux service behavior is simulated; native Linux acceptance was not run.
