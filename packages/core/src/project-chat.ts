import {ProjectLedgerDataSchemas,type CoordinatorEvent,type ProjectLedgerData,type ProjectLedgerEvent,type ProjectLedgerEventType,type ThreadIndex} from './project-schemas.js';
import {OWNER_STARTED_PREFIX,OWNER_STOPPED_THREAD,OWNER_WORKED_PREFIX} from './project-rules.js';
import {ProjectChatSourceSchema,ProjectChatViewRequestSchema,ProjectChatViewSchema,type ProjectChatItem,type ProjectChatView} from './project-chat-schemas.js';
import * as copy from './project-chat-copy.js';

export function projectChatOwnerHeading(via?:string):string{return via?`You, via ${via}`:'You';}
export function projectChatThreadTitles(threads:readonly Pick<ThreadIndex,'id'|'title'>[]):ThreadTitles{const titles=new Map(threads.map(thread=>[thread.id,thread.title]));return id=>titles.get(id);}
export function projectChatRequest(raw?:unknown){return ProjectChatViewRequestSchema.parse(raw??{schema:'project-chat-view-request-v1'});}
export function projectChatView(rawSource:unknown,rawRequest?:unknown):ProjectChatView{
 const source=ProjectChatSourceSchema.parse(rawSource),input=projectChatRequest(rawRequest),throughEventId=input.throughEventId??source.head;
 const refuse=(message:string):never=>{throw Object.assign(new Error(message),{status:409});};
 if(input.deviceId!==undefined&&input.deviceId!==source.deviceId)refuse('The coordinator device changed. Read the chat from the beginning.');
 if(throughEventId>source.head)refuse('This chat boundary is ahead of its source.');
 const items=chatItems(source.events.filter(event=>event.id<=throughEventId),projectChatThreadTitles(source.threads)),total=items.length;
 if(input.offset>total)refuse('This chat offset is beyond the recorded items.');
 const page=items.slice(input.offset,input.offset+input.limit),hasMore=input.offset+page.length<total;
 return ProjectChatViewSchema.parse({schema:'project-chat-view-v1',projectId:source.projectId,deviceId:source.deviceId,head:source.head,request:{...input,throughEventId,deviceId:source.deviceId},total,items:page,nextOffset:hasMore?input.offset+page.length:null,hasMore});
}

function payload<T extends ProjectLedgerEventType>(event: ProjectLedgerEvent, type: T): ProjectLedgerData<T> | undefined {
  if (event.type !== type) return undefined;
  const parsed = ProjectLedgerDataSchemas[type].safeParse(event.data);
  return parsed.success ? parsed.data as ProjectLedgerData<T> : undefined;
}

export type ChatItem = ProjectChatItem;
/** Thread titles by id, from the project view; unknown threads read `a thread`. */
export type ThreadTitles = (threadId: string) => string | undefined;

const firstLine = (text: string) => text.trim().split('\n')[0]!.trim();
type EventCard = { text: string; detail?: string; threadId?: string };
const card = (text: string, threadId: string | undefined, detail?: string): EventCard =>
  ({ text, ...(threadId ? { threadId } : {}), ...(detail?.trim() ? { detail: detail.trim() } : {}) });
