import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../apps/web/dist/sw.js', import.meta.url), 'utf8');
function fixture(clients: Array<{ url: string; focused?: boolean; visibilityState?: string; focus?: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }> = []) {
  const listeners = new Map<string, (event: unknown) => void>(), shown: unknown[] = [], opened: string[] = [];
  const context = { URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, self: {} as unknown, location: { origin: 'https://hub.example' },
    registration: { showNotification: async (title: string, options: object) => { shown.push({ title, ...options }); } },
    clients: { matchAll: async () => clients, openWindow: async (url: string) => { opened.push(url); } },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) };
  context.self = context; runInNewContext(source, context);
  async function dispatch(kind: string, event: object) { let work: Promise<unknown> | undefined; listeners.get(kind)?.({ ...event, waitUntil: (promise: Promise<unknown>) => { work = promise; } }); await work; }
  const notification = { schema: 'project-push-v1', title: 'A question', body: 'Which colour?', url: '/projects/project?view=overview', tag: 'question' };
  return { shown, opened, notification, dispatch };
}
test('push validates its versioned payload and shows the configured title, icon, tag and deep link', async () => {
  const f = fixture(); await f.dispatch('push', { data: { json: () => f.notification } });
  expect(f.shown).toEqual([{ title: 'A question', body: 'Which colour?', tag: 'question', data: { url: '/projects/project?view=overview' }, icon: '/icon-192.png', badge: '/favicon-32.png' }]);
  await f.dispatch('push', { data: { json: () => ({ ...f.notification, url: '//another.example' }) } }); await f.dispatch('push', { data: { json: () => { throw new Error('Invalid JSON'); } } }); expect(f.shown).toHaveLength(1);
});
test('only a focused visible client at the target path suppresses a push', async () => {
  for (const [focused, visibilityState, url, count] of [[true, 'visible', 'https://hub.example/projects/project', 0], [false, 'visible', 'https://hub.example/projects/project', 1], [true, 'hidden', 'https://hub.example/projects/project', 1], [true, 'visible', 'https://hub.example/projects/other', 1]] as const) {
    const f = fixture([{ focused, visibilityState, url }]); await f.dispatch('push', { data: { json: () => f.notification } }); expect(f.shown).toHaveLength(count);
  }
});
test('a notification click focuses and navigates an existing client', async () => {
  let focused = false, navigated = '', closed = false;
  const f = fixture([{ url: 'https://hub.example/new', focus: async () => { focused = true; }, navigate: async url => { navigated = url; } }]);
  await f.dispatch('notificationclick', { notification: { data: { url: f.notification.url }, close: () => { closed = true; } } });
  expect(closed).toBe(true); expect(focused).toBe(true); expect(navigated).toBe(f.notification.url); expect(f.opened).toHaveLength(0);
});
test('a notification click opens a client when none exists and refuses an external link', async () => {
  const f = fixture(); await f.dispatch('notificationclick', { notification: { data: { url: f.notification.url }, close() {} } });
  await f.dispatch('notificationclick', { notification: { data: { url: '//another.example' }, close() {} } }); expect(f.opened).toEqual([f.notification.url]);
});

test('notification click skips a foreign window and navigates the first same-origin window',async()=>{
 const focused:string[]=[],navigated:string[]=[];const f=fixture([{url:'https://other.example/projects/project',focus:async()=>{focused.push('foreign');}},{url:'https://hub.example/new',focus:async()=>{focused.push('first');},navigate:async url=>{navigated.push(url);}},{url:'https://hub.example/settings',focus:async()=>{focused.push('second');}}]);await f.dispatch('notificationclick',{notification:{data:{url:f.notification.url},close(){}}});expect(focused).toEqual(['first']);expect(navigated).toEqual([f.notification.url]);expect(f.opened).toEqual([]);
});
