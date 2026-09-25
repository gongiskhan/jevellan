# Retained upstream licenses

These files preserve upstream license and attribution text omitted from the corresponding installed npm package roots. They were retrieved unchanged on 2026-09-25 from the tags matching this checkout's pinned dependencies.

| Dependency | Retained file | Upstream source |
| --- | --- | --- |
| `@xterm/headless` 6.0.0 | [MIT license and copyright notices](xterm-6.0.0-LICENSE.txt) | [xterm.js 6.0.0](https://raw.githubusercontent.com/xtermjs/xterm.js/6.0.0/LICENSE) |
| `@openai/codex` 0.156.1 | [Apache-2.0 license](codex-0.156.1-LICENSE.txt) | [Codex rust-v0.156.1](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/LICENSE) |
| `@openai/codex` 0.156.1 | [OpenAI and Ratatui attribution](codex-0.156.1-NOTICE.txt) | [Codex rust-v0.156.1 NOTICE](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/NOTICE) |

SHA-256 of the unmodified files:

```text
b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd  xterm-6.0.0-LICENSE.txt
d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc  codex-0.156.1-LICENSE.txt
9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915  codex-0.156.1-NOTICE.txt
```

Keep the original license and notice files inside bundled packages too. Native components have additional notices; these three files do not replace them. The source distribution boundary and installed-copy verification evidence are recorded in the [packaging inventory](../acceptance/phase5-license-inventory.md). No provider package is relicensed under Jevellan's MIT license.
