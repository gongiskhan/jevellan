import type { z } from 'zod';
import {
  IdSchema, ProjectMailSchema, isTerminal, reservationActive, stableJson,
  type BridgeToolSchemas, type CoordinatorEvent, type ProjectHub, type ProjectMail, type ProjectToolName, type ThreadIndex,
} from '@jevellan/core';
import type { ProjectScope } from './bridge-tools.js';
import {
  COORDINATOR_MAIL_NAME, COORDINATOR_MAIL_TO, MAIL_NO_RECIPIENTS, MAIL_THREAD_ENDED, MAIL_TO_SELF, MAIL_WORKTREE_THREAD, THREAD_MAIL_TO, THREAD_NOT_FOUND, TOOL_NOT_IN_TURN, UNKNOWN_THREAD,
} from './copy.js';
import { derivedId } from './decision-items.js';

type Input<T extends ProjectToolName> = z.output<(typeof BridgeToolSchemas)[T]>;
type ThreadScope = Extract<ProjectScope, { kind: 'thread' }>;
/** What mail needs to know about a thread: this device's own threads are current here, the hub's indexes lag a publish. */
type Known = Pick<ThreadIndex, 'projectId' | 'title' | 'isolation' | 'state'>;
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
/** How far `#reserve` follows a chain of ended reservations of the same input in one turn (a bound, never reached in practice). */
const RESERVATION_HOPS = 20;

export type MailServiceOptions = {
  hub: Pick<ProjectHub, 'thread' | 'threads' | 'sendMail' | 'inbox' | 'markRead' | 'reserve' | 'release'>;
  /** The coordinator's queue here, or the relay to its device (`Delivery.toCoordinator`). */
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  /** A thread of this device. */
  local(threadId: string): Known | undefined;
  now(): number;
};

/**
 * Mail and reservations between the threads that work directly on main (brief 5.11, 7.1, 7.2; decision 10), over the hub. Mail
 * to the coordinator is a `mail` coordinator event; mail to a thread or to all waits on the hub for the recipients' inbox. Ids
 * derive from the turn and the input (like D201), so a call the transport repeats sends one mail and holds one reservation.
 */
export class MailService {
  constructor(private readonly o: MailServiceOptions) {}
  /** The main-isolation thread tools: `jevellan_mail_send`, `jevellan_mail_inbox`, `jevellan_reserve` and `jevellan_release`. */
  async threadTool(scope: ThreadScope, name: ProjectToolName, raw: unknown): Promise<unknown> {
    const { projectId, threadId, turn } = scope;
    switch (name) {
      case 'jevellan_mail_send': return this.#send(projectId, threadId, turn, raw as Input<typeof name>);
      case 'jevellan_mail_inbox': return this.#inbox(projectId, threadId);
      case 'jevellan_reserve': return this.#reserve(projectId, threadId, turn, raw as Input<typeof name>);
      case 'jevellan_release': {
        const input = raw as Input<typeof name>;
        return { schema: 'release-result-v1', released: await this.o.hub.release(projectId, threadId, input.id) };
      }
      default: throw failure(TOOL_NOT_IN_TURN, 403);
    }
  }
  /**
   * The coordinator's `jevellan_mail_send` (brief 7.1): to a main thread, or to all of them. `deviceId` is the coordinator's device, whose
   * own turn numbers the id counts with (P8 review C-3).
   */
  async coordinatorSend(projectId: string, turn: number, input: Input<'jevellan_mail_send'>, deviceId?: string): Promise<unknown> {
    if (input.to === 'coordinator') throw failure(COORDINATOR_MAIL_TO, 400);
    return this.#send(projectId, 'coordinator', turn, input, deviceId);
  }
  /** Releases every active reservation of a thread (it stopped, failed or published); the caller treats it as best effort. */
  releaseThread(projectId: string, threadId: string): Promise<number> { return this.o.hub.release(projectId, threadId); }
  /** External mail was admitted and persisted by the authenticated hub. Delivery retries keep the same event ID. */
  async deliverExternal(mail: ProjectMail): Promise<void> {
    const input = ProjectMailSchema.parse(mail);
    if (input.to !== 'coordinator') return;
    await this.o.toCoordinator(input.projectId, { schema: 'coordinator-event-v1', id: derivedId('cev', input.id), at: input.at,
      kind: 'mail', mailId: input.id, fromThreadId: input.from, ...(input.fromTitle ? { fromTitle: input.fromTitle } : {}), subject: input.subject, body: input.body });
  }

