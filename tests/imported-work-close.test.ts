import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CheckoutClaimSchema, DeviceConfigSchema, DeviceSchema, HandoffSchema, Homes, HubImportReceiptSchema,
  ProjectSchema, StretchSchema, readDocument, seedConfiguration, writeDocument, type Project } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';
import { exportHub, importHub } from '../packages/cli/dist/hub-migration.js';
import { Application } from '../apps/daemon/dist/index.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const key = (device: string, path: string) => createHash('sha256').update(`${device}\0${path}`).digest('hex');
const lock = (homes: Homes, path: string) => homes.at('locks', `${createHash('sha1').update(path).digest('hex')}.json`);

async function imported() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-imported-close-')); roots.push(root);
  const user = join(root, 'user'); mkdirSync(user);
  const source = new Homes(join(root, 'source'), user), destination = new Homes(join(root, 'destination'), user);
  for (const [homes, id] of [[source, 'dev_mini'], [destination, 'dev_pro']] as const) {
    homes.ensure(); writeDocument(homes.at('device.json'), DeviceConfigSchema, { schema: 'device-config-v1', deviceId: id, name: id, role: 'hub',
      hubUrl: `https://${id}.example.test`, url: `https://${id}.example.test`, version: '0.3.2' });
  }
  const hub = new HubDatabase(source, 'hub'); hub.configuration.put(seedConfiguration(), 0, { deviceId: 'dev_mini', source: 'install' });
  hub.put('devices', 'dev_mini', DeviceSchema, { schema: 'device-v1', id: 'dev_mini', name: 'Mini', role: 'hub', url: 'https://dev_mini.example.test', os: 'darwin', version: '0.3.2', joinedAt: new Date().toISOString() }, 0);
  const oldPath = join(root, 'owner-checkout'); mkdirSync(oldPath); writeFileSync(join(oldPath, 'foreign-changes'), 'Preserve exactly.');
  const project = ProjectSchema.parse({ schema: 'project-v1', id: 'project_old', name: 'Old project', paths: { dev_mini: oldPath }, branchPolicy: 'main',
    memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
  hub.put('projects', project.id, ProjectSchema, project, 0);
  const ledger = new ConversationLedger(source, 'con_old'), work = new ConversationWork(ledger);
  work.create({ title: 'git pull', projectId: project.id, ownerDeviceId: 'dev_mini' }); work.message('git pull', 'owner_request');
  const workId = work.load().conversation.work!.id;
  for (let n = 1; n <= 3; n++) {
    work.start(StretchSchema.parse({ schema: 'stretch-v2', n, workId, action: 'reply', modelId: 'fixture-model', runtime: 'fake', model: 'fixture',
      effortRequested: 'low', effortEffective: 'low', accountId: 'acc_fixture', deviceId: 'dev_mini', decisionId: `decision_${n}`, startedAt: new Date().toISOString(),
      status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, gitBefore: '1'.repeat(40) }), work.load().conversation.generation);
    ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: n, action: 'reply', status: 'done', summary: 'Reply only.', evidence: [],
      findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] }));
    work.finish(n, { status: 'completed', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }, false);
  }
  work.pause('Foreign checkout files stay untouched.', 'blocked');
  const claim = CheckoutClaimSchema.parse({ schema: 'checkout-claim-v1', deviceId: 'dev_mini', path: oldPath, conversationId: 'con_old', conversationTitle: 'git pull',
    workId, held: true, pid: process.pid, updatedAt: new Date().toISOString() });
  hub.put('checkout-ownership', key('dev_mini', oldPath), CheckoutClaimSchema, claim, 0);
  writeDocument(lock(source, oldPath), CheckoutClaimSchema, claim);
  const history = readFileSync(ledger.segments()[0]!); const blob = ledger.putBlob({ preserved: 'Historical attachment.' }); const blobBytes = readFileSync(join(ledger.dir, blob.ref));
  hub.close();
  const archive = join(root, 'migration.enc'), passphrase = 'migration fixture phrase';
  await exportHub({ homes: source, out: archive, destinationName: 'Pro', passphrase });
  await importHub({ homes: destination, archive, passphrase });
  return { root, source, destination, oldPath, project, workId, history, blob, blobBytes, claimKey: key('dev_mini', oldPath) };
}
function closeInput(view: Awaited<ReturnType<Application['conversations']['view']>>, id = 'close_imported') {
  return { schema: 'settle-work-v1', clientRequestId: id, workId: (view.conversation.work ?? view.closedWorks.at(-1))!.id,
    generation: view.conversation.generation, choice: 'keep' };
}

test('Keep closes receipt-bound unbound reply-only work, releasing only its imported claim and preserving files/history', async () => {
  const f = await imported(); const app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() });
  try {
    await app.conversations.ready;
    const row = (await app.state.projects.get(f.project.id))!;
    const bound: Project = { ...row.project, paths: { ...row.project.paths, dev_pro: join(f.root, 'new-checkout') } };
    expect(() => app.state.projects.put(bound, row.revision)).toThrow('This project is in use.');
    const request = closeInput(await app.conversations.view('con_old'));
    await app.conversations.settle('con_old', request); await app.conversations.wait('con_old');
    const after = await app.conversations.view('con_old');
    expect(after.conversation.work, after.settlements.at(-1)?.reason).toBeNull(); expect(after.closedWorks.at(-1)).toMatchObject({ id: f.workId, closedAs: 'closed-by-you' });
    expect(after.settlements.at(-1)).toMatchObject({ choice: 'keep', status: 'completed', retained: false });
    expect(after.stretches.map(step => step.action)).toEqual(['reply', 'reply', 'reply']);
    expect(app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)?.document.held).toBe(false);
    expect(app.hub.get('checkout-ownership', key('dev_pro', f.oldPath), CheckoutClaimSchema)).toBeNull();
    expect(existsSync(lock(f.destination, f.oldPath))).toBe(false); expect(existsSync(lock(f.source, f.oldPath))).toBe(true);
    expect(readFileSync(join(f.oldPath, 'foreign-changes'), 'utf8')).toBe('Preserve exactly.');
    const kept = readFileSync(f.destination.at('conversations', 'con_old', 'ledger', '000001.jsonl'));
    expect(kept.subarray(0, f.history.length)).toEqual(f.history);
    expect(readFileSync(f.destination.at('conversations', 'con_old', f.blob.ref))).toEqual(f.blobBytes);
    await app.conversations.settle('con_old', request); await app.conversations.wait('con_old');
    expect(readFileSync(f.destination.at('conversations', 'con_old', 'ledger', '000001.jsonl'))).toEqual(kept);
    expect((await app.state.projects.put(bound, row.revision)).project.paths.dev_pro).toBe(bound.paths.dev_pro);
  } finally { await app.close(); }
});

