import { z } from 'zod';
import { IdSchema, ConversationIndexSchema } from './schemas.js';
import { CursorListSchema } from './cursor-schemas.js';
import { SessionListPreferencesSchema } from './session-list-schemas.js';
import { ConversationListSourceSchema } from './conversation-list-source.js';
import { conversationStateLabel } from './conversation-page-view.js';

export const ConversationSidebarFilterSchema = z.enum(['All', 'Running', 'Waiting for you', 'Done']);
export const ConversationSidebarRequestSchema = z.strictObject({
  schema: z.literal('conversation-sidebar-request-v1'), filter: ConversationSidebarFilterSchema.default('All'),
  q: z.string().default(''), shells: z.boolean().default(true), selected: z.string().default(''),
  pendingOrder: SessionListPreferencesSchema.shape.order.optional(), dragOrder: SessionListPreferencesSchema.shape.order.optional(),
});
export const ConversationSidebarFactsSchema = z.strictObject({
  schema: z.literal('conversation-sidebar-facts-v1'), source: ConversationListSourceSchema, native: CursorListSchema,
  devices: z.array(z.strictObject({ id: IdSchema, name: z.string() })), preferences: SessionListPreferencesSchema,
});
export const ConversationSidebarRowSchema = z.strictObject({
  id: z.string(), title: z.string(), state: z.union([ConversationIndexSchema.shape.state, z.literal('unknown')]), updatedAt: z.string(),
  route: z.string(), projectLabel: z.string(), deviceLabel: z.string(), cursor: z.boolean(), runtimeLabel: z.string(),
  needsConnection: z.boolean(), stateLabel: z.string(), actions: z.array(z.enum(['rename', 'settings'])),
});
export const ConversationSidebarViewSchema = z.strictObject({
  schema: z.literal('conversation-sidebar-view-v1'), deviceId: IdSchema,
  allRows: z.array(ConversationSidebarRowSchema), rows: z.array(ConversationSidebarRowSchema), shownCount: z.number().int().nonnegative(),
  searchable: z.boolean(), counts: z.strictObject({ 'Running': z.number().int().nonnegative(), 'Waiting for you': z.number().int().nonnegative() }),
  waitingCount: z.number().int().nonnegative(), documentTitle: z.string(), emptyText: z.string().nullable(),
  sortByActivity: z.boolean(), unavailable: z.array(z.string()),
});
export type ConversationSidebarFilter = z.infer<typeof ConversationSidebarFilterSchema>;
export type ConversationSidebarView = z.infer<typeof ConversationSidebarViewSchema>;
export type ConversationSidebarRow = z.infer<typeof ConversationSidebarRowSchema>;
export type ConversationSidebarRequest = z.input<typeof ConversationSidebarRequestSchema>;
export const sidebarRuntimeLabel = (runtime?: string) => runtime === 'claude' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : 'Cursor';
const matchesFilter = (filter: string, state: string) => filter === 'All' || filter === 'Running' && state === 'running' ||
  filter === 'Waiting for you' && ['waiting-for-you', 'blocked'].includes(state) || filter === 'Done' && ['done', 'cancelled'].includes(state);

/** Exact sidebar policy over canonical recorded owner/native facts; no intent routing or work admission. */
export function conversationSidebarView(raw: z.input<typeof ConversationSidebarFactsSchema>, request: ConversationSidebarRequest): ConversationSidebarView {
  const {source,native,devices,preferences}=ConversationSidebarFactsSchema.parse(raw),input=ConversationSidebarRequestSchema.parse(request);
  const ownerRows=source.conversations.map(entry=>({id:entry.id,title:entry.title,state:entry.state,updatedAt:entry.updatedAt,
    route:`/conversations/${entry.id}`,projectLabel:source.projects.find(project=>project.id===entry.projectId)?.name??entry.projectId,
    deviceLabel:devices.find(device=>device.id===entry.ownerDeviceId)?.name??entry.ownerDeviceId,cursor:false,runtimeLabel:'',needsConnection:false}));
  const nativeRows=native.sessions.map(entry=>({id:`${entry.gatewayDeviceId??entry.ownerDeviceId}:${entry.ownerDeviceId}:${entry.id}`,title:entry.title,
    state:entry.state==='working'?'running' as const:entry.state==='idle'?'idle' as const:'unknown' as const,updatedAt:entry.lastActivityAt,
    projectLabel:entry.project,deviceLabel:entry.deviceName,cursor:true,runtimeLabel:sidebarRuntimeLabel(entry.runtime),
    needsConnection:(!entry.runtime||entry.runtime==='cursor')&&!entry.canSend,
    route:`/${entry.runtime&&entry.runtime!=='cursor'?'sessions':'cursor'}/${entry.id}?deviceId=${encodeURIComponent(entry.ownerDeviceId)}&gateway=${encodeURIComponent(entry.gatewayDeviceId??entry.ownerDeviceId)}`}));
  const allRows:ConversationSidebarRow[]=[...ownerRows,...nativeRows].map(entry=>({...entry,
    title:entry.cursor?preferences.titles[entry.id]??entry.title:entry.title,
    stateLabel:entry.cursor?`${entry.runtimeLabel} · ${entry.state==='idle'?'Idle':entry.state==='unknown'?'Unknown':'Working'}`:conversationStateLabel(entry.state),
    actions:['rename',...((entry.needsConnection||!entry.cursor&&input.selected===entry.route)?['settings' as const]:[])] as Array<'rename'|'settings'>,
  })).sort((a,b)=>{const order=input.pendingOrder??preferences.order;return order.indexOf(a.id)-order.indexOf(b.id)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id);});
  const shown=allRows.filter(entry=>input.shells||!entry.cursor),terms=input.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching=shown.filter(entry=>terms.every(term=>`${entry.title} ${entry.projectLabel} ${entry.deviceLabel} ${entry.runtimeLabel}`.toLowerCase().includes(term)));
  let rows=matching.filter(entry=>matchesFilter(input.filter,entry.state));
  if(input.dragOrder){const order=input.dragOrder;const rank=(id:string)=>{const index=order.indexOf(id);return index<0?order.length:index;};rows=[...rows].sort((a,b)=>rank(a.id)-rank(b.id));}
  const waitingCount=source.conversations.filter(entry=>matchesFilter('Waiting for you',entry.state)).length,open=allRows.find(entry=>input.selected===entry.route);
  return ConversationSidebarViewSchema.parse({schema:'conversation-sidebar-view-v1',deviceId:source.deviceId,allRows,rows,shownCount:shown.length,searchable:shown.length>6,
    counts:{Running:matching.filter(entry=>matchesFilter('Running',entry.state)).length,'Waiting for you':matching.filter(entry=>matchesFilter('Waiting for you',entry.state)).length},
    waitingCount,documentTitle:`${waitingCount?`(${waitingCount}) `:''}${open?`${open.title} · `:''}Jevellan`,
    emptyText:!shown.length?'No conversations yet. Start one to put your agents to work.':!rows.length?terms.length?'No conversations match this search.':'No conversations in this view.':null,
    sortByActivity:!!preferences.order.length,unavailable:input.shells?native.unavailable:[]});
}
