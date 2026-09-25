# Packed dependency inventory

Status: the source distribution boundary is documented; all four packed installation journeys verified preservation of the 227 notice files described below. This is not permission to publish a binary release.

On 2026-09-25, a read-only inspection of the actual `jevellan-0.1.0.tgz` from the first guided-setup fixture found 225 bundled npm package roots, including twelve Jevellan workspaces. The private archive is under `/private/var/folders/2g/q17sw47d5m5cfm_sybhjrb140000gn/T/jevellan-install-commands-BokxTu/`. It was produced from the current package manifests by `npm pack`; no package was installed or changed by this inspection.

| Declared license in bundled package metadata | Package roots |
| --- | ---: |
| MIT, including the twelve Jevellan workspaces | 202 |
| ISC | 10 |
| BlueOak-1.0.0 | 4 |
| Apache-2.0 | 3 |
| BSD-3-Clause | 3 |
| BSD-2-Clause | 1 |
| Anthropic license-file references | 2 |

The lockfile also contains development-only licenses, including MPL-2.0 for Lightning CSS; those packages were absent from this archive's dependency roots. Package metadata alone is not proof that every required notice is present.

## Distribution boundary and retained attribution

- The archive contains nineteen files under the Claude Agent SDK and its Darwin ARM64 binary package, including their original license files. npm follows production dependencies of bundled workspace packages transitively. This contradicts the previous documentation's assertion that the SDK was external to the packed application. The delivery boundary required by the specification is the public GitHub source repository. Its tracked and eligible untracked file list contains no dependency directories, compiled output or `.tgz` archives. Installation fetches dependencies on the installing machine, and update prepares a package from the GitHub source there. Private packed fixtures and installation copies contain provider packages with their original terms. No npm publication or public binary release is part of this run.
- The top-level package directories for `@openai/codex` 0.156.1, its Darwin ARM64 package and `@xterm/headless` 6.0.0 have no root license file. The missing upstream texts are retained below. The native Codex voice directory already includes its NOTICE, `sources.json` with exact versions, archive URLs and hashes, a build manifest, and seven license texts: LGPL-2.1, Opus, PCRE2, libffi, proxy-libintl, sljit and zlib. The packing manifest includes all of these files. Its NOTICE describes the separately loaded libraries and source/build information; the outer Apache-2.0 package label does not replace these component terms.
- The twelve Jevellan workspaces share the root MIT license. Third-party packages with separate notices need those attributions preserved in the release and installed copy, including code compiled into the web assets.
- APM and Basic Memory are downloaded separately into private Python installations. Existing evidence identifies MIT and AGPL-3.0-or-later respectively; final documentation must keep their upstream licensing and source location distinct from Jevellan's MIT source.

Anthropic's current [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) describes conditional preinstallation under its Commercial Terms. No agreement acceptance, unconditional redistribution permission or provider approval is inferred from that page. The current private fixture archive has not been published as a release. The installer copies the complete prepared application tree and verifies its digest, preserving nested notices and source metadata. A final actual archive and installed-copy check remains packaging verification work, not an environmental test blocker.

## Retained missing upstream texts

The exact xterm.js 6.0.0 and Codex rust-v0.156.1 tags were checked against the installed package versions. Their missing top-level license texts, plus Codex's OpenAI/Ratatui NOTICE, are now preserved unchanged in [docs/licenses](../licenses/README.md), with source links and SHA-256 checksums. The root NOTICE points to that index. The earlier archive remains evidence of the original omission; the final archive and installed copy must prove these files are shipped alongside the original provider license files and nested native-component notices.

`npm pack --dry-run --ignore-scripts --json` completed with a private temporary npm cache. Its packing manifest includes all four `docs/licenses/` files and the root NOTICE, and excludes BRIEF.md. The three upstream files match their recorded SHA-256 values. This checks the intended file list without rebuilding the application or creating a new release archive; the final packed installation check must still verify the resulting copies.

## Actual archive and installed-copy result

The complete 116-case browser matrix passed on 2026-09-25, including four fresh version-8 packed installations. In each, `scripts/spikes/installation-notices.mjs` walked the extracted archive, checked the required root, SDK, React and retained upstream notices, verified the three exact supplemental hashes, and compared every collected file against its installed copy. All four inventories matched, covering **227 files**, including Codex's nested voice notices, license texts and source/build metadata. [J9-installed-notices.json](J9-installed-notices.json) records their relative paths, SHA-256 values and four completed checks without private fixture paths. The receipt describes those tested archives; later application changes still require the final packaging run.

This closes the missing-text and installed-copy findings for phase 5. It does not change any provider's license, infer agreement acceptance, or authorize an npm or binary release. APM and Basic Memory remain separate private installations with their original upstream licensing.
