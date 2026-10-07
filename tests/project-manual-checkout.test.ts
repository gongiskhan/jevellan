import { afterEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretRedactor, ThreadCreatedViewSchema } from '../packages/core/dist/index.js';
import { MainCheckout, ThreadGit } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const start = (f: ProjectFixture) => f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
  schema: 'thread-create-request-v1', clientRequestId: `req_${randomUUID()}`, title: 'Default to Active', task: 'Make Active the default app filter.', isolation: 'main',
});
const refs = (f: ProjectFixture) => f.git(f.checkout, 'for-each-ref', '--format=%(refname) %(objectname)');

test('Leave git to me edits an untracked app in its existing checkout without a remote, preserving staged and other owner work', async () => {
  const f = fixture = await projectFixture({ branchPolicy: 'external', remote: false, testCommand: "grep -q active app.js" });
  writeFileSync(join(f.checkout, 'value.txt'), 'staged owner work\n'); f.git(f.checkout, 'add', 'value.txt');
  writeFileSync(join(f.checkout, 'app.js'), "const filter = 'all';\n");
  writeFileSync(join(f.checkout, 'notes.txt'), 'untracked owner notes\n');
  const before = { head: f.git(f.checkout, 'rev-parse', 'HEAD'), refs: refs(f), index: f.git(f.checkout, 'diff', '--cached'), config: readFileSync(join(f.checkout, '.git/config'), 'utf8') };
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.cwd).toBe(f.checkout);
    expect(readFileSync(join(turn.input.cwd, 'app.js'), 'utf8')).toContain("'all'");
    expect(turn.input.systemAppend).toContain('Do not commit, stage, stash, reset, switch branches, push or open a pull request');
    writeFileSync(join(turn.input.cwd, 'app.js'), "const filter = 'active';\n");
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Active is the default.', changedFiles: ['app.js'] });
    return { status: 'completed' };
  }, forThread());
  const { threadId } = await start(f);
  const thread = await f.waitFor(() => f.thread(threadId), t => t.state === 'done');
  await f.app.projectWork.idle();
  expect(thread).toMatchObject({ isolation: 'main', gitPolicy: 'external' });
  expect(thread.publishedCommit).toBeUndefined(); expect(thread.pr).toBeUndefined();
  expect(readFileSync(join(f.checkout, 'app.js'), 'utf8')).toContain("'active'");
  expect(readFileSync(join(f.checkout, 'notes.txt'), 'utf8')).toBe('untracked owner notes\n');
  expect({ head: f.git(f.checkout, 'rev-parse', 'HEAD'), refs: refs(f), index: f.git(f.checkout, 'diff', '--cached'), config: readFileSync(join(f.checkout, '.git/config'), 'utf8') }).toEqual(before);
  expect(await f.app.conversations.ownership.current(f.project)).toMatchObject({ held: false });
  expect(f.ledgerText(threadId)).toContain('checkout-completed');
});

test('stopping a manual checkout thread leaves its edits and all git state in place, including after the owner changes branches', async () => {
  const f = fixture = await projectFixture({ branchPolicy: 'external', remote: false });
  f.fake.enqueueTurn(async turn => {
    writeFileSync(join(turn.input.cwd, 'app.js'), "const filter = 'active';\n");
    await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Changed the filter.', changedFiles: ['app.js'] });
    return { status: 'completed' };
  }, forThread());
  const { threadId } = await start(f);
  await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  f.git(f.checkout, 'switch', '-c', 'owner-work');
  const before = { head: f.git(f.checkout, 'rev-parse', 'HEAD'), branch: f.git(f.checkout, 'symbolic-ref', 'HEAD'), refs: refs(f), index: f.git(f.checkout, 'diff', '--cached') };
  const response = await f.request(`/api/projects/project/threads/${threadId}/stop`, 'POST', { schema: 'thread-stop-request-v1' });
  expect(response.ok).toBe(true); await f.app.projectWork.idle();
  expect(f.thread(threadId).state).toBe('stopped');
  expect(readFileSync(join(f.checkout, 'app.js'), 'utf8')).toContain("'active'");
  expect({ head: f.git(f.checkout, 'rev-parse', 'HEAD'), branch: f.git(f.checkout, 'symbolic-ref', 'HEAD'), refs: refs(f), index: f.git(f.checkout, 'diff', '--cached') }).toEqual(before);
  expect(await f.app.conversations.ownership.current(f.project)).toMatchObject({ held: false });
});

test('a captured automatic policy cannot undo edits after the current project policy leaves git to the owner', async () => {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(async turn => {
    writeFileSync(join(turn.input.cwd, 'value.txt'), 'keep this unfinished edit\n');
    await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'Edited the value.', changedFiles: ['value.txt'] });
    return { status: 'completed' };
  }, forThread());
  const { threadId } = await start(f); await f.waitFor(() => f.thread(threadId), t => t.state === 'idle');
  const thread = f.thread(threadId); const before = { head: f.git(f.checkout, 'rev-parse', 'HEAD'), refs: refs(f) };
  const redactor = new SecretRedactor();
  const main = new MainCheckout({ git: new ThreadGit({ homes: f.homes, redactor }), redactor, deviceId: f.app.device.deviceId,
    deviceName: f.deviceName, ownership: f.app.conversations.ownership });
  await main.stop({ ...f.project, branchPolicy: 'external' }, thread);
  expect(readFileSync(join(f.checkout, 'value.txt'), 'utf8')).toBe('keep this unfinished edit\n');
  expect({ head: f.git(f.checkout, 'rev-parse', 'HEAD'), refs: refs(f) }).toEqual(before);
  expect(await f.app.conversations.ownership.current(f.project)).toMatchObject({ held: false });
});
