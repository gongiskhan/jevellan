import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor } from '../packages/core/dist/index.js';
import { ProjectApps, ProjectPaths } from '../packages/projects/dist/index.js';

let root = ''; let apps: ProjectApps | undefined;
afterEach(async () => { await apps?.close(); apps = undefined; if (root) await rm(root, { recursive: true, force: true }); root = ''; });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'jevellan-managed-app-'));
  const homes = new Homes(join(root, 'data'), join(root, 'user')), paths = new ProjectPaths(homes);
  const cwd = paths.worktree('project_fixture', 'thread_fixture'), projectDirectory = join(root, 'checkout');
  await mkdir(cwd, { recursive: true }); await mkdir(projectDirectory);
  apps = new ProjectApps(homes, { publish: async port => ({ access: 'local', url: `http://127.0.0.1:${port}/` }), remove: async () => undefined }, new SecretRedactor());
  return { homes, paths, scope: { projectId: 'project_fixture', threadId: 'thread_fixture', cwd, projectDirectory } };
}
test('managed worktrees can publish static and command previews without staging another copy', async () => {
  const { scope } = await fixture();
  await writeFile(join(scope.cwd, 'index.html'), '<h1>Managed preview</h1>');
  const page = await apps!.start(scope, { kind: 'static' });
  expect(await (await fetch(page.url)).text()).toContain('Managed preview');
  await writeFile(join(scope.cwd, 'server.mjs'), `import {createServer} from 'node:http';createServer((_req,res)=>res.end('Managed command preview')).listen(Number(process.env.PORT),process.env.HOST);`);
  const command = await apps!.start(scope, { kind: 'command', command: process.execPath, args: ['server.mjs'] });
  expect(await (await fetch(command.url)).text()).toBe('Managed command preview');
});
test('the managed-worktree allowance preserves runtime and native homes and rejects aliases into them', async () => {
  const { homes, paths, scope } = await fixture();
  const account = homes.ensure('homes', 'codex', 'account_fixture'), native = join(homes.userHome, '.codex');
  await mkdir(native, { recursive: true });
  for (const directory of [account, native]) {
    const auth = join(directory, 'auth.json'); await writeFile(auth, 'fixture-auth-bytes');
    await expect(apps!.start({ ...scope, cwd: directory, projectDirectory: directory }, { kind: 'static' })).rejects.toThrow('cannot serve agent or runtime homes');
    expect(await readFile(auth, 'utf8')).toBe('fixture-auth-bytes');
  }
  const alias = paths.worktree('project_fixture', 'thread_alias');
  await symlink(account, alias);
  await expect(apps!.start({ ...scope, threadId: 'thread_alias', cwd: alias }, { kind: 'static' })).rejects.toThrow();
  await symlink(account, join(scope.cwd, 'account-link'));
  await expect(apps!.start(scope, { kind: 'static', directory: 'account-link' })).rejects.toThrow();
  const sibling = paths.worktree('project_fixture', 'thread_other'); await mkdir(sibling);
  await expect(apps!.start(scope, { kind: 'static', directory: sibling })).rejects.toThrow('inside this thread');
});
