import {z} from 'zod';
import {AuthStateSchema,DevicesListSchema,PassphraseInputSchema} from './client-schemas.js';
import {DeviceRosterSchema} from './mesh-schemas.js';
import {IdSchema} from './schemas.js';
export const APP_ROSTER_POLL_MS=30_000;
export const AppSignInViewSchema=z.strictObject({schema:z.literal('app-sign-in-view-v1'),deviceId:IdSchema,configured:z.boolean(),title:z.string(),help:z.string(),
 field:z.strictObject({label:z.string(),minLength:z.number().int().positive(),maxLength:z.number().int().positive(),autoComplete:z.enum(['current-password','new-password']),hint:z.string().nullable()}),
 submit:z.strictObject({path:z.enum(['/api/auth/login','/api/auth/setup']),method:z.literal('POST'),waitForHub:z.boolean(),label:z.string(),busyLabel:z.string()}),
 navigation:z.strictObject({setupPath:z.literal('/setup'),rootPath:z.literal('/'),defaultPath:z.literal('/settings/runtimes')})});
export type AppSignInView=z.infer<typeof AppSignInViewSchema>;
export const AppVersionNoticeSchema=z.strictObject({beforeCommand:z.string(),command:z.literal('jevellan update'),afterCommand:z.literal('.')});
export const AppShellViewSchema=z.strictObject({schema:z.literal('app-shell-view-v1'),deviceId:IdSchema,roster:DeviceRosterSchema,devices:DevicesListSchema,signIn:AppSignInViewSchema,
 policy:z.strictObject({rosterPollMs:z.literal(APP_ROSTER_POLL_MS)}),versionNotice:AppVersionNoticeSchema.nullable()})
 .refine(value=>value.deviceId===value.roster.currentDeviceId&&value.deviceId===value.devices.currentDeviceId&&value.deviceId===value.signIn.deviceId,'The app view belongs to another device.');
/** Presentation contains no credential or session. Authentication remains in the existing account service. */
export function appSignInView(raw:unknown):AppSignInView{
 const auth=AuthStateSchema.parse(raw),configured=auth.configured;
 return AppSignInViewSchema.parse({schema:'app-sign-in-view-v1',deviceId:auth.deviceId,configured,title:configured?'Welcome back':'Set your passphrase',
  help:configured?'Sign in to your conversations and agents.':'Use one passphrase to sign in to Jevellan on your devices.',
  field:{label:'Passphrase',minLength:PassphraseInputSchema.shape.passphrase.minLength,maxLength:PassphraseInputSchema.shape.passphrase.maxLength,autoComplete:configured?'current-password':'new-password',hint:configured?null:'At least 8 characters.'},
  submit:{path:configured?'/api/auth/login':'/api/auth/setup',method:'POST',waitForHub:configured,label:configured?'Sign in':'Set passphrase',busyLabel:'Signing in…'},
  navigation:{setupPath:'/setup',rootPath:'/',defaultPath:'/settings/runtimes'}});
}
export function appPostLoginPath(raw:unknown,currentPath:string):string{
 const view=AppSignInViewSchema.parse(raw),pathname=currentPath.split('?')[0];
 return !view.configured?view.navigation.setupPath:pathname===view.navigation.setupPath||pathname===view.navigation.rootPath?currentPath:view.navigation.defaultPath;
}
export function appVersionNotice(raw:unknown):z.infer<typeof AppVersionNoticeSchema>|null{
 const devices=z.union([DevicesListSchema,DevicesListSchema.omit({schema:true})]).parse(raw),self=devices.devices.find(device=>device.id===devices.currentDeviceId),hub=devices.devices.find(device=>device.role==='hub');
 if(!self||!hub||self.id===hub.id||self.version===hub.version)return null;
 return AppVersionNoticeSchema.parse({beforeCommand:`This device runs ${self.version}. The hub runs ${hub.version}. Update this device with `,command:'jevellan update',afterCommand:'.'});
}
export function appShellView(rawRoster:unknown,rawAuth:unknown){
 const roster=DeviceRosterSchema.parse(rawRoster),devices=DevicesListSchema.parse({schema:'devices-list-v1',currentDeviceId:roster.currentDeviceId,devices:roster.devices.map(row=>row.device)});
 return AppShellViewSchema.parse({schema:'app-shell-view-v1',deviceId:roster.currentDeviceId,roster,devices,signIn:appSignInView(rawAuth),policy:{rosterPollMs:APP_ROSTER_POLL_MS},versionNotice:appVersionNotice(devices)});
}
