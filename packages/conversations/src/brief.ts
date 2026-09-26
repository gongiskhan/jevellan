import { FindingSchema, stableJson, type Action, type GitWorkspace, type Handoff, type Project } from '@jevellan/core';
import type { ConversationLedger } from './ledger.js';
import type { ConversationView, WorkMessage } from './work.js';
import { ACTION_DESCRIPTIONS } from './actions.js';

export type MemoryExcerpt = { title: string; permalink: string; excerpt: string; unresolved?: boolean };
/** The change a review step inspects: computed by code with read-only Git, because read-only agents have no shell. */
export type ChangeUnderReview = { description: string; diff: string; files: string[] };
type BriefOptions = { action: Action; project: Pick<Project, 'name' | 'branchPolicy'>; cwd: string; memoryWrite: boolean; memory?: MemoryExcerpt[]; change?: ChangeUnderReview; tokenCap?: number };
export const approximateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);

/** Diff from the work's base commit to HEAD, plus any uncommitted change; without a base commit, only the uncommitted change. */
export async function changeUnderReview(git: Pick<GitWorkspace, 'head' | 'clean' | 'diff' | 'uncommittedDiff' | 'changedFiles'>, baseCommit?: string): Promise<ChangeUnderReview> {
  const head = await git.head(); const clean = await git.clean();
  const uncommitted = clean ? '' : await git.uncommittedDiff(); const dirtyFiles = clean ? [] : await git.changedFiles();
  if (!baseCommit) return { description: `This work has no base commit, so this is the uncommitted change in the working tree against HEAD ${head.slice(0, 12)}.`, diff: uncommitted, files: dirtyFiles };
  const committed = baseCommit === head ? '' : await git.diff(baseCommit, head);
  const files = [...new Set([...(baseCommit === head ? [] : await git.changedFiles(baseCommit, head)), ...dirtyFiles])];
  return { description: `Diff from the work's base commit ${baseCommit.slice(0, 12)} to HEAD ${head.slice(0, 12)}${clean ? '' : ', plus the uncommitted change in the working tree'}.`, diff: committed + uncommitted, files };
}

// Whole files first, in Git's order; a file that does not fit is named instead. If none fits, the first is cut, and says so.
function renderChange(change: ChangeUnderReview, budget: number): string {
  const chunks = change.diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.trim());
  const lines = change.diff.split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const path = (chunk: string) => /^diff --git a\/(.+?) b\//.exec(chunk)?.[1] ?? chunk.split('\n')[0]!;
  const files = [...new Set([...change.files, ...chunks.map(path)])];
  const head = [change.description, `${files.length} file${files.length === 1 ? '' : 's'} changed, ${added} insertion${added === 1 ? '' : 's'}(+), ${removed} deletion${removed === 1 ? '' : 's'}(-).`, 'Changed files:', ...files.map((file) => `- ${file}`)].join('\n');
  if (!chunks.length) return `${head}\n${files.length ? 'No textual diff is available; read these files with your read tools.' : 'There is no change to review.'}`;
  const kept: string[] = []; const left: string[] = [];
  const size = (parts: string[]) => approximateTokens([head, ...parts].join('\n'));
  for (const chunk of chunks) { if (size([...kept, chunk]) + 120 <= budget) kept.push(chunk); else left.push(path(chunk)); }
  let cut = '';
  if (!kept.length) {
    let text = chunks[0]!; left.shift();
    while (text && size([text]) + 160 > budget) text = text.slice(0, Math.floor(text.length * 0.8));
    cut = `The diff of ${path(chunks[0]!)} was cut to fit this brief.`; if (text) kept.push(text);
  }
  const note = [cut, left.length ? `Left out of this brief to keep it within its size: ${left.join(', ')}.` : '', cut || left.length ? 'Read the left-out parts with your read tools (Read, Grep, Glob).' : ''].filter(Boolean).join(' ');
  return [head, '```diff', kept.join('').trimEnd(), '```', note].filter(Boolean).join('\n');
}

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
  // The change gets up to 40% of the budget, and shrinks only after every other trimmable section.
  let changeBudget = Math.floor(cap * 0.4);
  const renderMessage = (message: WorkMessage) => hiddenMessages.has(message.id) ? `(Earlier message: ledger/${message.id})` : `${message.type === 'note' ? '(note)\n' : ''}${message.text}`;
  const renderHandoff = (handoff: Handoff) => stableJson({ pointer: `handoffs/${handoff.stretch}`, action: handoff.action, status: handoff.status, summary: handoff.summary, blockers: handoff.blockers, failedApproaches: handoff.failedApproaches, proposedNext: handoff.proposedNext, evidence: handoff.evidence, ...(handoff.testsRun ? { testsRun: handoff.testsRun } : {}) });
  const render = () => [
    '# This request', work.request,
    '# Everything else you said about this work', messages.map(renderMessage).join('\n\n'),
    '# Constraints', work.constraints.join('\n'), '# Plan', plan,
    '# Where things stand', view.summary.state, `Decisions so far: ${view.summary.decisions.join('\n')}`,
    '# Recent handoffs', handoffs.map(renderHandoff).join('\n\n'),
    '# Findings', findings.map((finding) => `${finding.claim}\n${finding.pointer} (${finding.ref})`).join('\n\n'),
    ...(options.change ? ['# Change under review', renderChange(options.change, changeBudget)] : []),
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
  if (options.change && approximateTokens(text) > cap) {
    while (approximateTokens(text) > cap && changeBudget > 300) { changeBudget = Math.floor(changeBudget / 2); text = render(); }
    omitted.push('change-under-review');
  }
  return { text, approximateTokens: approximateTokens(text), overBudget: approximateTokens(text) > cap, omitted };
}
