// Ids that make a repeated delivery harmless must also keep different deliveries apart (P8 review C-3, C-4, RL-2): a thread message or
// mail the coordinator sends from a new device after a move never reuses the former device's id, a question the transport asks twice is
// one question, and recovery that runs again after a crash sends the same event, so a relay entry still waiting for it takes it.
// Live: the ledgers, the thread files and the outbox files; the hub and the thread service are in-memory stand-ins.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Homes, HubUnavailable, PlacementRecordSchema, ProjectDecisionSchema, SecretRedactor, ThreadSchema, type ProjectDecision, type ProjectMail, type Thread,
} from '../packages/core/dist/index.js';
import {
  DecisionItems, MailService, Outbox, ProjectLedgers, ProjectPaths, ThreadIndexPublisher, ThreadStore, coordinatorToolHandlers, recoverProjects,
} from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let paths: ProjectPaths;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'jevellan-delivery-ids-'))); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user')); paths = new ProjectPaths(homes); });
afterEach(async () => { for (const close of closers.splice(0)) await close(); rmSync(root, { recursive: true, force: true }); });
const at = '2026-10-05T10:00:00.000Z';

/** The coordinator tools of one device over in-memory decisions and mail, recording the ids they send. */
function coordinatorOn(deviceId: string, shared: { decisions: Map<string, ProjectDecision>; mail: ProjectMail[]; messages: string[] }) {
  const hub = {
    decisions: async () => [...shared.decisions.values()],
    decision: async (id: string) => { const document = shared.decisions.get(id); return document ? { document, revision: 1 } : null; },
    createDecision: async (raw: ProjectDecision) => {
      const decision = ProjectDecisionSchema.parse(raw);
      if (shared.decisions.has(decision.id)) throw Object.assign(new Error('This question already exists.'), { status: 409 });
      shared.decisions.set(decision.id, decision); return { document: decision, revision: 1 };
    },
    withdrawDecision: async () => { throw new Error('Not used.'); }, answerDecision: async () => { throw new Error('Not used.'); },
  };
  const decisions = new DecisionItems({ hub: hub as never, toCoordinator: async () => undefined, threads: () => ({}) as never, now: () => Date.parse(at) });
  const mail = new MailService({ hub: { thread: async () => ({ document: { projectId: 'project', title: 'Docs', isolation: 'main', state: 'idle' }, revision: 1 }),
    sendMail: async (sent: ProjectMail) => { shared.mail.push(sent); return { document: sent, revision: 1 }; } } as never,
  toCoordinator: async () => undefined, local: () => undefined, now: () => Date.parse(at) });
  const threads = { message: async (_projectId: string, _threadId: string, _from: string, _text: string, _interrupt: boolean, messageId: string) => {
    shared.messages.push(messageId); return { state: 'idle', delivery: 'queued' };
  } };
  return coordinatorToolHandlers({ deviceId, deviceName: deviceId, threads: threads as never, store: { get: () => undefined } as never, decisions, pullRequests: {} as never,
    hub: {} as never, ledgers: {} as never, mail, roster: async () => ({ schema: 'device-roster-v1', currentDeviceId: deviceId, devices: [] }) as never,
    now: () => Date.parse(at), memory: async () => { throw new Error('Not used.'); } });
}
const scope = { kind: 'coordinator' as const, projectId: 'project', turn: 3 };
const signal = new AbortController().signal;

test('a thread message and a mail the coordinator sends at the same turn number from another device after a move get ids of their own', async () => {
  const shared = { decisions: new Map<string, ProjectDecision>(), mail: [] as ProjectMail[], messages: [] as string[] };
  const before = coordinatorOn('dev_a', shared); const after = coordinatorOn('dev_b', shared);
  const input = { threadId: 'thread_x', message: 'Continue.', interrupt: false };
  await before.call(scope, 'jevellan_thread_message', input, signal); await before.call(scope, 'jevellan_thread_message', input, signal); await after.call(scope, 'jevellan_thread_message', input, signal);
  // A transport retry on one device repeats its id; the other device's id differs.
  expect(shared.messages[0]).toBe(shared.messages[1]); expect(shared.messages[2]).not.toBe(shared.messages[0]);
  const mail = { to: 'thread_x', subject: 'Heads up', body: 'I moved the docs.' };
  await before.call(scope, 'jevellan_mail_send', mail, signal); await before.call(scope, 'jevellan_mail_send', mail, signal); await after.call(scope, 'jevellan_mail_send', mail, signal);
  expect(shared.mail[0]!.id).toBe(shared.mail[1]!.id); expect(shared.mail[2]!.id).not.toBe(shared.mail[0]!.id);
});

