import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConversationFileSchema, gitEnvironment, inside, type SecretRedactor } from '@jevellan/core';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
const sensitive = /(?:^|\/)(?:\.git|\.env[^/]*|\.netrc|\.npmrc|credentials\.json|auth\.json|vault\.json|internal-token|id_rsa[^/]*)(?:\/|$)|\.(?:key|pem|crt|p12|pfx)$/i;
function fileReference(root: string, raw: string): { path: string; line?: number } {
  const match = /^(.*?)(?::([1-9]\d*)(?::\d+)?|#L([1-9]\d*)(?:-L?\d+)?)$/.exec(raw);
  const name = match?.[1] ?? raw; const line = match ? Number(match[2] ?? match[3]) : undefined;
  if (name.includes('\0') || name.includes('\\') || name.split('/').includes('..') || /^[a-z][a-z\d+.-]*:/i.test(name)) throw failure(403, 'This file is outside the conversation project.');
  const absolute = isAbsolute(name) ? name : resolve(root, name);
  const path = relative(root, absolute);
  if (!inside(root, absolute) || !path || sensitive.test(path)) throw failure(403, 'This file is not available in the project viewer.');
  if (line !== undefined && !Number.isSafeInteger(line)) throw failure(400, 'Invalid file line.');
  return { path, ...(line === undefined ? {} : { line }) };
}
async function git(root: string, args: string[]): Promise<Buffer> {
  try {
    const result = await promisify(execFile)('git', ['--no-pager', '--literal-pathspecs', ...args], { cwd: root, env: gitEnvironment(), encoding: 'buffer', maxBuffer: MAX_FILE_BYTES + 1, timeout: 10_000 });
    return result.stdout;
  } catch { throw failure(422, 'The recorded file version could not be read.'); }
}
async function committed(root: string, path: string, commit: string): Promise<Buffer | undefined> {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw failure(400, 'File evidence requires an exact commit.');
  const entry = (await git(root, ['ls-tree', '-z', commit, '--', path])).toString('utf8');
  if (!entry) return undefined;
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== path) throw failure(415, 'Only regular project files can be opened.');
  const size = Number((await git(root, ['cat-file', '-s', match[2]!])).toString('utf8'));
  if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw failure(413, 'This file is too large to open in the browser (2 MB maximum).');
  return git(root, ['cat-file', 'blob', match[2]!]);
}
async function working(root: string, path: string): Promise<Buffer> {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    try { if ((await lstat(current)).isSymbolicLink()) throw failure(403, 'Open the original project file instead of its symbolic link.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw failure(404, 'This file is no longer in the working copy.'); throw error; }
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure(415, 'Only regular project files can be opened.');
    if (stat.size > MAX_FILE_BYTES) throw failure(413, 'This file is too large to open in the browser (2 MB maximum).');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let size = 0;
    while (size < bytes.length) { const result = await handle.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > MAX_FILE_BYTES) throw failure(413, 'This file is too large to open in the browser (2 MB maximum).');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png' as const;
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg' as const;
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif' as const;
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp' as const;
  return undefined;
}
/** Read-only evidence; no checkout mutation, model call or remote fetch. */
export async function readProjectFile(options: { root: string; ref: string; commit?: string; before?: string; redactor: SecretRedactor }) {
  const { path, line } = fileReference(options.root, options.ref);
  let commit = options.commit; let source: 'checkpoint' | 'before-step' | 'working-tree' = commit ? 'checkpoint' : 'working-tree';
  let bytes = commit ? await committed(options.root, path, commit) : await working(options.root, path);
  if (!bytes && options.before) { commit = options.before; source = 'before-step'; bytes = await committed(options.root, path, commit); }
  if (!bytes) throw failure(404, 'This file was not present in the recorded step. Open the working copy to inspect its current contents.');
  const mime = imageMime(bytes); let content: string;
  if (mime) content = bytes.toString('base64');
  else {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure(415, 'This binary file cannot be previewed.'); }
    if (content.includes('\0')) throw failure(415, 'This binary file cannot be previewed.');
    content = options.redactor.text(content);
  }
  return ConversationFileSchema.parse({ schema: 'conversation-file-v1', path, source, commit, line, kind: mime ? 'image' : /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text', encoding: mime ? 'base64' : 'utf8', mime, content, bytes: bytes.length });
}
