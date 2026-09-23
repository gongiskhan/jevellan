#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Jevellan needs Node 22 or newer.');
  process.exit(1);
}
const { main } = await import('../packages/cli/dist/index.js');
await main(process.argv.slice(2));
