import { readTerminalActions, readTerminalCopyPlan, readTerminalCopyView, readTerminalRunPlan, executeTerminalAction } from '../terminal-actions-view.js';
import { terminalStreamPolicy } from '@jevellan/core';
import { readTerminalView } from '../terminal-reading-view.js';
import { readTerminalLauncherView, readTerminalListView, createTerminalForTools } from '../terminal-launcher-view.js';
import { readNativeConversationView, executeNativeMessage } from '../native-conversation-view.js';
import { ConversationStartRequestSchema } from '@jevellan/core';
import { readNativeListView, readNativeTranscriptView } from '../native-reading-view.js';
import { waitProjectSetupView } from '../project-setup-wait.js';
import { readConversationCreationDraft } from '../conversation-creation-draft.js';
import { readConversationNewView } from '../conversation-new-view.js';
import { ownerConversationSidebarDrop, ownerConversationSidebarRename } from '../conversation-sidebar-actions.js';
import { ownerConversationSidebar } from '../conversation-sidebar-view.js';
import { ownerCommandViewForTools } from '../owner-command-view.js';
import { conversationListSource } from '../conversation-list-source.js';
import { ProjectPageRequestSchema } from '@jevellan/core';
import { readSessionListPreferences, saveSessionListPreferences } from '@jevellan/conversations';
import { sessionListView } from '@jevellan/core';
import { ComposerInitialSchema, ConversationComposerViewSchema } from '@jevellan/core';
import { ownerConversationComposer, ownerConversationOperation } from '../owner-proxy.js';
import { ProjectRouteCorrectionRequestSchema, ProjectRouteWhyViewSchema } from '@jevellan/core';
import { capLines } from '@jevellan/projects';
import { ProjectThreadOverrideEditorSchema, ThreadOverrideViewSchema, ProjectThreadWhyViewSchema, type JevRule } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { ownerThreadOperation } from '../project-work-api.js';
import { resolveGoal, resolveTask } from './common.js';

function describeRule(rule: JevRule, goals: Map<string, string>): string {
  const when = [rule.when.taskType ? `task type ${rule.when.taskType}` : '', rule.when.goalId ? `goal ${goals.get(rule.when.goalId) ?? rule.when.goalId}` : '', rule.when.label ? `label ${rule.when.label}` : '', rule.when.keywords?.length ? `keywords ${rule.when.keywords.join(', ')}` : ''].filter(Boolean);
  const set = [rule.set.minModel ? `at least ${rule.set.minModel}` : '', rule.set.minEffort ? `at least ${rule.set.minEffort} effort` : '', rule.set.maxEffort ? `at most ${rule.set.maxEffort} effort` : '', rule.set.account ? `account ${rule.set.account}` : '', rule.set.runtime ? `runtime ${rule.set.runtime}` : '', rule.set.landingRoute ? `landing route ${rule.set.landingRoute}` : ''].filter(Boolean);
  return [rule.id, rule.scope, ...(rule.enabled ? [] : ['disabled']), ...(when.length ? when : ['always']), set.join(', '), ...(rule.note ? [`"${rule.note}"`] : [])].join(' · ');
}

