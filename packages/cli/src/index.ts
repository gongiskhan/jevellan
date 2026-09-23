import { DEFAULT_PORT, VERSION } from '@jevellan/core';
import { startDaemon } from '@jevellan/daemon';

export async function main(args: string[]) {
  if (args[0] === '--version') { console.log(VERSION); return; }
  if (args[0] === 'start') {
    const index = args.indexOf('--port');
    const port = index < 0 ? DEFAULT_PORT : Number(args[index + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    await startDaemon(port);
    console.log(`Jevellan is running at http://127.0.0.1:${port}`);
    return;
  }
  console.log('Jevellan — Autonomous development, coordinated.\nDevelopment commands: start [--port number], --version');
  if (args.length) process.exitCode = 1;
}
