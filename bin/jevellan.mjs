#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
  console.error('Jevellan needs Node 22.13+ or 23.4+ for its built-in SQLite support.');
  process.exit(1);
}
const { main } = await import('../packages/cli/dist/index.js');
await main(process.argv.slice(2));