/** `jev` (bridge specification, "Jev control"). */
export const jev: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const control = app.ownerJev; const projectId = project.id;
  if (context.action === 'terminal_actions_view') return { text: 'Terminal actions.', data: await readTerminalActions(app, args.request) };
  if (context.action === 'terminal_copy_plan') return { text: 'Terminal copy source.', data: await readTerminalCopyPlan(app, args.request) };
  if (context.action === 'terminal_copy_view') return { text: 'Terminal command excerpt.', data: await readTerminalCopyView(app, args.request) };
  if (context.action === 'terminal_run_plan') return { text: 'Terminal input plan; not executed.', data: await readTerminalRunPlan(app, args.request) };
  if (context.action === 'terminal_action') return { text: 'Terminal action receipt.', data: await executeTerminalAction(app, args.request) };
  if (context.action === 'terminal_stream_policy') return { text: 'Terminal stream policy.', data: terminalStreamPolicy() };
  if (context.action === 'terminal_read_view') return { text: 'Terminal reading view.', data: await readTerminalView(app, args.request) };
  if (context.action === 'terminal_launcher_view') return { text: 'Terminal launcher.', data: await readTerminalLauncherView(app, args.request, context.request.deviceId) };
  if (context.action === 'terminal_list_view') return { text: 'Open terminals.', data: await readTerminalListView(app, args.request) };
  if (context.action === 'terminal_create') return { text: 'Terminal opened.', data: await createTerminalForTools(app, args.request) };
  if (context.action === 'native_conversation_view') return { text: 'Native conversation view.', data: await readNativeConversationView(app, args.request, context.request.deviceId) };
  if (context.action === 'native_message_send' || context.action === 'native_message_cancel') return { text: 'Native message receipt.', data: await executeNativeMessage(app, args.request) };
  if (context.action === 'native_list_view') return { text: 'Native session reading view.', data: await readNativeListView(app) };
  if (context.action === 'native_transcript_view') return { text: 'Native transcript reading view.', data: await readNativeTranscriptView(app, args.request) };
  await tools.status(project); // display ids for every current thread and goal
  const goals = new Map((await app.projectWork.goalList(projectId)).goals.map(row => [row.goal.id, tools.ids.one(projectId, 'G', row.goal.id)]));
  switch (context.action) {
    case 'improver': return { text: 'Improver suggestions and recorded checks.', data: await app.improverRequest({ schema: 'improver-request-v1', operation: 'state' }) };
    case 'improver_revision': return { text: 'Recorded improver revision.', data: await app.improverRequest({ schema: 'improver-request-v1', operation: 'revision', id: args.id }) };
    case 'settings_editor': case 'settings_preview': {
      const data = await app.state.configuration.decisionsEditor(context.action === 'settings_preview' ? args.request : undefined);
      return { text: 'Decisions settings.', data };
    }
    case 'settings_save': return { text: 'Decisions settings saved.', data: await app.saveDecisionsSettings(args.request) };
    case 'connection': return { text: 'Jev connection.', data: await app.state.jev.connection() };
    case 'connection_check': return { text: 'Jev connection check.', data: await app.checkJev() };
    case 'conversation_why': case 'correction_editor': case 'correction_preview': case 'correction_save': {
      const operation = context.action === 'conversation_why' ? 'decision-why' : context.action === 'correction_editor' ? 'step-editor' : context.action === 'correction_preview' ? 'step-preview' : 'correction-save';
      const input = context.action === 'conversation_why' ? { schema: 'conversation-decision-why-request-v1', decisionId: args.decision } : context.action === 'correction_editor' ? args.stretch : args.request;
      const data = await ownerConversationOperation(app, projectId, String(args.conversation), operation, input);
      return { text: context.action === 'correction_save' ? 'Recorded correction.' : context.action === 'conversation_why' ? 'Why this step.' : 'Change this step.', data };
    }

    case 'plan_approve': return { text: 'Plan approved.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'plan-approve', args.request) };
    case 'plan_changes': return { text: 'Requested plan changes.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'plan-changes', args.request) };
    case 'session_list': return { text: 'This device’s session list.', data: sessionListView(app.device.deviceId, readSessionListPreferences(app.homes)) };
    case 'conversation_start': {
      const input = ConversationStartRequestSchema.parse(args.request);
      if (input.start.projectId !== projectId) throw new OwnerRefusal('This creation request belongs to another project.', 'invalid_arguments', 409);
      const data = await app.startConversation(input);
      return { text: data.view ? `Conversation ${data.view.conversation.id}.` : data.setup.summary, data };
    }
    case 'project_setup': { const data = await waitProjectSetupView(app, projectId, context.request.deviceId, args.request); return { text: data.summary, data }; }
    case 'conversation_create_draft': return { text: 'Conversation creation draft.', data: await readConversationCreationDraft(app, args.request, projectId) };
    case 'conversation_new': return { text: 'New conversation.', data: await readConversationNewView(app, args.request, context.request.deviceId) };
    case 'conversation_sidebar_drop': {
      const data = await ownerConversationSidebarDrop(app, args.request);
      return { text: data.accepted ? 'Session order saved.' : 'Session order unchanged.', data };
    }
    case 'conversation_sidebar_rename': return { text: 'Session renamed.', data: await ownerConversationSidebarRename(app, args.request, undefined, projectId) };
    case 'conversation_sidebar': return { text: 'Conversation sidebar.', data: await ownerConversationSidebar(app, args.request) };
    case 'conversation_list': return { text: 'Owner conversations.', data: await conversationListSource(app) };
    case 'session_list_save': return { text: 'Session list saved.', data: sessionListView(app.device.deviceId, saveSessionListPreferences(app.homes, args.request)) };
    case 'owner_command_view': return { text: 'Owner command view.', data: await ownerCommandViewForTools(app, projectId, args) };
    case 'project_page': {
      const { resolvedDays, ...viewer } = ProjectPageRequestSchema.parse(args.request ?? { schema: 'project-page-request-v1' });
      return { text: 'Project page.', data: await app.projectWork.pageView(projectId, resolvedDays, viewer) };
    }
    case 'conversation_transcript': return { text: 'Recorded conversation transcript.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'transcript-view', args.request) };
    case 'conversation_message_draft': return { text: 'Conversation message draft.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'message-draft', args.request) };
    case 'conversation_message': return { text: 'Conversation updated.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'message-command', args.request) };
    case 'conversation_read_view': return { text: 'Conversation reading view.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'reading-view', args.request) };
    case 'conversation_stream': return { text: 'Conversation stream source.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'stream-source', args.request) };
    case 'conversation_manual_editor': return { text: 'Manual step editor.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'manual-editor') };
    case 'conversation_manual_draft': return { text: 'Manual step draft.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'manual-draft', args.request) };
    case 'conversation_manual': return { text: 'Manual step requested.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'manual-command', args.request) };
    case 'conversation_recovery_editor': return { text: 'Conversation recovery editor.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'recovery-editor', args.request) };
    case 'conversation_recovery_draft': return { text: 'Conversation recovery draft.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'recovery-draft', args.request) };
    case 'conversation_recover': return { text: 'Conversation recovery recorded.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'recovery-command', args.request) };
    case 'conversation_settlement_editor': return { text: 'Work settlement editor.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'settlement-editor', args.request) };
    case 'conversation_settlement_draft': return { text: 'Work settlement draft.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'settlement-draft', args.request) };
    case 'conversation_settle': return { text: 'Work settlement recorded.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'settlement-command', args.request) };
    case 'conversation_control_editor': return { text: 'Conversation editor.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'control-editor', args.request) };
    case 'conversation_control_draft': return { text: 'Conversation control draft.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'control-draft', args.request) };
    case 'conversation_control': return { text: 'Conversation updated.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'control-command', args.request) };
    case 'conversation_view': return { text: 'Conversation view.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'conversation-view') };
    case 'conversation_changes': return { text: 'Recorded changes.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'changes', args.stretch) };
    case 'evidence_read': return { text: 'Recorded evidence.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'evidence-read', args.request) };
    case 'plan_read': return { text: 'Recorded plan.', data: await ownerConversationOperation(app, projectId, String(args.conversation), 'plan-read', args.request) };
    case 'composer_editor': case 'composer_preview': case 'composer_save': {
      if (typeof args.conversation === 'string') {
        if (args.initial !== undefined) throw new OwnerRefusal('Read the existing conversation without an initial draft.', 'invalid_arguments');
        const view = await ownerConversationComposer(app, projectId, args.conversation, context.action === 'composer_save' ? args.request : undefined);
        return { text: view.summary ?? 'Auto', data: view };
      }
      if (context.action === 'composer_save') throw new OwnerRefusal('Choose an existing conversation to save.', 'invalid_arguments');
      const view = ConversationComposerViewSchema.parse(await app.conversations.composerDraft({ schema: 'conversation-composer-request-v1', projectId,
        initial: args.initial ?? ComposerInitialSchema.parse({ schema: 'composer-initial-v1', once: {}, pins: {} }),
        ...(context.action === 'composer_preview' ? { choice: args.request } : {}) }));
      return { text: view.summary ?? 'Auto', data: view };
    }

    case 'override_editor': case 'override_preview': case 'override_save': {
      const target = await resolveTask(context, String(args.thread));
      if (!target.thread) throw new OwnerRefusal(`${target.id} has no thread yet.`, 'not_running', 409);
      const operation = context.action === 'override_editor' ? 'override-editor' : context.action === 'override_preview' ? 'override-preview' : 'override-save';
      const result = await ownerThreadOperation(app, projectId, target.thread.id, operation, args.request);
      return context.action === 'override_save' ? { text: `Applied override for ${target.id}.`, data: ThreadOverrideViewSchema.parse(result) }
        : { text: `Override ${target.id}.`, data: ProjectThreadOverrideEditorSchema.parse(result) };
    }
    case 'route_correct': {
      const target = await resolveTask(context, String(args.thread)); if (!target.thread) throw new OwnerRefusal(`${target.id} has no thread yet.`, 'not_running', 409);
      const input = ProjectRouteCorrectionRequestSchema.parse(args.request), operation = input.schema === 'landing-correction-input-v1' ? 'landing-why-correction' : 'merge-why-correction';
      const view = ProjectRouteWhyViewSchema.parse(await ownerThreadOperation(app, projectId, target.thread.id, operation, input));
      return { text: view.savedNotice ?? 'Saved.', data: view };
    }
    case 'why': {
      const target = await resolveTask(context, String(args.thread));
      if (!target.thread) throw new OwnerRefusal(`${target.id} has no thread yet.`, 'not_running', 409);
      if (args.kind === 'landing' || args.kind === 'merge') {
        const commit = typeof args.commit === 'string' ? args.commit : target.thread.pr?.headSha;
        if (args.kind === 'merge' && !commit) throw new OwnerRefusal(`${target.id} has no recorded pull request head. Supply a recorded commit.`, 'no_merge_head', 409);
        const operation = args.kind === 'landing' ? 'landing-why' : 'merge-why';
        const view = ProjectRouteWhyViewSchema.parse(await ownerThreadOperation(app, projectId, target.thread.id, operation, operation === 'merge-why' ? { schema: 'project-merge-why-request-v1', commit } : undefined));
        return { text: capLines([view.title, ...(view.route ? [`${view.route.routeLabel} · ${view.route.sourceLabel} · ${view.route.stateLabel}`, ...(view.route.reason ? [view.route.reason] : []), `Checked commit ${view.route.checkedCommit}`, view.route.riskyLine] : [view.emptyText])]), data: view };
      }
      const view = ProjectThreadWhyViewSchema.parse(await ownerThreadOperation(app, projectId, target.thread.id, 'why'));
      return { text: capLines([view.title, `Placement: ${view.placement.sourceLabel}`, view.placement.fixedLine,
        ...view.fields.map(field => `${field.label}: ${field.valueLabel} · ${field.sourceLabel}`), ...(view.placement.fallbackNotice ? [view.placement.fallbackNotice] : []), ...view.jev.lines]), data: view };
    }
    case 'rules': { const rules = control.rules(projectId); return { text: capLines([`Jev rules for ${project.name} (global and project)`, ...(rules.length ? rules.map(rule => describeRule(rule, goals)) : ['none'])]) }; }
    case 'rule_set': {
      const when = (args.when ?? {}) as { taskType?: string; goal?: string; label?: string; keywords?: string[] };
      const goalId = when.goal ? (await resolveGoal(context, when.goal)).goal.id : undefined;
      const rule = control.saveRule(projectId, { ...(typeof args.rule === 'string' ? { rule: args.rule } : {}), ...(args.scope ? { scope: args.scope as 'global' | 'project' } : {}),
        when: { ...(when.taskType ? { taskType: when.taskType } : {}), ...(goalId ? { goalId } : {}), ...(when.label ? { label: when.label } : {}), ...(when.keywords ? { keywords: when.keywords } : {}) },
        ...(args.set ? { set: args.set as JevRule['set'] } : {}), ...(typeof args.note === 'string' ? { note: args.note } : {}), ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}) });
      return { text: `Saved ${describeRule(rule, goals).replace(/^(R\d+) · /u, '$1: ')}. Applies to new decisions from now on.\n${await control.ruleEffect(projectId)}` };
    }
    case 'rule_remove': { const rule = control.removeRule(projectId, String(args.rule)); return { text: `Removed ${rule.id}.\n${await control.ruleEffect(projectId)}` }; }
    case 'prompts': {
      const versions = control.versions(); const names = [...new Set(versions.map(row => row.name))];
      const lines = names.map(name => { const rows = versions.filter(row => row.name === name); const live = rows.find(row => row.active)!; return `${name} v${live.version} live · ${rows.length} version${rows.length === 1 ? '' : 's'}${name === 'l-v1' ? '' : ' · versioned; the engine still reads the code text'}`; });
      for (const proposal of control.proposals().filter(row => row.state === 'proposed')) lines.push(`${proposal.source === 'code' ? 'new default from code' : 'proposed'}: ${proposal.id} for ${proposal.name} (${proposal.summary})`);
      return { text: capLines(lines) };
    }
    case 'prompt_show': {
      const rows = control.versions(String(args.name)); const row = typeof args.version === 'number' ? rows.find(entry => entry.version === args.version) : rows.find(entry => entry.active);
      if (!row) throw new OwnerRefusal(`${String(args.name)} has versions ${rows.map(entry => `v${entry.version}`).join(', ') || 'none'}.`, 'version_not_found', 404);
      return { text: capLines([`${row.name} v${row.version}${row.active ? ' (live)' : ''} · ${row.summary}`, ...row.text.split('\n')], true) };
    }
    case 'prompt_history': {
      const rows = control.versions(String(args.name)); if (!rows.length) throw new OwnerRefusal(`There is no prompt ${String(args.name)}.`, 'prompt_not_found', 404);
      return { text: capLines(rows.map(row => `v${row.version}${row.active ? ' (live)' : ''} ${row.createdAt.slice(0, 10)} · ${row.summary}${row.replay ? ` · ${row.replay.split('\n')[0]}` : ''}`)) };
    }
    case 'prompt_propose': return { text: await control.propose(projectId, String(args.name), { ...(typeof args.text === 'string' ? { text: args.text } : {}), ...(Array.isArray(args.edits) ? { edits: args.edits as Array<{ find: string; replace: string }> } : {}), summary: String(args.summary) }) };
    case 'prompt_apply': return { text: control.apply(String(args.proposal)) };
    case 'prompt_rollback': return { text: control.rollback(String(args.name), Number(args.version)) };
    case 'lessons': {
      const lessons = control.lessons(projectId);
      return { text: capLines(lessons.length ? lessons.map(row => `${row.id} ${row.scope}${row.enabled ? '' : ' · disabled'} · applied ${row.timesApplied} times · "${row.text}"${row.source.startsWith('override:') ? ` (from override of ${row.source.slice('override:'.length)})` : row.source === 'migrated' ? ' (from an earlier correction)' : ''}`) : ['No lessons yet.']) };
    }
    case 'lesson_edit': {
      const before = control.lessons(projectId).find(row => row.id === String(args.lesson).toUpperCase());
      const lesson = control.editLesson(projectId, String(args.lesson), { ...(typeof args.text === 'string' ? { text: args.text } : {}), ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}) });
      const changes = [before?.text !== lesson.text ? `text is now "${lesson.text}"` : '', before?.enabled !== lesson.enabled ? (lesson.enabled ? 'enabled' : 'disabled') : ''].filter(Boolean);
      return { text: `Updated ${lesson.id}: ${changes.join(', ') || 'no change'}.` };
    }
    case 'lesson_remove': { const lesson = control.editLesson(projectId, String(args.lesson), 'remove'); return { text: `Removed ${lesson.id}.` }; }
    case 'replay': {
      const proposal = typeof args.proposal === 'string' ? control.proposals().find(row => row.id === args.proposal!.toString().toUpperCase()) ?? null : null;
      if (typeof args.proposal === 'string' && !proposal) throw new OwnerRefusal(`${args.proposal} is not a proposal.`, 'proposal_not_found', 404);
      return { text: await control.replayText(projectId, proposal, typeof args.n === 'number' ? args.n : 20, typeof args.lesson === 'string' ? args.lesson : undefined) };
    }
  }
  throw new OwnerRefusal('jev takes rules, prompts, prompt_show, prompt_history, lessons, rule_set, rule_remove, prompt_propose, prompt_apply, prompt_rollback, lesson_edit, lesson_remove, replay.', 'unknown_action');
};
