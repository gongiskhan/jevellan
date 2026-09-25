import { FindingSchema, stableJson, type Action, type Handoff, type Project } from '@jevellan/core';
import type { ConversationLedger } from './ledger.js';
import type { ConversationView, WorkMessage } from './work.js';
import { ACTION_DESCRIPTIONS } from './actions.js';

export type MemoryExcerpt = { title: string; permalink: string; excerpt: string; unresolved?: boolean };
type BriefOptions = { action: Action; project: Pick<Project, 'name' | 'branchPolicy'>; cwd: string; memoryWrite: boolean; memory?: MemoryExcerpt[]; tokenCap?: number };
export const approximateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);

export function buildBrief(view: ConversationView, ledger: ConversationLedger, options: BriefOptions): { text: string; approximateTokens: number; overBudget: boolean; omitted: string[] } {
  const work = view.conversation.work;
  if (!work) throw new Error('A brief requires open work.');
  const cap = options.tokenCap ?? 12_000;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Invalid brief budget.');
  const active = new Set(view.stretches.filter((stretch) => stretch.workId === work.id && stretch.status !== 'undone').map((stretch) => stretch.n));
  const messageIds = new Set(work.messageEventIds);
  const messages = view.messages.filter((message) => messageIds.has(String(message.id)));
  const handoffs = view.handoffs.filter((handoff) => active.has(handoff.stretch)).slice(-3);
  const findings = [
    ...ledger.events().filter((event) => event.type === 'finding' && event.stretch !== undefined && active.has(event.stretch)).map((event) => ({ ...FindingSchema.parse(ledger.data(event)), ref: `ledger/${event.id}` })),
    ...handoffs.flatMap((handoff) => handoff.findings.map((finding) => ({ ...finding, ref: `handoffs/${handoff.stretch}` }))),
  ];
  let plan = '';
  if (work.latestPlanRef) {
    const content = ledger.readBlob(work.latestPlanRef);
    plan = `${work.approvedPlanRef === work.latestPlanRef ? '(approved)\n' : ''}${typeof content === 'string' ? content : stableJson(content)}`;
  }
  const memory: string[] = [];
  for (const note of options.memory ?? []) {
    const heading = `${note.title}${note.unresolved ? ' (conflicting versions, unresolved)' : ''}\n${note.permalink}\n`;
    let excerpt = note.excerpt;
    while (excerpt && approximateTokens([...memory, heading + excerpt].join('\n\n')) > 2000) excerpt = excerpt.slice(0, Math.max(0, excerpt.length - 100));
    if (approximateTokens([...memory, heading + excerpt].join('\n\n')) > 2000) break;
    memory.push(heading + excerpt);
  }
  const omitted: string[] = []; const hiddenMessages = new Set<number>();
  const renderMessage = (message: WorkMessage) => hiddenMessages.has(message.id) ? `(Earlier message: ledger/${message.id})` : `${message.type === 'note' ? '(note)\n' : ''}${message.text}`;
  const renderHandoff = (handoff: Handoff) => stableJson({ pointer: `handoffs/${handoff.stretch}`, action: handoff.action, status: handoff.status, summary: handoff.summary, blockers: handoff.blockers, failedApproaches: handoff.failedApproaches, proposedNext: handoff.proposedNext, evidence: handoff.evidence, ...(handoff.testsRun ? { testsRun: handoff.testsRun } : {}) });
  const render = () => [
    '# This request', work.request,
    '# Everything else you said about this work', messages.map(renderMessage).join('\n\n'),
    '# Constraints', work.constraints.join('\n'), '# Plan', plan,
    '# Where things stand', view.summary.state, `Decisions so far: ${view.summary.decisions.join('\n')}`,
    '# Recent handoffs', handoffs.map(renderHandoff).join('\n\n'),
    '# Findings', findings.map((finding) => `${finding.claim}\n${finding.pointer} (${finding.ref})`).join('\n\n'),
    '# Memory', memory.join('\n\n'), 'Use the memory tools to read more.',
    options.memoryWrite ? 'Record anything about this project that future work needs.' : 'If something is worth remembering, propose it with memory_propose; Jevellan decides whether to save it.',
    '# Your step', `Action: ${options.action}. ${ACTION_DESCRIPTIONS[options.action]}`,
    `Stretch: ${view.conversation.stretchCount + 1}. Use this exact stretch number in jevellan_handoff.`,
    `Project: ${options.project.name} at ${options.cwd}. Branch policy: ${options.project.branchPolicy}.`,
    'Finish by calling jevellan_handoff exactly once.',
  ].join('\n\n');
  let text = render();
  while (approximateTokens(text) > cap && handoffs.length) { omitted.push(`handoffs/${handoffs.shift()!.stretch}`); text = render(); }
  while (approximateTokens(text) > cap && findings.length) { omitted.push(findings.shift()!.ref); text = render(); }
  // Preserve the first and latest follow-up; only the middle is replaced by pointers.
  for (const message of messages.slice(1, -1)) {
    if (approximateTokens(text) <= cap) break;
    hiddenMessages.add(message.id); omitted.push(`ledger/${message.id}`); text = render();
  }
  return { text, approximateTokens: approximateTokens(text), overBudget: approximateTokens(text) > cap, omitted };
}
