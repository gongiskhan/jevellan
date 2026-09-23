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
const headMatches = baseline.split('$ git rev-parse HEAD\n')[1]?.split('\n')[0] === git(['rev-parse', 'HEAD']).trim();
const statusMatches = baseline.split('$ git status\n')[1] === git(['status']);
console.log(JSON.stringify({ headMatches, statusMatches }));
if (!headMatches || !statusMatches) process.exitCode = 1;
