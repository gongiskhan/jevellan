import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSchema, ProjectVisibility, probeRepositoryVisibility, type RepositoryVisibility, type VisibilityProbe, type runOwnedCommand } from '../packages/core/dist/index.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-visibility-'))); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const result = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
function project() {
  const path = join(root, 'project'); execFileSync('git', ['init', '--initial-branch=main', path], { stdio: 'ignore' });
  return ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Visibility fixture', paths: { device: path }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
}

test.each(['PUBLIC', 'PRIVATE', 'INTERNAL'] as const)('visibility probe reads %s from the selected checkout without inherited repository overrides', async (visibility) => {
  vi.stubEnv('GH_REPO', 'fixture/wrong-repository'); vi.stubEnv('JEVELLAN_TEST_JEV_KEY', 'fixture-credential');
  const run = vi.fn<typeof runOwnedCommand>().mockResolvedValue(result(JSON.stringify({ visibility })));
  expect(await probeRepositoryVisibility(root, run)).toBe(visibility);
  const [command, args, options] = run.mock.calls[0]!;
  expect(command).toBe('gh'); expect(args).toEqual(['repo', 'view', '--json', 'visibility']);
  expect(options).toMatchObject({ cwd: root, timeoutMs: 5000, env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  expect(options.env?.GH_REPO).toBeUndefined(); expect(options.env?.JEVELLAN_TEST_JEV_KEY).toBeUndefined();
});

test.each([
  { name: 'unavailable authentication', value: { ...result(''), code: 1 } },
  { name: 'timeout', value: { ...result('{"visibility":"PUBLIC"}'), timedOut: true } },
  { name: 'invalid JSON', value: result('not JSON') },
  { name: 'missing visibility', value: result('{}') },
  { name: 'unexpected visibility', value: result('{"visibility":"public"}') },
])('$name remains unknown, never a private-repository claim', async ({ value }) => {
  expect(await probeRepositoryVisibility(root, vi.fn<typeof runOwnedCommand>().mockResolvedValue(value))).toBe('UNKNOWN');
});

test('missing CLI remains unknown', async () => {
  const run = vi.fn<typeof runOwnedCommand>().mockRejectedValue(new Error('spawn gh ENOENT'));
  expect(await probeRepositoryVisibility(root, run)).toBe('UNKNOWN');
});

test('concurrent views share a probe, while reopening observes changed visibility', async () => {
  const definition = project(); let complete!: (value: RepositoryVisibility) => void;
  const probe = vi.fn<VisibilityProbe>().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; })).mockResolvedValue('PRIVATE');
  const service = new ProjectVisibility(probe); const first = service.inspect(definition, 'device'); const second = service.inspect({ ...definition, id: 'alias' }, 'device');
  await Promise.resolve(); expect(probe).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledWith(definition.paths.device); complete('PUBLIC');
  const views = await Promise.all([first, second]);
  expect(views[0]).toMatchObject({ schema: 'project-visibility-v1', projectId: 'project', deviceId: 'device', visibility: 'PUBLIC' });
  expect(views[1]).toMatchObject({ projectId: 'alias', visibility: 'PUBLIC' }); expect(Number.isFinite(Date.parse(views[0]!.checkedAt))).toBe(true);
  expect((await service.inspect(definition, 'device')).visibility).toBe('PRIVATE'); expect(probe).toHaveBeenCalledTimes(2);
});

test('failed probes are not cached and do not prevent a later successful check', async () => {
  const definition = project(); const probe = vi.fn<VisibilityProbe>().mockImplementationOnce(() => { throw new Error('unavailable'); }).mockResolvedValue('PUBLIC');
  const service = new ProjectVisibility(probe);
  expect((await service.inspect(definition, 'device')).visibility).toBe('UNKNOWN');
  expect((await service.inspect(definition, 'device')).visibility).toBe('PUBLIC'); expect(probe).toHaveBeenCalledTimes(2);
});

test('missing, disallowed and nested checkouts never fall back to another repository', async () => {
  const definition = project(); const probe = vi.fn<VisibilityProbe>().mockResolvedValue('PUBLIC'); const service = new ProjectVisibility(probe);
  await expect(service.inspect(definition, 'other-device')).rejects.toThrow("isn't checked out");
  await expect(service.inspect({ ...definition, allowedDevices: [] }, 'device')).rejects.toThrow("isn't set up");
  const nested = join(definition.paths.device!, 'nested'); mkdirSync(nested);
  await expect(service.inspect({ ...definition, paths: { device: nested } }, 'device')).rejects.toThrow("isn't checked out"); expect(probe).not.toHaveBeenCalled();
});