function eventCard(event: Exclude<CoordinatorEvent, { kind: 'user-message' }>, titles: ThreadTitles): EventCard {
  const name = (threadId: string) => { const title = titles(threadId); return title ? copy.quotedTitle(title) : copy.UNKNOWN_THREAD_NAME; };
  const text = copy.eventCopy;
  switch (event.kind) {
    case 'handoff-requested': return card('Coordinator saved its work', undefined, 'Saving what is in flight before the next session.');
    case 'setup-requested': return card(copy.SETUP_REQUESTED_EVENT, undefined);
    case 'settings-changed': return card(event.settingsPresentation?.text ?? copy.SETTINGS_CHANGED_EVENT, undefined, event.settingsPresentation?.detail);
    case 'thread-resolved': return card(copy.threadResolved(titles(event.threadId) ?? copy.UNKNOWN_THREAD_NAME), event.threadId);
    case 'thread-placement-changed': return card(event.summary, event.threadId);
    case 'thread-auto-fix': return card(copy.automaticFixEvent(event.prNumber, event.outcome), event.threadId);
    case 'memory-dreamed': return card('Memory dream completed', undefined, event.summary);
    case 'deploy': return card(event.outcome === 'deployed' ? `Deployed ${event.commit.slice(0, 7)} with ${event.threads} threads` : `Deploy ${event.commit.slice(0, 7)} ${event.outcome}`, undefined, event.summary);
    case 'job-finished': return card(`Job "${event.name}" ${event.conclusion}`, undefined, `${event.commit.slice(0, 7)} · ${event.summary}`);
    case 'project-reviewed': return card('Nightly review completed', undefined, event.report.summary);
    case 'window-opened': return card('Nightly window opened', undefined, `${event.pending} nightly tasks pending. Merges are held.`);
    case 'window-finished': return card('Nightly window finished', undefined, event.outcome);
    case 'goal-refill': return card('Goals need work', undefined, event.goals.map(goal => `${goal.name}: ${goal.refillsToday} refilled today of ${goal.cap}`).join('\n'));
    case 'thread-report': {
      const status = { progress: text.reportProgress, done: text.reportDone, 'needs-decision': text.reportDecision, blocked: text.reportBlocked }[event.report.status];
      return card(status(name(event.threadId)), event.threadId, event.report.summary);
    }
    case 'thread-published': {
      const n = name(event.threadId);
      if (event.result === 'landed') return card(`${n} landed as ${(event.commit ?? '').slice(0, 7)}`, event.threadId);
      return card(event.result === 'pr-opened' ? text.prOpened(n, event.prNumber) : event.result === 'pr-updated' ? text.prUpdated(n, event.prNumber)
        : event.result === 'main-published' ? text.mainPublished(n) : event.result === 'checkout-completed' ? text.checkoutCompleted(n) : text.noChanges(n), event.threadId);
    }
    case 'thread-verification-failed': return card(text.testsFailed(name(event.threadId), event.attempts), event.threadId);
    case 'thread-interrupted': {
      // The owner's own stop says so in their voice; its message is written for the coordinator (D316).
      if (event.reason === 'stopped' && event.message === OWNER_STOPPED_THREAD) return card(text.ownerStopped(name(event.threadId)), event.threadId);
      const reason = { restart: text.interruptedRestart, timeout: text.interruptedTimeout, failed: text.interruptedFailed, stopped: text.interruptedStopped }[event.reason];
      return card(reason(name(event.threadId)), event.threadId, event.message);
    }
    case 'decision-answer': return card(text.answered(firstLine(event.question)), event.threadId, text.answer(event.answer.optionLabel, event.answer.text));
    case 'pr-ready-for-review': return card(`Pull request #${event.prNumber} is ready for the coordinator's review`, event.threadId, `Commit ${event.commit}`);
    case 'merge-gate': return card(`Pull request #${event.prNumber}: ${event.outcome.replaceAll('-', ' ')}`, event.threadId, event.summary);
    case 'task-reviewed': return card(`You ${event.outcome} "${event.title}"`, undefined);
    case 'task-not-started': return card(`"${event.title}" could not start`, undefined, event.reason);
    case 'pr-update': {
      const change = { 'checks-failed': text.checksFailed, 'checks-passed': text.checksPassed, merged: text.prMerged, closed: text.prClosed, conflict: text.prConflict }[event.change];
      return card(change(name(event.threadId), event.prNumber), event.threadId);
    }
    case 'mail': return card(text.mail(name(event.fromThreadId), event.subject), event.fromThreadId, event.body);
    case 'thread-user-message': {
      // Owner starts and terminal work arrive preformatted (D35); the card says what happened and keeps the task as detail.
      if (event.text.startsWith(OWNER_WORKED_PREFIX)) return card(text.ownerWorked(name(event.threadId)), event.threadId);
      if (event.text.startsWith(OWNER_STARTED_PREFIX)) {
        const marker = `(${event.threadId})] `; const at = event.text.indexOf(marker);
        return card(text.ownerStarted(name(event.threadId)), event.threadId, at < 0 ? undefined : event.text.slice(at + marker.length));
      }
      return card(text.ownerWrote(name(event.threadId)), event.threadId, event.text);
    }
    case 'placement-override': return card(text.overridden(name(event.threadId)), event.threadId, event.summary);
  }
}

/**
 * The coordinator chat from its ledger, in ledger order: owner messages, replies, tool one-liners, event cards and notices.
 * Owner messages and event cards are delivered once a coordinator turn lists their event id (D2a). Records that do not
 * parse are skipped, so one bad record never blanks the chat.
 */
