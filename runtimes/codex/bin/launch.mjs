#!/usr/bin/env node
import { spawn } from 'node:child_process';

// The SDK has no hook-trust argument. Keep its transport and forward only this
// invocation's explicitly enabled hooks; authentication and sandbox flags stay intact.
const args = process.argv.slice(2);
let executable = 'codex';
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--config' && args[i + 1].startsWith('jevellan_executable=')) {
    executable = JSON.parse(args[i + 1].slice('jevellan_executable='.length));
    args.splice(i, 2); i--;
  }
}
if (typeof executable !== 'string' || !executable || args[0] !== 'exec') process.exit(2);
args.splice(1, 0, '--dangerously-bypass-hook-trust');
const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { child.kill(signal); });
child.on('error', () => { process.stderr.write('Codex could not start.\n'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