test('a question the transport asks twice in one turn is one question with one id; the same question at another turn is a new one', async () => {
  const shared = { decisions: new Map<string, ProjectDecision>(), mail: [] as ProjectMail[], messages: [] as string[] };
  const tools = coordinatorOn('dev_a', shared);
  const input = { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] };
  const first = await tools.call(scope, 'jevellan_ask_user', input, signal) as { decisionId: string };
  const retry = await tools.call(scope, 'jevellan_ask_user', input, signal) as { decisionId: string };
  expect(retry.decisionId).toBe(first.decisionId); expect(shared.decisions.size).toBe(1);
  const later = await tools.call({ ...scope, turn: 4 }, 'jevellan_ask_user', input, signal) as { decisionId: string };
  expect(later.decisionId).not.toBe(first.decisionId); expect(shared.decisions.size).toBe(2);
});

/** A thread store whose next thread write fails once, as a crash between two writes would leave it. */
class CrashingStore extends ThreadStore {
  crashOnce = false;
  override update(threadId: string, mutate: (thread: Thread) => Thread, event?: Parameters<ThreadStore['update']>[2]): Thread {
    if (this.crashOnce) { this.crashOnce = false; throw new Error('Simulated crash.'); }
    return super.update(threadId, mutate, event);
  }
}

test('recovery that runs again after a crash before it rested the thread sends the same event, which the waiting relay entry takes', async () => {
  const redactor = new SecretRedactor(); const ledgers = new ProjectLedgers(paths, { redactor });
  const publisher = new ThreadIndexPublisher({ publishThread: async (_index, eventId) => ({ eventId }) });
  const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: [], isolation: 'worktree', runtime: 'fake', modelId: 'fixture', model: 'fixture',
    effortRequested: 'high', effortEffective: 'high', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: [], excludedModels: [], eligibleDevices: [], excludedDevices: [], jevCalls: [], decidedAt: at });
  new ThreadStore(paths, ledgers, publisher).create(ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_a', projectId: 'project', title: 'Fix login', task: 'The redirect loops.',
    createdAt: at, createdBy: 'owner', state: 'running', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_b', cwd: '', baseBranch: '', baseCommit: '',
    turns: 0, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0 }), { modelLabel: 'Fixture', accountLabel: 'Work' });
  // The coordinator is on another device and the hub is down: the event waits in the outbox.
  const outbox = new Outbox({ paths, hub: { coordinator: async () => { throw new HubUnavailable('coordinators'); }, putEnvelope: async () => { throw new HubUnavailable('envelopes'); } },
    deviceId: 'dev_a', redactor, timers: { outboxRetryMs: 3_600_000, outboxMaxMs: 3_600_000, now: () => Date.parse(at) } });
  closers.push(() => outbox.close());
  const recover = (store: ThreadStore, now: number) => recoverProjects({ paths, ledgers, store, coordinators: {} as never, redactor, now: () => now,
    toCoordinator: async (projectId, event) => { outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event }); } });
  const crashing = new CrashingStore(paths, ledgers, publisher); crashing.crashOnce = true;
  await expect(recover(crashing, Date.parse(at) + 60_000)).rejects.toThrow('Simulated crash.');
  expect(outbox.pending()).toHaveLength(1);
  // The next start: the thread is still running, so recovery sends the event again, a minute later.
  const store = new ThreadStore(paths, ledgers, publisher);
  await expect(recover(store, Date.parse(at) + 120_000)).resolves.toMatchObject({ restarted: ['thread_a'] });
  expect(outbox.pending()).toHaveLength(1);
  expect(store.get('thread_a')).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });
});