export function chatItems(events: readonly ProjectLedgerEvent[], titles: ThreadTitles = () => undefined): ChatItem[] {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const delivered = new Set(ordered.flatMap((event) => payload(event, 'coordinator-turn-start')?.eventIds ?? []));
  const taskCards = new Map<number, Set<string>>(), settingCards = new Set<string>();
  const items = ordered.flatMap((event): ChatItem[] => {
    const id = event.id;
    switch (event.type) {
      case 'coordinator-text': { const data = payload(event, 'coordinator-text'); return data ? [{ kind: 'reply', id, text: data.text }] : []; }
      case 'coordinator-tool': {
        const data = payload(event, 'coordinator-tool');
        if (data?.ok && data.setupProposalId) return [{ kind: 'setup', id, proposalId: data.setupProposalId }];
        if (data?.ok && data.settingsChange) {
          if (settingCards.has(data.settingsChange.id)) return [];
          settingCards.add(data.settingsChange.id); return [{ kind: 'settings', id, change: data.settingsChange }];
        }
        if (data?.ok && (data.taskIds?.length || data.tool === 'jevellan_thread_message' && data.threadId)) {
          let taskIds = data.taskIds;
          if (taskIds && event.turn) {
            const seen = taskCards.get(event.turn) ?? new Set<string>(); taskCards.set(event.turn, seen);
            taskIds = taskIds.filter(taskId => !seen.has(taskId)); taskIds.forEach(taskId => seen.add(taskId));
            if (!taskIds.length) return [];
          }
          return [{ kind: 'routed', id, ...(event.turn ? { turn: event.turn } : {}), ...(taskIds ? { taskIds } : {}), ...(data.threadId ? { threadId: data.threadId } : {}), message: data.tool === 'jevellan_thread_message' }];
        }
        return data ? [{ kind: 'tool', id, tool: data.tool, summary: data.summary, ok: data.ok, ...(data.threadId ? { threadId: data.threadId } : {}) }] : [];
      }
      case 'notice': { const data = payload(event, 'notice'); return data ? [{ kind: 'notice', id, text: data.text, tone: data.kind }] : []; }
      case 'coordinator-event': {
        const data = payload(event, 'coordinator-event');
        if (!data) return [];
        if (data.kind === 'user-message') return [{ kind: 'owner', id, heading: projectChatOwnerHeading(data.via), text: data.text, at: data.at, ...(data.via ? { via: data.via } : {}), delivered: delivered.has(data.id) }];
        return [{ kind: 'event', id, ...eventCard(data, titles), delivered: delivered.has(data.id) }];
      }
      default: return [];
    }
  });
  const turns = new Map(ordered.map(event => [event.id, event.turn]));
  const reply = new Map<number, number>();
  for (const item of items) { const turn = turns.get(item.id); if (item.kind === 'reply' && turn) reply.set(turn, item.id); }
  const moved = new Set<number>(), cardsByReply = new Map<number, ChatItem[]>();
  for (const item of items) if (item.kind === 'routed' && item.turn && reply.has(item.turn)) {
    const replyId = reply.get(item.turn)!, cards = cardsByReply.get(replyId) ?? []; cards.push(item); cardsByReply.set(replyId, cards); moved.add(item.id);
  }
  return items.filter(item => !moved.has(item.id)).flatMap(item => [item, ...(cardsByReply.get(item.id) ?? [])]);
}

/** Index proposal groups once for a live view, so a long chat never rescans its history for every card. */
export function chatProposalGroups(items: readonly ChatItem[], tasks: readonly Pick<import('./project-loop-schemas.js').ProjectWorkTask, 'id' | 'state'>[]): Map<number, string[]> {
  const groups = new Map<number, { last: number; ids: Set<string> }>(), drafts = new Set(tasks.filter(task => task.state === 'draft').map(task => task.id));
  for (const item of items) if (item.kind === 'routed' && item.turn) {
    const group = groups.get(item.turn) ?? { last: item.id, ids: new Set<string>() };
    group.last = item.id; for (const id of item.taskIds ?? []) group.ids.add(id); groups.set(item.turn, group);
  }
  return new Map([...groups.values()].filter(group => group.ids.size >= 2).map(group => [group.last, [...group.ids].filter(id => drafts.has(id))]));
}
/** Keep Start all available for the remaining proposal after Start was used on its sibling. */
export function chatProposalIds(items: readonly ChatItem[], item: ChatItem, tasks: readonly Pick<import('./project-loop-schemas.js').ProjectWorkTask, 'id' | 'state'>[]): string[] {
  return chatProposalGroups(items, tasks).get(item.id) ?? [];
}
