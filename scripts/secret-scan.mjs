import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const patterns = [
  /\bsk-(?:ant-[A-Za-z0-9_-]*|proj-[A-Za-z0-9_-]*|[A-Za-z0-9_-]{20,})/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bjva_[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
];
// Exact source text that matches a pattern but is not a credential. Each entry is removed before
// matching, so any real token elsewhere in the same file is still blocked.
const allowed = [
  // scripts/spikes/live-conversation-journeys.mjs (J4): a random value in the OAuth token shape, stored to test invalid-token recovery.
  "`sk-ant-oat01-${randomBytes(40).toString('base64url')}`",
];
const flagged = (text) => patterns.some((pattern) => pattern.test(allowed.reduce((rest, entry) => rest.replaceAll(entry, ''), text)));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: null, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error('Could not inspect git objects; refusing to push.');
  return result.stdout;
}

export function scanSecrets(cwd, revisions = ['--all'], environment = process.env) {
  const values = Object.entries(environment)
    .filter(([name, value]) => name.startsWith('JEVELLAN_TEST_') && value)
    .map(([name, value]) => [name, Buffer.from(value)]);
  const objects = git(cwd, ['rev-list', '--objects', '--no-object-names', ...revisions]).toString().trim().split('\n').filter(Boolean);
  const violations = [];
  for (const oid of new Set(objects)) {
    if (git(cwd, ['cat-file', '-t', oid]).toString().trim() !== 'blob') continue;
    const blob = git(cwd, ['cat-file', 'blob', oid]);
    if (flagged(blob.toString('utf8'))) violations.push({ oid, reason: 'token or private-key pattern' });
    for (const [name, value] of values) {
      if (blob.includes(value)) violations.push({ oid, reason: `value of ${name}` });
    }
  }
  return violations;
}

export function scanWorkingTree(cwd, environment = process.env) {
  const values = Object.entries(environment).filter(([name, value]) => name.startsWith('JEVELLAN_TEST_') && value);
  const files = git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  const violations = [];
  for (const file of new Set(files)) {
    let stat;
    try { stat = lstatSync(join(cwd, file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(join(cwd, file))) : readFileSync(join(cwd, file));
    if (flagged(bytes.toString('utf8'))) violations.push({ file, reason: 'token or private-key pattern' });
    for (const [name, value] of values) if (bytes.includes(Buffer.from(value))) violations.push({ file, reason: `value of ${name}` });
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const revisions = process.argv.includes('--pre-push')
      ? readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/)[1]).filter((oid) => oid && !/^0+$/.test(oid))
      : ['--all'];
    const violations = revisions.length ? scanSecrets(process.cwd(), revisions) : [];
    for (const item of violations) console.error(`Push blocked: ${item.reason} in git blob ${item.oid}.`);
    const pending = process.argv.includes('--worktree') ? scanWorkingTree(process.cwd()) : [];
    for (const item of pending) console.error(`Secret scan blocked: ${item.reason} in file ${item.file}.`);
    if (violations.length || pending.length) process.exitCode = 1;
    else console.log('Secret scan passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Secret scan failed.');
    process.exitCode = 1;
  }
}
