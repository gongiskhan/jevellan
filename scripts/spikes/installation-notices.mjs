import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const InstallationNotices = z.strictObject({
  schema: z.literal('installation-notices-v1'), at: z.iso.datetime(),
  scope: z.literal('packed-application-and-installed-copy'),
  passed: z.literal(true),
  files: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1),
});

const retained = new Map([
  ['docs/licenses/xterm-6.0.0-LICENSE.txt', 'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd'],
  ['docs/licenses/codex-0.156.1-LICENSE.txt', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
  ['docs/licenses/codex-0.156.1-NOTICE.txt', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
]);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** This checks notice preservation, not legal permission to publish provider binaries. */
export function checkInstalledNotices(packed, installed) {
  const paths = [];
  function visit(relative = '') {
    for (const entry of readdirSync(join(packed, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (/^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(entry.name)
        || path.split('/').some(part => /^licen[cs]es$/i.test(part))
        || path.includes('/codex-resources/voice/') && ['sources.json', 'manifest.json'].includes(entry.name)) paths.push(path);
    }
  }
  visit();
  for (const path of ['LICENSE', 'NOTICE', ...retained.keys(), 'node_modules/react/LICENSE', 'node_modules/react-dom/LICENSE',
    'node_modules/@openai/codex-sdk/LICENSE', 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md']) {
    if (!paths.includes(path)) throw new Error(`A required packed notice is missing: ${path}`);
  }
  const files = paths.sort().map(path => {
    const sha256 = hash(join(packed, path));
    if (retained.has(path) && retained.get(path) !== sha256) throw new Error(`Retained upstream text changed: ${path}`);
    if (hash(join(installed, path)) !== sha256) throw new Error(`Installed attribution differs from the archive: ${path}`);
    return { path, sha256 };
  });
  return InstallationNotices.parse({ schema: 'installation-notices-v1', at: new Date().toISOString(), scope: 'packed-application-and-installed-copy', passed: true, files });
}
