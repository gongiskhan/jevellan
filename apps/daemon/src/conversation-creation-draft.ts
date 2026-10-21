import{createHash,randomUUID}from'node:crypto';
import{ConversationCreationIntentSchema,conversationCreationDraft}from'@jevellan/core';
import type{Application}from'./application.js';
/** Prepares a caller-owned draft only; the ordinary creation writer remains authoritative. */
export async function readConversationCreationDraft(app:Application,raw:unknown,projectId?:string){
 const input=ConversationCreationIntentSchema.parse(raw);
 if(projectId&&input.projectId!==projectId)throw Object.assign(new Error('This draft belongs to another project.'),{status:409});
 await app.conversations.ready;
 if(!(await app.conversations.projects()).projects.some(row=>row.project.id===input.projectId))throw Object.assign(new Error('Project not found.'),{status:404});
 // Preserve the raw choices insertion order used by the old form signature after strict validation.
 return conversationCreationDraft(raw,randomUUID,signature=>createHash('sha256').update(signature).digest('hex'));
}
