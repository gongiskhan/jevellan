import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';
import { until } from './client.mjs';
import { REST_STATES } from '../../packages/projects/dist/thread-runner.js';

const minutes = n => n * 60000;
export async function terminalToolbarAction(page, label) {
  const action = page.getByRole('button', { name: label, exact: true }).filter({ visible: true });
  if (!await action.isVisible()) await page.getByRole('button', { name: 'Terminal menu', exact: true }).click();
  await action.click();
}
export async function copyTerminalOutput(page, label, ready) {
  await terminalToolbarAction(page, label);
  return until(`${label} to finish writing the expected clipboard range`, async () => {
    const text = await page.evaluate(() => globalThis.navigator.clipboard.readText());
    return ready(text) ? text : undefined;
  }, 30000, 100);
}
export function takeoverReady(view) { return REST_STATES.includes(view.thread.state) && !!view.transcript; }

export function nativeTakeoverReady(snapshot) {
  const text = snapshot.tail.replace(/\s/gu, '');
  return snapshot.session.status === 'open' && /(?:ClaudeCodev|OpenAICodex)/u.test(text)
    && (text.includes('?forshortcuts') || text.includes('bypasspermissionson'));
}

export async function exitNativeTakeover(client, page, projectId, threadId, sessionId, timeout = minutes(2), interval = 2000) {
  await page.locator('.xterm-helper-textarea').press('Control+d');
  let confirmed = false;
  await until('the native thread to detach', async () => {
    if ((await client.thread(projectId, threadId)).thread.state !== 'attached') return true;
    if (!confirmed && (await client.terminalSnapshot(sessionId)).tail.replace(/\s/gu, '').includes('PressCtrl-Dagaintoexit')) {
      confirmed = true; await page.locator('.xterm-helper-textarea').press('Control+d');
    }
    return false;
  }, timeout, interval);
}
export async function scenarioD(client, projectId, recorder) {
  const page = client.page; let session, madrid, takeover;
  const last = async (id, text, timeout = minutes(2)) => until(`terminal command ${text} to end`, async () => (await client.terminalSnapshot(id)).commands.findLast(row => row.command === text && row.endedAt), timeout, 100);
  const shots = [];
  const shot = async (name, expected) => { const image = await page.screenshot({ fullPage: true }); shots.push({ name, expected, image }); };
  await recorder.step('D1', 'The Pro project terminal opens in its registered dedicated checkout.', async () => {
    await page.goto(`${client.config.hub}/projects/${projectId}`); await page.getByRole('button', { name: 'Terminal', exact: true }).click(); await page.getByLabel('Project terminals').getByRole('button', { name: 'Open terminal', exact: true }).click();
    await expect(page).toHaveURL(/\/terminals\//u); session = (await client.terminalSnapshot(new URL(page.url()).pathname.split('/').at(-1))).session; assert.equal(session.deviceId, client.config.proDeviceId); await client.run('pwd'); const record = await last(session.id, 'pwd'); assert(record.output.includes(client.config.proCheckout)); await shot('project-terminal', 'a connected project terminal with usable controls and no clipped text'); return { id: session.id, device: session.deviceId, cwd: session.cwd, output: record.output };
  });
  await recorder.step('D2', 'The dev-madrid device terminal uses the existing relay and prints the actual remote hostname.', async () => {
    await page.goto(`${client.config.hub}/settings/devices`); const device = page.locator('.card').filter({ hasText: /dev-madrid/u }); await device.getByRole('button', { name: 'Terminal', exact: true }).click(); await expect(page).toHaveURL(/\/terminals\//u);
    madrid = (await client.terminalSnapshot(new URL(page.url()).pathname.split('/').at(-1))).session; assert.equal(madrid.deviceId, client.config.madridDeviceId); await client.run('hostname'); const record = await last(madrid.id, 'hostname'); const { remote } = await import('./client.mjs'); const host = remote(client.config, "import {hostname} from 'node:os'; console.log(hostname());", {}); assert(record.output.includes(host)); await shot('madrid-terminal', 'a connected dev-madrid terminal with the remote hostname and usable controls'); return { id: madrid.id, device: madrid.deviceId, hostname: host, output: record.output };
  });
  await recorder.step('D3', 'Type or dictate a command and Run send echo hello through the real PTY.', async () => { await page.goto(`${client.config.hub}/terminals/${session.id}`); await client.run('echo hello'); const record = await last(session.id, 'echo hello'); assert(record.output.includes('hello')); return { command: record.command, output: record.output }; });
  await recorder.step('D4', 'Sticky Ctrl and C interrupt sleep within two seconds and preserve its non-zero exit record.', async () => {
    await client.run('sleep 100'); await until('sleep to start', async () => (await client.terminalSnapshot(session.id)).commands.at(-1)?.command === 'sleep 100', 10000, 100); const started = Date.now();
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click(); await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true'); await page.getByRole('button', { name: 'C', exact: true }).click(); const record = await last(session.id, 'sleep 100', 2000); assert(Date.now() - started <= 2000); assert(record.exitCode !== null && record.exitCode !== 0); return { exitCode: record.exitCode, elapsedMs: Date.now() - started };
  });
  await recorder.step('D5', 'Reload reconnects the same terminal and replays hello in its scrollback.', async () => { await page.reload(); await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({ timeout: 30000 }); const snapshot = await client.terminalSnapshot(session.id); assert.equal(snapshot.session.id, session.id); assert(snapshot.tail.includes('hello')); await expect(page.locator('.xterm-screen')).toBeVisible(); return { sessionId: session.id, replayed: 'hello' }; });
  await recorder.step('D6', 'The copy buttons include exactly the requested command range and strip every escape code.', async () => {
    for (let n = 1; n <= 6; n++) { await client.run(`echo record-${n}`); await last(session.id, `echo record-${n}`); }
    const copy = async (label, ready) => { const text = await copyTerminalOutput(page, label, ready); assert(![...text].some(char => [27, 155].includes(char.charCodeAt(0)))); return text; };
    const one = await copy('Copy last command', text => text.includes('$ echo record-6') && !text.includes('record-5')); assert(one.includes('$ echo record-6') && !one.includes('record-5')); const five = await copy('Copy last 5 commands', text => [2, 3, 4, 5, 6].every(n => text.includes(`$ echo record-${n}`)) && !text.includes('record-1')); for (let n = 2; n <= 6; n++) assert(five.includes(`$ echo record-${n}`)); assert(!five.includes('record-1')); const all = await copy('Copy all', text => text.includes('hello') && text.includes('record-1') && text.includes('record-6')); assert(all.includes('hello') && all.includes('record-1') && all.includes('record-6')); await shot('copy-controls', 'terminal copy and Send to controls reachable at this layout'); return { one, five, allChars: all.length };
  });
  await recorder.step('D7', 'Send to… delivers the last command to the coordinator and starts its next turn.', async () => {
    const before = Date.now(); await terminalToolbarAction(page, 'Send to…'); await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
    const event = await until('the coordinator to receive the sent terminal output', () => client.ledger(projectId).find(row => row.type === 'coordinator-event' && row.data.kind === 'user-message' && Date.parse(row.t) >= before && row.data.text.includes('echo record-6')), minutes(2)); const turn = await until('the coordinator turn with terminal output', () => client.ledger(projectId).find(row => row.type === 'coordinator-turn-start' && row.data.eventIds.includes(event.data.id)), minutes(2)); return { eventId: event.id, turn: turn.turn, text: event.data.text };
  });
  await recorder.step('D8', 'Take over in browser attaches a real native thread session; leaving detaches and returns it to Jevellan.', async () => {
    const receipt = await client.task(projectId, 'Terminal takeover check', 'Inspect the invoices app, report its structure and wait for the owner before making any change.');
    const task = await until('a real resting session to take over', async () => { const task = (await client.tasks(projectId)).find(row => row.id === receipt.taskId); if (!task?.threadId) return; const view = await client.thread(projectId, task.threadId); return takeoverReady(view) ? task : undefined; }, minutes(15));
    await page.goto(`${client.config.hub}/projects/${projectId}/threads/${task.threadId}`); await page.getByRole('button', { name: 'Take over in browser', exact: true }).click(); await expect(page).toHaveURL(/\/terminals\//u); await until('the real thread attachment', async () => (await client.thread(projectId, task.threadId)).thread.state === 'attached', minutes(2));
    const terminalId = new URL(page.url()).pathname.split('/terminals/')[1];
    takeover = { id: terminalId };
    await until('the resumed native coding prompt beyond first-run dialogs', async () => nativeTakeoverReady(await client.terminalSnapshot(terminalId)), minutes(2));
    await shot('native-takeover', 'a browser terminal attached to a resumed native coding session, past setup and trust dialogs, with usable exit controls');
    // Follow the native client's exit confirmation without sending a synthetic agent response.
    await exitNativeTakeover(client, page, projectId, task.threadId, terminalId);
    const command = await until('the completed native attach command', async () => (await client.terminalSnapshot(terminalId)).commands.findLast(row => row.command.includes(' thread attach ') && row.endedAt), minutes(2));
    assert.equal(command.exitCode, 0);
    return { threadId: task.threadId, terminalId, exitCode: command.exitCode, returnedState: (await client.thread(projectId, task.threadId)).thread.state };
  });
  await recorder.step('D9', 'Every captured screen passes the dedicated live vision rubric in this layout.', async () => {
    const { judgeScreenshot } = await tsImport('../../tests/e2e/vision.ts', import.meta.url); const directory = join(recorder.output, new Date().toISOString().slice(0, 10), `${recorder.receipt.run}-screens`); mkdirSync(directory, { recursive: true }); const evidence = [];
    for (const shot of shots) { const path = join(directory, `${shot.name}.png`); writeFileSync(path, shot.image); const result = await judgeScreenshot(shot.image, shot.expected); evidence.push({ screenshot: path, expected: shot.expected, result }); assert(result.ok && result.blocking.length === 0, JSON.stringify(result)); }
    return { layout: recorder.receipt.layout, screens: evidence };
  });
  for (const terminal of [session, madrid, takeover]) if (terminal) await client.call('POST', `/api/terminals/${terminal.id}/close`, { schema: 'empty-request-v1' });
}
