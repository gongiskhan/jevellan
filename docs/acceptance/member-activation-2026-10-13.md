# Approved member activation, 13 October 2026

Decisions 768–769. Owner grant: connect dev-madrid for project work and the Mini as apps-only, retaining permanent member credentials. No additional grant is needed for those two memberships.

**Live:** published 0.3.1 digests match both platform archives. Dependencies are prepared in isolated homes. Join codes remain in memory and SSH stdin; diagnostics are redacted. Madrid's existing `.jevellan` contains Cursor data and is preserved; the new member uses `/home/ggomes/.jevellan-member`. Its existing passwordless sudo configures only the requested private HTTPS route; no operator delegation or unrelated route change occurs.

**Live Mini:** the user service runs 0.3.1 at `https://goncalos-mac-mini-1.tail31efa.ts.net:9444`. Local and hub policy say apps-only; there is no local hub database. The old pilot, hub-moved fence and original service definitions remain backed up. The two original static app addresses, ports 9600 and 9601, return 200. All fifty files under the original app directory remain byte-identical. Copied app records in the new owned home restore through the existing app service; the original records and files remain unchanged.

**Live Madrid failure:** membership and private authentication files are saved, but systemd refuses the generated quoted WorkingDirectory. The unit is inactive/bad-setting, so online activation and sign-in remain blocked until the corrective package is installed. The Pro remains healthy on 0.3.1. The old releases remain immutable.

**Regression:** two real `systemd-analyze --user verify` cases fail before repair on ordinary and special-character paths. After repair, 33 service/file cases pass on Linux, including both native checks. Mac affected installer/service/toolchain/HTTPS coverage passes 72 cases; the two Linux-only checks skip explicitly. Typecheck, lint and build pass. The initial local variable error and stopped run against that incomplete build are retained as failed/not-run evidence, never counted as passes. A candidate archive/patch sequencing error fails atomically before changing files; the retry waits for archive completion.

The repair writes the working directory as a path directive, with literal percent escaping, while retaining ExecStart/Environment argument quoting. It recognizes only the exact known legacy format for owned-installation repair. Legacy stop recovery requires an inactive unit and a reachable user manager; changed/foreign definitions remain refused. The behavior follows the [systemd path parser](https://github.com/systemd/systemd/blob/main/src/core/load-fragment.c) and [WorkingDirectory documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

**Pending:** finish broader affected Linux checks, publish source-bound 0.3.2 archives, apply the member repair/update and verify Madrid readiness. Isolated Codex sign-in, live terminal relay, fixed-device Mini exclusion, Ekoa held-work/MCP setup and formal scenarios follow. No formal scenario or ten-hour clock starts, and no additional review or owner acceptance is claimed.

Private evidence: `/Users/ggomes/.jevellan-build/loop-owner-2026-10-11/member-mini-activation-2026-10-13.log`; Linux before/after native checks under `/home/ggomes/.jevellan-build/history031-2026-10-13/`; local final checks 161–164 in the owner-helper folder.
