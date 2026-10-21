import{z}from'zod';
import{IdSchema}from'./schemas.js';
import{StartConversationSchema,ConversationPublicSchema}from'./conversation-schemas.js';
import{ProjectSetupViewSchema,ProjectSetupWaitRequestSchema}from'./project-setup-view.js';
export const ConversationStartRequestSchema=z.strictObject({schema:z.literal('conversation-start-request-v1'),deviceId:IdSchema,start:StartConversationSchema,waitSeconds:ProjectSetupWaitRequestSchema.shape.waitSeconds});
export const ConversationStartResultSchema=z.discriminatedUnion('status',[
 z.strictObject({schema:z.literal('conversation-start-result-v1'),status:z.literal('created'),setup:ProjectSetupViewSchema,view:ConversationPublicSchema}),
 z.strictObject({schema:z.literal('conversation-start-result-v1'),status:z.literal('existing'),setup:z.null(),view:ConversationPublicSchema}),
 z.strictObject({schema:z.literal('conversation-start-result-v1'),status:z.enum(['waiting','blocked']),setup:ProjectSetupViewSchema,view:z.null()}),
]);
