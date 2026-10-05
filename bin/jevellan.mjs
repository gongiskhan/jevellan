#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
  console.error('Jevellan needs Node 22.13+ or 23.4+ for its built-in SQLite support.');
  process.exit(1);
}
// Node 22 announces its built-in SQLite as experimental whenever a command loads it; Jevellan requires it, so the notice only adds
// noise above every command's own output. Other warnings still print.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => String(warning?.message ?? warning).startsWith('SQLite is an experimental feature') ? undefined : emitWarning.call(process, warning, ...rest);
// Lifecycle hooks have a short shutdown deadline and need only client schemas.
if (process.argv[2] === 'memory-hook') {
  const { serveMemoryHook } = await import('../packages/cli/dist/memory-hook.js');
  await serveMemoryHook();
} else {
  const { main } = await import('../packages/cli/dist/index.js');
  await main(process.argv.slice(2));
}
