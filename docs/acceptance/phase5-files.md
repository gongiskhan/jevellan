# Versioned application files and install manifest

The installer file layer records a versioned manifest in the isolated Jevellan home. A SQLite transaction serializes installers without relying on a stale PID file. The manifest identifies the retained data root, installed versions, service definition, service directories and any pending copy or service write.

Applications are copied from built distributions into their own version directories. A digest covers file bytes, executable bits and relative links. Copies preserve executable permissions and internal links, and are checked before publication into the version directory. A different build cannot replace the same installed version; it needs a new version. The previous copy remains available while a newer version is prepared. No service switch occurs during copying.

Pending records precede filesystem changes. A retry can reconcile a completed copy or service-file write whose final receipt was lost. An unrecorded or externally changed application/service file is preserved. Service definitions must name a recorded installed application, so this layer cannot configure a service to run from the checkout.

After the lifecycle coordinator stops the service, file removal deletes only the recorded definition and unchanged application copies. Created service directories are removed only when empty; directories containing another service remain recorded and preserved. Conversation data and unlisted applications remain. Purge confirmation, dependency installation and the running-conversation gate belong to the still-unfinished lifecycle coordinator.

Final typecheck, lint and production build passed. The five affected suites passed **35 tests in 1.89 seconds**, including fourteen installation-file checks and all nine web request/retry checks after the production build. The tests cover lost final copy/write/removal receipts, retry of an unstable partial copy, installer exclusion, same-version preservation, scoped removal, and refusal to replace a service another installation created after preparation. Service definitions are published from complete temporary files, with exclusive creation for the first write.

A separate check used the real, previously packed application: copied it into a disposable versioned home, started its CLI successfully, wrote a service definition through a fake manager, then removed the recorded application and definition while preserving conversation data. Its external result was validated as `owned-application-copy-check-v1`. The native service runner was disabled. This real-copy check preceded the final atomic service-file publication adjustment, which the final tests above cover.

No product was installed into the user's real home and no native service was created, started or stopped. Complete installation, running-conversation coordination, update/rollback, dependency setup, doctor, purge and J9 remain unfinished.
