import { InstallationJoinInputSchema, type InstallationJoinInput } from './installation.js';

export function installationArguments(command: string, args: string[]) {
  const usages: Record<string, string> = { install: 'install [--from path] [--join hubUrl code] [--https | --no-https]', join: 'join hubUrl code [--from path] [--https | --no-https]', update: 'update [--from path]', rollback: 'rollback', uninstall: 'uninstall [--purge]' };
  const invalid = () => new Error(`Usage: jevellan ${usages[command] ?? 'install'}`);
  let from: string | undefined, target: InstallationJoinInput | undefined, https: boolean | undefined, purge = false, at = 0;
  const join = (url: string | undefined, code: string | undefined) => {
    const parsed = InstallationJoinInputSchema.safeParse({ schema: 'installation-join-input-v1', hubUrl: url, code });
    if (!parsed.success) throw invalid(); return parsed.data;
  };
  if (command === 'join') { target = join(args[0], args[1]); at = 2; }
  while (at < args.length) {
    if (args[at] === '--from' && ['install', 'join', 'update'].includes(command) && !from && args[at + 1] && !args[at + 1]!.startsWith('--')) { from = args[at + 1]; at += 2; }
    else if (args[at] === '--join' && command === 'install' && !target) { target = join(args[at + 1], args[at + 2]); at += 3; }
    else if (args[at] === '--purge' && command === 'uninstall' && !purge) { purge = true; at++; }
    else if (['--https', '--no-https'].includes(args[at]!) && ['install', 'join'].includes(command) && https === undefined) { https = args[at] === '--https'; at++; }
    else throw invalid();
  }
  return { from, target, purge, https };
}
