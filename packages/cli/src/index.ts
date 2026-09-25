import { DEFAULT_PORT, VERSION } from '@jevellan/core';
import { serveMcpBridge } from './mcp-bridge.js';
import { serveMemoryHook } from './memory-hook.js';
import { Installer } from './installation.js';
import { prepareDistribution } from './distribution.js';
import { installerPrerequisites } from './prerequisites.js';
import { createInterface } from 'node:readline/promises';
import { doctor, doctorLines } from './doctor.js';
import { installationArguments } from './installation-arguments.js';

function printInstallation(result: Awaited<ReturnType<Installer['install']>>) {
  if (result.changedPort) console.log(`The default port was occupied. Jevellan uses ${result.port}.`);
  console.log(`Jevellan ${result.version} is running at ${result.url}`);
  console.log(result.commandOnPath ? 'The jevellan command is ready.' : `Command installed at ${result.command}. Its folder is not on PATH, or another command takes precedence; use this full path for updates and removal.`);
}

async function confirmPurge(path: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(`This removes all Jevellan data at ${path}. Type that exact path to continue: `); }
  finally { terminal.close(); }
}

async function offerHttps() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/iu.test((await terminal.question('Use Tailscale HTTPS for this device? This creates a private route on an unused port. [y/N] ')).trim()); }
  finally { terminal.close(); }
}

export async function main(args: string[], options: { installer?: () => Installer; confirmPurge?: (path: string) => Promise<string>; doctor?: typeof doctor; offerHttps?: () => Promise<boolean> } = {}) {
  if (args[0] === '--version') { console.log(VERSION); return; }
  if (args[0] === 'doctor') {
    if (args.length !== 1) throw new Error('Usage: jevellan doctor');
    const report = await (options.doctor ?? doctor)(); doctorLines(report).forEach(line => console.log(line));
    if (report.checks.some(check => check.status !== 'ok')) process.exitCode = 1;
    return;
  }
  if (args[0] === 'mcp-bridge') { await serveMcpBridge(); return; }
  if (args[0] === 'memory-hook') { await serveMemoryHook(); return; }
  if (['install', 'join', 'update', 'rollback', 'uninstall'].includes(args[0] ?? '')) {
    const command = args[0]!, { from, target, purge, https } = installationArguments(command, args.slice(1));
    const installer = options.installer?.() ?? new Installer({ progress: message => console.log(message) });
    try {
      if (command === 'uninstall') {
        if (purge) { const confirmation = await (options.confirmPurge ?? confirmPurge)(installer.homes.root); await installer.purge(confirmation); console.log('Jevellan and its data were removed.'); }
        else console.log(`Jevellan was uninstalled. Your data remains at ${await installer.uninstall()}`);
        return;
      }
      if (command === 'rollback') { printInstallation(await installer.rollback()); return; }
      installer.validateJoin(target);
      await installerPrerequisites(installer.homes);
      let useHttps = https;
      if (useHttps === undefined && command !== 'update' && (options.offerHttps || process.stdin.isTTY && process.stdout.isTTY) && await installer.canOfferHttps()) useHttps = await (options.offerHttps ?? offerHttps)();
      let result = target && !from ? await installer.resumeJoin(target, useHttps) : null;
      if (!result) {
        const distribution = await prepareDistribution(installer.files, { ...(from ? { from } : {}), update: command === 'update', progress: message => console.log(message) });
        result = await (command === 'update' ? installer.update(distribution.path) : installer.install(distribution.path, target, useHttps)); distribution.cleanup();
      }
      printInstallation(result);
    } finally { installer.close(); }
    return;
  }
  if (args[0] === 'start') {
    const index = args.indexOf('--port');
    const port = index < 0 ? DEFAULT_PORT : Number(args[index + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const { startDaemon } = await import('@jevellan/daemon'); const daemon = await startDaemon(port);
    const stop = () => { void daemon.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log(`Jevellan is running at ${daemon.addresses.join(' and ')}`);
    return;
  }
  console.log('Jevellan — Autonomous development, coordinated.\nCommands: install [--from path] [--join hubUrl code] [--https | --no-https], join hubUrl code [--from path] [--https | --no-https], update [--from path], rollback, uninstall [--purge], doctor, start [--port number], --version');
  if (args.length) process.exitCode = 1;
}
