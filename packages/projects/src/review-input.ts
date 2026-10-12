import { closeSync, openSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { GitSettings, spawnGroup, terminateGroup, type Homes, type SecretRedactor } from '@jevellan/core';
export const REVIEW_INPUT_LIMIT = 8 * 1024 * 1024;
const REVIEW_GIT_TIMEOUT = 10 * 60_000;
/** Stop a single oversized line as well as a large range; retain complete lines for secret redaction. */
export async function boundedReviewLines(source: AsyncIterable<Buffer>, remaining: () => number, write: (text: string) => boolean): Promise<boolean> {
  const decoder = new StringDecoder('utf8'); let pending = '';
  for await (const chunk of source) {
    pending += decoder.write(chunk); let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline + 1); pending = pending.slice(newline + 1); if (!write(line)) return true; }
    if (Buffer.byteLength(pending) > remaining()) return true;
  }
  pending += decoder.end(); return !!pending && !write(pending);
}
/** Read git incrementally; never collect a range's patches in a CommandResult. */
async function streamLog(homes: Homes, redactor: SecretRedactor, repo: string, args: string[], path: string, prefix = '') {
  const fd = openSync(path, 'w', 0o600); let size = 0, truncated = false, timedOut = false, stderr = '';
  const write = (text: string) => { const bytes = Buffer.from(redactor.text(text)); if (size + bytes.length > REVIEW_INPUT_LIMIT) { truncated = true; return false; } writeSync(fd, bytes); size += bytes.length; return true; };
  let stop: Promise<void> | undefined;
  try {
    write(prefix);
    const { child, native } = await spawnGroup('git', ['--no-pager', 'log', ...args], { cwd: repo, env: new GitSettings(homes).environment() });
    child.stdin.end(); child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const completion = new Promise<number>((resolve, reject) => { child.once('close', code => resolve(code ?? 1)); child.once('error', reject); });
    void completion.catch(() => undefined);
    const end = () => { stop ??= terminateGroup(native); return stop; };
    const timer = setTimeout(() => { timedOut = true; void end().catch(() => undefined); }, REVIEW_GIT_TIMEOUT);
    try { truncated = await boundedReviewLines(child.stdout.iterator({ destroyOnReturn: false }), () => REVIEW_INPUT_LIMIT - size, write); if (truncated) await end(); await completion; await stop; }
    finally { clearTimeout(timer); }
    if (timedOut) throw new Error('Git review input timed out after ten minutes.');
    if (!truncated && await completion !== 0) throw new Error(`Git review input failed: ${redactor.text(stderr).slice(-4000)}`);
    return truncated;
  } finally { closeSync(fd); }
}
export async function writeReviewInput(homes: Homes, redactor: SecretRedactor, repo: string, range: string, path: string): Promise<void> {
  if (!await streamLog(homes, redactor, repo, ['--reverse', '-m', '--format=fuller', '-p', range], path)) return;
  const notice = `The patches exceed the 8 MB input cap. This file includes commit messages and file stats. Read the remaining patches with git log --reverse -m -p ${range} in your worktree.\n\n`;
  if (await streamLog(homes, redactor, repo, ['--reverse', '-m', '--format=fuller', '--stat', '--stat-width=120', range], path, notice)) throw new Error('Even the commit messages and file stats exceed the 8 MB review input cap. Read a smaller owner-selected range.');
}
