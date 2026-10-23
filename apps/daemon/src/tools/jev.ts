import {JEV_CONTROL_ACTIONS,jevControlAction} from './jev-control-actions.js';
import {readJevControl,executeJevControl} from '../jev-control-workspace.js';
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
import { ProjectThreadOverrideEditorSchema, ThreadOverrideViewSchema, ProjectThreadWhyViewSchema } from '@jevellan/core';
import { OwnerRefusal, type OwnerHandler } from '../owner-tools.js';
import { ownerJevDecisionRead, ownerThreadOperation } from '../project-work-api.js';
import { resolveTask } from './common.js';

/** `jev` (bridge specification, "Jev control"). */
export const jev: OwnerHandler = async (context) => {
  const { app, tools, project, args } = context; const projectId = project.id;
  if (context.action === 'decision_inputs') return { text: 'Stored Jev inputs.', data: await ownerJevDecisionRead(app, projectId, args.request) };
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
  if (context.action === 'control_workspace') return {text:'Jev control.',data:await readJevControl(context)};
  if (context.action === 'control_command') return {text:'Jev control updated.',data:await executeJevControl(context)};
  if (JEV_CONTROL_ACTIONS.has(context.action)) return jevControlAction(context);
  await app.ownerJev.prepare(projectId);
  await tools.status(project); // display ids for every current thread and goal
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

  }
  throw new OwnerRefusal('jev takes rules, prompts, prompt_show, prompt_history, lessons, rule_set, rule_remove, prompt_propose, prompt_apply, prompt_rollback, lesson_edit, lesson_remove, replay.', 'unknown_action');
};
