import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorControlSchema, Homes, ProjectSchema, doctorControlPath, readDocument } from '../packages/core/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import { journalCommand } from '../packages/cli/dist/journal-command.js';

let root: string | undefined, daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
test('the installed journal command rebuilds by project name through real authenticated local control', async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-journal-cli-')); const user = join(root, 'user'); mkdirSync(user);
  for (const name of ['.claude', '.codex', '.basic-memory']) { mkdirSync(join(user, name)); writeFileSync(join(user, name, 'canary'), 'Native bytes stay unchanged.'); }
  const homes = new Homes(join(root, 'data'), user);
  daemon = await startDaemon(0, { homes, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null });
  const app = daemon.application;
  app.hub.put('projects', 'journal_project', ProjectSchema, { schema: 'project-v1', id: 'journal_project', name: 'My journal project', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.memory' }, context: { state: 'none' } }, 0);
  app.projectWork.coordinatorLedger('journal_project').append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'The owner requested this work.' } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await journalCommand(['rebuild', 'My journal project'], homes);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('Project journal rebuilt at'));
  expect(readFileSync(join(homes.root, 'project-journal/journal_project/INDEX.md'), 'utf8')).toContain('My journal project journal');
  const control = readDocument(doctorControlPath(homes), DoctorControlSchema);
  const response = await fetch(`${control.origin}/api/local/journal/rebuild`, { method: 'POST', headers: { Origin: control.origin, Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'project-journal-rebuild-v1', project: 'journal_project' }) });
  expect(response.status).toBe(401);
  await expect(journalCommand(['delete', 'journal_project'], homes)).rejects.toThrow('Usage');
  for (const name of ['.claude', '.codex', '.basic-memory']) expect(readFileSync(join(user, name, 'canary'), 'utf8')).toBe('Native bytes stay unchanged.');
});
