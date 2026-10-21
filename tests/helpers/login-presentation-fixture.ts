import { accountEditorFixture } from './account-editor-fixture.js';
export async function loginPresentationFixture() {
  const f = await accountEditorFixture(); let completed = false, cancelled = 0; const counts = { starts: 0, submissions: 0 };
  const runtime = f.app.runtimes.get('claude')!;
  runtime.probe = async () => ({ auth: completed ? 'ready' : 'missing', identity: { email: 'fixture@example.test' } });
  runtime.beginLogin = async () => { counts.starts++; return ({ instructions: 'Complete the fixture sign-in.', url: 'https://auth.example.test/authorize', poll: async () => completed ? 'done' : 'pending', submitCode: async () => { counts.submissions++; completed = true; }, cancel: async () => { cancelled++; } }); };
  const account = await f.app.accounts.add({ schema: 'add-account-v1', runtime: 'claude', label: 'Login fixture', kind: 'subscription', credential: 'per-device' });
  return { f, account, counts, cancelled: () => cancelled };
}