  async #known(projectId: string, threadId: string): Promise<Known | undefined> {
    const thread = this.o.local(threadId) ?? (IdSchema.safeParse(threadId).success ? (await this.o.hub.thread(threadId))?.document : undefined);
    return thread?.projectId === projectId ? thread : undefined;
  }
  async #send(projectId: string, from: string, turn: number, input: Input<'jevellan_mail_send'>, deviceId?: string): Promise<unknown> {
    const mailId = derivedId('mail', projectId, from, ...(deviceId === undefined ? [] : [deviceId]), String(turn), stableJson(input));
    const at = new Date(this.o.now()).toISOString();
    if (input.to === 'coordinator') {
      // The coordinator dedupes its queue by event id, so a repeated call delivers once (D287).
      await this.o.toCoordinator(projectId, { schema: 'coordinator-event-v1', id: derivedId('cev', mailId), at, kind: 'mail', mailId, fromThreadId: from, subject: input.subject, body: input.body });
      return { schema: 'mail-send-result-v1', mailId };
    }
    if (input.to === from) throw failure(MAIL_TO_SELF, 400);
    if (input.to === 'all') { if (!(await this.#anyRecipient(projectId, from))) throw failure(MAIL_NO_RECIPIENTS, 409); }
    else {
      if (!IdSchema.safeParse(input.to).success) throw failure(from === 'coordinator' ? COORDINATOR_MAIL_TO : THREAD_MAIL_TO, 400);
      const recipient = await this.#known(projectId, input.to);
      if (!recipient) throw failure(THREAD_NOT_FOUND, 404);
      if (recipient.isolation !== 'main') throw failure(MAIL_WORKTREE_THREAD, 409);
      if (isTerminal(recipient.state)) throw failure(MAIL_THREAD_ENDED, 409);
    }
    await this.o.hub.sendMail(ProjectMailSchema.parse({ schema: 'project-mail-v1', revision: 0, id: mailId, projectId, from, to: input.to, subject: input.subject, body: input.body,
      at, readBy: [] }));
    return { schema: 'mail-send-result-v1', mailId };
  }
  /** Mail to all needs one main thread besides the sender that has not ended, or it would reach nobody. */
  async #anyRecipient(projectId: string, from: string): Promise<boolean> {
    let after: string | undefined;
    do {
      const page = await this.o.hub.threads(projectId, after);
      if (page.records.some((index) => index.projectId === projectId && index.id !== from && index.isolation === 'main' && !isTerminal(index.state))) return true;
      after = page.next ?? undefined;
    } while (after !== undefined);
    return false;
  }
  /**
   * Every unread mail, oldest first, marked read page by page after it arrived (D285). Mail is never lost: a mark that fails, or
   * whose reply is lost, still returns its page (unmarked mail repeats at the next call), and a later page that cannot be read
   * returns the pages already marked. Senders read as their titles, the coordinator as `Coordinator`.
   */
  async #inbox(projectId: string, threadId: string): Promise<unknown> {
    const mail: ProjectMail[] = [];
    for (;;) {
      let page: { records: ProjectMail[]; more: boolean };
      try { page = await this.o.hub.inbox(projectId, threadId); } catch (error) { if (mail.length) break; throw error; }
      mail.push(...page.records);
      if (!page.records.length) break;
      const marked = await this.o.hub.markRead(projectId, threadId, page.records.map((entry) => entry.id)).then(() => true, () => false);
      if (!marked || !page.more) break;
    }
    const titles = new Map<string, Promise<string>>();
    const title = (from: string): Promise<string> => {
      if (from === 'coordinator') return Promise.resolve(COORDINATOR_MAIL_NAME);
      let known = titles.get(from);
      if (!known) { known = this.#known(projectId, from).then((thread) => thread?.title ?? UNKNOWN_THREAD, () => UNKNOWN_THREAD); titles.set(from, known); }
      return known;
    };
    return { schema: 'mail-inbox-result-v1', mail: await Promise.all(mail.map(async (entry) => ({ id: entry.id, from: entry.from, fromTitle: entry.fromTitle ?? await title(entry.from),
      subject: entry.subject, body: entry.body, at: entry.at }))) };
  }
  /**
   * A reservation (brief 7.2): granted with its id, or refused with the conflicting threads' titles, overlapping paths and expiry.
   * The id derives from the turn and the input; when that reservation ended already (released, or its time ran out), the paths
   * are asked for again under the next id in the chain.
   */
  async #reserve(projectId: string, threadId: string, turn: number, input: Input<'jevellan_reserve'>): Promise<unknown> {
    let id = derivedId('resv', projectId, threadId, String(turn), stableJson(input));
    for (let hop = 0; ; hop += 1) {
      const outcome = await this.o.hub.reserve({ id, projectId, threadId, paths: input.paths, reason: input.reason, minutes: input.minutes });
      if (!outcome.granted) {
        return { schema: 'reserve-result-v1', granted: false, conflicts: outcome.conflicts.map((conflict) => ({ threadTitle: conflict.threadTitle ?? UNKNOWN_THREAD, paths: conflict.paths,
          expiresAt: conflict.expiresAt })) };
      }
      const reservation = outcome.reservation.document;
      if (reservationActive(reservation, this.o.now()) || hop === RESERVATION_HOPS) return { schema: 'reserve-result-v1', granted: true, id: reservation.id };
      id = derivedId('resv', reservation.id);
    }
  }
}