test.each(['base commit', 'changed reply', 'local lock', 'new owner', 'new claim', 'recent claim', 'wrong receipt', 'publish', 'discard'] as const)(
  '%s never bypasses ordinary settlement or frees imported ownership', async mode => {
    const f = await imported(); const app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() });
    try {
      await app.conversations.ready; const ledger = app.conversations.ledger('con_old'); const work = new ConversationWork(ledger);
      const row = app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)!;
      if (mode === 'base commit') work.baseCommit('1'.repeat(40));
      if (mode === 'changed reply') {
        const view = work.load(); const next = { ...view.stretches[0]!, n: 4, status: 'running' }; delete next.endedAt;
        work.start(StretchSchema.parse(next), view.conversation.generation);
        ledger.acceptHandoff(HandoffSchema.parse({ ...view.handoffs[0], stretch: 4, changedFiles: ['foreign-changes'] }));
        work.finish(4, { status: 'completed', usage: view.stretches[0]!.usage, gitAfter: '2'.repeat(40) }, true); work.pause('Preserve changes.', 'blocked');
      }
      if (mode === 'local lock') writeDocument(lock(f.destination, f.oldPath), CheckoutClaimSchema, row.document);
      if (mode === 'new owner') app.hub.put('checkout-ownership', f.claimKey, CheckoutClaimSchema, { ...row.document, workId: 'other_work' }, row.revision);
      if (mode === 'new claim') app.hub.put('checkout-ownership', key('dev_pro', f.oldPath), CheckoutClaimSchema, row.document, 0);
      if (mode === 'recent claim') app.hub.put('checkout-ownership', f.claimKey, CheckoutClaimSchema, { ...row.document, updatedAt: '2099-01-01T00:00:00.000Z' }, row.revision);
      if (mode === 'wrong receipt') {
        const receipt = readDocument(f.destination.at('hub-import.json'), HubImportReceiptSchema);
        writeDocument(f.destination.at('hub-import.json'), HubImportReceiptSchema, { ...receipt, unboundProjectIds: [] });
      }
      const before = app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)!;
      await app.conversations.settle('con_old', { ...closeInput(await app.conversations.view('con_old')), ...(mode === 'publish' || mode === 'discard' ? { choice: mode } : {}) });
      await app.conversations.wait('con_old');
      const after = await app.conversations.view('con_old'); expect(after.conversation.work?.id).toBe(f.workId); expect(after.settlements.at(-1)?.status).toBe('blocked');
      expect(app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)).toEqual(before);
      expect(readFileSync(join(f.oldPath, 'foreign-changes'), 'utf8')).toBe('Preserve exactly.');
    } finally { await app.close(); }
  });

test('a lost imported release reply is safely reconciled after restart without clearing a new owner', async () => {
  const f = await imported(); let app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() });
  try {
    await app.conversations.ready;
    const store = app.conversations.ownership.hub; const original = store.releaseUnboundImport!.bind(store); let lost = false;
    const fault = vi.spyOn(store, 'releaseUnboundImport').mockImplementation(async (projectId, owner) => {
      const result = await original(projectId, owner);
      if (!lost) { lost = true; throw new Error('Simulated lost release reply.'); }
      return result;
    });
    await app.conversations.settle('con_old', closeInput(await app.conversations.view('con_old'), 'lost_reply')); await app.conversations.wait('con_old');
    expect((await app.conversations.view('con_old')).settlements.at(-1)).toMatchObject({ status: 'blocked', reason: 'Simulated lost release reply.' });
    expect(app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)?.document.held).toBe(false);
    fault.mockRestore(); await app.close();
    app = new Application({ homes: f.destination, timers: false, runtimes: () => new Map() }); await app.conversations.ready;
    const row = app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)!;
    const otherKey = key('dev_pro', join(f.root, 'other-checkout'));
    app.hub.put('checkout-ownership', otherKey, CheckoutClaimSchema, { ...row.document, path: join(f.root, 'other-checkout'), held: true, workId: 'other_work' }, 0);
    const other = app.hub.get('checkout-ownership', otherKey, CheckoutClaimSchema);
    await app.conversations.settle('con_old', closeInput(await app.conversations.view('con_old'), 'retry_after_restart')); await app.conversations.wait('con_old');
    expect((await app.conversations.view('con_old')).conversation.work).toBeNull();
    expect(app.hub.get('checkout-ownership', f.claimKey, CheckoutClaimSchema)).toEqual(row);
    expect(app.hub.get('checkout-ownership', otherKey, CheckoutClaimSchema)).toEqual(other);
    expect(readFileSync(join(f.oldPath, 'foreign-changes'), 'utf8')).toBe('Preserve exactly.');
  } finally { await app.close(); }
});
