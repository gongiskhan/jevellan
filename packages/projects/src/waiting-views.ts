import { ProjectLedgerDataSchemas, ProjectWaitingItemsViewSchema, type ProjectDecision, type ProjectLedgerEvent,
  type ProjectViewNotice, type ProjectWaitingItem, type ProjectWaitingItemsView, type ProjectWorkView } from '@jevellan/core';

type Titles = (id: string) => string | undefined;
export function decisionSource(decision: Pick<ProjectDecision, 'from' | 'threadId'>, titles: Titles): string {
  const title = decision.from === 'thread' && decision.threadId ? titles(decision.threadId) : undefined;
  return decision.from === 'thread' ? `From "${title ?? 'a thread'}"` : 'From the coordinator';
}
export function sentText(decision: Pick<ProjectDecision, 'from' | 'threadId'>, titles: Titles): string {
  if (decision.from === 'coordinator') return 'Sent to the coordinator.';
  const title = decision.threadId ? titles(decision.threadId) : undefined;
  return title ? `Sent to "${title}".` : 'Sent to the thread.';
}
export function showSent(sent: { known: readonly string[] } | undefined, open: readonly Pick<ProjectDecision, 'id'>[]): boolean {
  return !!sent && open.every(decision => sent.known.includes(decision.id));
}
export function waitingItem(decision: ProjectDecision, number: number, titles: Titles): ProjectWaitingItem {
  const threadScope = decision.from === 'thread' && !!decision.threadId, answer = decision.answer;
  const answerSummary = !answer ? null : answer.source === 'owner-chat' ? `Answered in chat: ${answer.ownerMessage}`
    : answer.optionLabel ? `${answer.optionLabel}${answer.text ? `. ${answer.text}` : ''}` : answer.text ?? '';
  return { schema: 'project-waiting-item-v1', decision, number, source: decisionSource(decision, titles), routedTo: sentText(decision, titles), answerSummary,
    allowsFreeText: !decision.deploy, paragraphs: decision.deploy ? decision.question.split('\n').map((text, index) => ({ text, strong: index === 0 })) : null,
    commandScope: { decisionId: decision.id, ...(decision.threadId ? { threadId: decision.threadId } : {}), cwd: threadScope ? 'worktree' : 'checkout', clearDevice: !threadScope },
    respondPath: `/api/projects/${decision.projectId}/waiting-items/${decision.id}/respond`,
    requestBase: { schema: 'decision-answer-request-v1', ...(decision.deploy ? { expectedRevision: decision.revision } : {}) } };
}
export function waitingItemsView(view: ProjectWorkView, ackKnown?: readonly string[]): ProjectWaitingItemsView {
  const titles = new Map(view.threads.map(thread => [thread.id, thread.title])), title = (id: string) => titles.get(id);
  return ProjectWaitingItemsViewSchema.parse({ schema: 'project-waiting-items-view-v1', projectId: view.project.id,
    open: view.decisions.open.map((decision, index) => waitingItem(decision, index + 1, title)),
    answered: view.decisions.answered.map((decision, index) => waitingItem(decision, index + 1, title)), showSent: showSent(ackKnown ? { known: ackKnown } : undefined, view.decisions.open) });
}
export function withdrawals(events: readonly ProjectLedgerEvent[], seen: ReadonlySet<number>, after = 0): Array<{ id: number; decisionId: string; reason: string }> {
  return events.flatMap(event => {
    if (event.id <= after || seen.has(event.id) || event.type !== 'coordinator-tool') return [];
    const parsed = ProjectLedgerDataSchemas['coordinator-tool'].safeParse(event.data), data = parsed.success ? parsed.data : undefined;
    return data?.tool === 'jevellan_withdraw_question' && data.ok && data.decisionId && data.reason ? [{ id: event.id, decisionId: data.decisionId, reason: data.reason }] : [];
  });
}
/** Event meaning is projected here; frontends only reconcile replay cursors and acknowledged notice ids. */
export function projectEventNotices(event: ProjectLedgerEvent): ProjectViewNotice[] {
  return withdrawals([event], new Set()).map(item => ({ schema: 'project-view-notice-v1', id: item.id, decisionId: item.decisionId, text: `A question was withdrawn: ${item.reason}` }));
}
