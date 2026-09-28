import { build } from 'rolldown';
import { builtinModules } from 'node:module';

// Standalone Node helpers can travel over the existing SSH connection without
// installing a daemon, npm dependencies or a listening service on that device.
for (const entry of ['cursor-hook', 'cursor-stdio']) {
  await build({ input: `packages/mesh/dist/${entry}.js`, platform: 'node',
    external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
    output: { file: `packages/mesh/dist/standalone/${entry}.mjs`, format: 'es' } });
}
