import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_TEXT = 4_000_000;
const MAX_UNTRACKED = 200;
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

async function git(cwd: string, args: string[], allowExit1 = false): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    return stdout;
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    if (allowExit1 && failed.code === 1 && typeof failed.stdout === 'string') return failed.stdout;
    throw Object.assign(new Error(`Could not read the changes: ${(failed.stderr ?? String(error)).trim().split('\n')[0]}`), { status: 409 });
  }
}

export type WorktreeDiffView = {
  schema: 'worktree-diff-v1'; scope: 'checkout' | 'worktree'; cwd: string; branch: string; head: string;
  files: { path: string; status: string }[]; text: string; truncated: boolean;
};

/** Uncommitted changes in a working tree: tracked changes against HEAD (staged or not) plus untracked files shown as added. */
export async function worktreeDiff(cwd: string, scope: 'checkout' | 'worktree'): Promise<WorktreeDiffView> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], true)).trim();
  const head = (await git(cwd, ['rev-parse', '--short', 'HEAD'], true)).trim();
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files: { path: string; status: string }[] = [];
  const entries = status.split('\0'); const untracked: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!; if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index++;
    if (code === '??') { untracked.push(path); files.push({ path, status: 'untracked' }); }
    else files.push({ path, status: code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code[0] === 'R' ? 'renamed' : 'modified' });
  }
  let text = head ? await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']) : await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff']);
  for (const path of untracked.slice(0, MAX_UNTRACKED)) {
    if (text.length > MAX_TEXT) break;
    text += await git(cwd, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path], true);
  }
  const truncated = text.length > MAX_TEXT || untracked.length > MAX_UNTRACKED;
  return { schema: 'worktree-diff-v1', scope, cwd, branch, head, files, text: text.slice(0, MAX_TEXT), truncated };
}
