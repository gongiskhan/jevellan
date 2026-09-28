import { build } from 'rolldown';
import { builtinModules } from 'node:module';
import { copyFileSync } from 'node:fs';

// Standalone Node helpers can travel over the existing SSH connection without
// installing a daemon, npm dependencies or a listening service on that device.
for (const entry of ['cursor-hook', 'cursor-stdio', 'cursor-install']) {
  await build({ input: entry === 'cursor-install' ? 'scripts/install-cursor-hooks.mjs' : `packages/mesh/dist/${entry}.js`, platform: 'node',
    external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
    output: { file: `packages/mesh/dist/standalone/${entry}.mjs`, format: 'es' } });
}
copyFileSync('LICENSE', 'packages/mesh/dist/standalone/LICENSE');
copyFileSync('node_modules/zod/LICENSE', 'packages/mesh/dist/standalone/zod-LICENSE');
