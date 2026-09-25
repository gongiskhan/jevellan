import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const baseline = readFileSync(join(homedir(), '.jevellan-build/garrison-baseline.txt'), 'utf8');
const repo = join(homedir(), 'dev/garrison');
function git(args) {
  const result = spawnSync('git', ['--no-optional-locks', '--no-pager', '-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error('Cannot read Garrison baseline state.');
  return result.stdout;
}
const snapshots = baseline.split(/\n\n(?=--- (?:Current preflight recheck|Baseline for this preflight);|Preflight snapshot:|## Preflight snapshot |=== Requested preflight snapshot )/).map((section) => {
  const match = /(?:^|\n)(?:\$ )?git(?: -C ~\/dev\/garrison)? rev-parse HEAD\n([a-f0-9]{40,64})\n\n(?:\$ )?git(?: -C ~\/dev\/garrison)? status\n([\s\S]*)$/.exec(section);
  if (!match) throw new Error('Cannot parse a saved Garrison baseline snapshot.');
  return { head: match[1], status: match[2] };
});
const original = snapshots[0];
const latest = snapshots.at(-1);
const head = git(['rev-parse', 'HEAD']).trim(); const status = git(['status']);
const headMatches = original.head === head;
const statusMatches = original.status === status;
const latestHeadMatches = latest.head === head;
const latestStatusMatches = latest.status === status;
console.log(JSON.stringify({ headMatches, statusMatches, latestHeadMatches, latestStatusMatches }));
if (!headMatches || !statusMatches) process.exitCode = 1;
