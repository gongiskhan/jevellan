import { Homes, HubPathMapSchema, readDocument } from '@jevellan/core';
import { exportHub, importHub } from './hub-migration.js';
import { hiddenPrompt } from './hidden-prompt.js';

type Options = { homes?: Homes; prompt?: (text: string) => Promise<string>; export?: typeof exportHub; import?: typeof importHub };
export async function hubCommand(args: string[], options: Options = {}): Promise<void> {
  const homes = options.homes ?? new Homes(); const prompt = options.prompt ?? hiddenPrompt;
  if (args[0] === 'export') {
    const fields = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index], value = args[index + 1];
      if (!name || !['--out', '--to'].includes(name) || !value || value.startsWith('--') || fields.has(name)) throw new Error('Usage: jevellan hub export --out file --to destination-name');
      fields.set(name, value);
    }
    if (!fields.has('--out') || !fields.has('--to')) throw new Error('Usage: jevellan hub export --out file --to destination-name');
    const passphrase = await prompt('Migration passphrase (hidden, at least 12 characters): ');
    if (await prompt('Repeat migration passphrase (hidden): ') !== passphrase) throw new Error('The migration passphrases do not match.');
    const result = await (options.export ?? exportHub)({ homes, out: fields.get('--out')!, destinationName: fields.get('--to')!, passphrase });
    console.log(`Encrypted hub export complete: ${result.entries.length} files; ${result.excluded.length} transient or device-local items excluded. The old hub is fenced from normal startup.`);
    return;
  }
  if (args[0] === 'import') {
    if (!args[1] || args[1].startsWith('--') || !(args.length === 2 || args.length === 4 && args[2] === '--paths' && args[3])) throw new Error('Usage: jevellan hub import file [--paths mapping-file]');
    const projectPaths = args[3] ? readDocument(args[3], HubPathMapSchema).paths : undefined;
    const passphrase = await prompt('Migration passphrase (hidden): ');
    const result = await (options.import ?? importHub)({ homes, archive: args[1], passphrase, ...(projectPaths ? { projectPaths } : {}) });
    console.log('Hub import complete. Start this installation and sign in through its UI.');
    if (result.needsLoginAccountIds.length) console.log(`${result.needsLoginAccountIds.length} Codex subscription accounts need sign-in on this device.`);
    if (result.unboundProjectIds.length) console.log(`${result.unboundProjectIds.length} projects need a checkout path on this device in Settings → Projects.`);
    return;
  }
  throw new Error('Usage: jevellan hub export --out file --to destination-name, or jevellan hub import file [--paths mapping-file]');
}
