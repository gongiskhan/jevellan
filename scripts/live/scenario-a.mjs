import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { JevClient } from '../../packages/decisions/dist/index.js';
import { changedSource, github, publicTranscript, until, userPrompts } from './client.mjs';
import { titleSimilarity } from './contracts.mjs';

const minutes = n => n * 60000, input = tool => { try { return JSON.parse(tool.input ?? '{}'); } catch { return {}; } };
const active = task => ['active', 'in-review'].includes(task.state);
export async function mergeWhenAsked(client, projectId, threadId, recorder) {
  const view = await client.work(projectId), decision = view.decisions.open.find(row => row.threadId === threadId && row.merge);
  if (!decision) return;
  await client.page.goto(`${client.config.hub}/projects/${projectId}`);
  const waiting = client.page.getByRole('button', { name: /^Waiting/u }); if (await waiting.isVisible()) await waiting.click();
  const card = client.page.locator('.pw-decision').filter({ hasText: decision.question });
  await card.getByRole('button', { name: 'Merge', exact: true }).click();
  recorder.receipt.observations.push(`Owner-authorized sandbox UI merge for ${threadId}: ${decision.question}`);
}
async function pr(client, projectId, task, timeout = minutes(30)) {
  return until(`${task.title}'s pull request to open`, async () => {
    const latest = (await client.tasks(projectId)).find(row => row.id === task.id); if (!latest?.threadId) return;
    await client.watch(projectId, latest.threadId); const view = await client.thread(projectId, latest.threadId); return view.thread.pr ? view : undefined;
  }, timeout);
}
async function merged(client, projectId, task, recorder, deadline) {
  return until(`${task.title}'s pull request to merge`, async () => {
    const latest = (await client.tasks(projectId)).find(row => row.id === task.id); if (!latest?.threadId) return;
    const view = await client.thread(projectId, latest.threadId); if (!view.thread.pr) return;
    await mergeWhenAsked(client, projectId, latest.threadId, recorder);
    const pull = github(`pulls/${view.thread.pr.number}`); if (!pull.merged) return;
    const route = await client.call('GET', `/api/projects/${projectId}/threads/${latest.threadId}/pr/route`);
    recorder.receipt.pullRequests.push(pull.number); recorder.receipt.observations.push(`PR #${pull.number} route: ${JSON.stringify(route).slice(0, 2200)}`);
    return { view, pull, route };
  }, Math.max(1, deadline - Date.now()), 5000);
}
export async function scenarioA(client, projectId, recorder, { jevKey, jevModel }) {
  const started = Date.now(), page = client.page; let initial, exportTask, roundingTask, a4Task, a5Tasks, a5Questions, answer, seedThread;
  const createA5 = async () => {
    const requests = [
      ['Add a delete button to customers', 'Add a delete button to customers. Before building, ask the owner whether deletion should archive the customer or remove it.'],
      ['Highlight overdue invoices', 'Highlight overdue invoices. Before building, ask the owner which colour to use: red or amber.'],
      ['Paginate the customers list', 'Paginate the customers list. Before building, ask the owner for the page size: 10, 25 or 50.'],
      ["Show each customer's start date", "Show each customer's start date on the customers page. Before building, ask how dates should be formatted."],
    ]; a5Tasks = []; for (const [title, brief] of requests) a5Tasks.push(await client.task(projectId, title, brief));
  };
  await recorder.step('A1', 'Exactly two owner-request tasks, both named in the reply; both active with Jev placement within ten minutes.', async () => {
    initial = new Set((await client.tasks(projectId)).map(row => row.id));
    const turn = await client.owner(projectId, 'Add a CSV export to the customers page, and fix the invoice totals: some are off by a cent.', recorder);
    const tasks = (await client.tasks(projectId)).filter(row => !initial.has(row.id)); assert.equal(tasks.length, 2); assert(tasks.every(row => row.source === 'owner-request'));
    exportTask = tasks.find(row => /export|csv/iu.test(row.title)); roundingTask = tasks.find(row => /round|total|cent/iu.test(row.title)); assert(exportTask && roundingTask && exportTask.id !== roundingTask.id);
    for (const task of tasks) assert(turn.reply.includes(task.title));
    const placed = await until('both owner tasks to become active', async () => { const rows = (await client.tasks(projectId)).filter(row => tasks.some(task => task.id === row.id)); return rows.length === 2 && rows.every(active) ? rows : undefined; }, minutes(10));
    for (const task of placed) { assert(task.threadId); await client.watch(projectId, task.threadId); const view = await client.thread(projectId, task.threadId); assert.equal(view.placement.source, 'jev'); }
    return { tasks: placed.map(({ id, title, threadId }) => ({ id, title, threadId })), reply: turn.reply };
  });
  await recorder.step('A2', 'The VAT follow-up messages the active export thread and creates no task.', async () => {
    const current = await until('the export thread to be active before merge', async () => { const task = (await client.tasks(projectId)).find(row => row.id === exportTask.id); if (!task?.threadId || !active(task)) return; const view = await client.thread(projectId, task.threadId); return view.thread.pr?.state !== 'merged' ? view : undefined; }, minutes(20));
    const before = (await client.tasks(projectId)).map(row => row.id), turn = await client.owner(projectId, 'For the customers export, also include the VAT number.', recorder);
    assert(turn.tools.some(tool => tool.tool === 'jevellan_thread_message' && (tool.threadId ?? input(tool).threadId) === current.thread.id)); assert(!turn.tools.some(tool => tool.tool === 'jevellan_task_create'));
    assert.deepEqual((await client.tasks(projectId)).map(row => row.id), before); return { threadId: current.thread.id, tools: turn.tools };
  });
  await recorder.step('A3', 'A failed result check is diagnosed through its job log and CHANGELOG message; both PRs merge within 45 minutes; the rounding regression fails at baseline.', async () => {
    const diagnosis = await until('a failed check to be diagnosed on the next coordinator turn', () => {
      const rows = client.ledger(projectId);
      for (const failed of rows.filter(row => row.type === 'coordinator-event' && row.data.kind === 'pr-update' && row.data.change === 'checks-failed')) {
        const turn = rows.find(row => row.type === 'coordinator-turn-start' && row.data.eventIds.includes(failed.data.id)); if (!turn) continue;
        const tools = rows.filter(row => row.type === 'coordinator-tool' && row.turn === turn.turn).map(row => row.data);
        const log = tools.find(tool => tool.tool === 'jevellan_github' && input(tool).action === 'job_log'), message = tools.find(tool => tool.tool === 'jevellan_thread_message' && input(tool).threadId === failed.data.threadId && /CHANGELOG/u.test(input(tool).text ?? ''));
        if (log && message) { const job = github(`actions/jobs/${input(log).jobId}`); assert.equal(job.name, 'result'); return { eventId: failed.id, jobId: job.id, tools }; }
      }
    }, Math.max(1, started + minutes(45) - Date.now()));
    const results = []; for (const task of [exportTask, roundingTask]) results.push(await merged(client, projectId, task, recorder, started + minutes(45)));
    const exportDiff = changedSource(results[0].pull.number); assert(/vat/iu.test(exportDiff.patch)); assert(exportDiff.files.some(row => /test|spec/iu.test(row.filename) && /vat/iu.test(row.patch ?? '')));
    const roundingDiff = changedSource(results[1].pull.number); const tests = roundingDiff.files.filter(row => /\.test\.ts$/u.test(row.filename)); assert(tests.length);
    const { regressionAtBaseline } = await import('./setup.mjs'); const baseline = await regressionAtBaseline(client.config, results[1].pull.head.sha, tests.map(row => row.filename)); assert(baseline.failedForAssertion);
    return { diagnosis, pulls: results.map(row => row.pull.number), regression: baseline };
  });
  await recorder.step('A4', 'Durable CHANGELOG knowledge crosses providers in the first prompt and first passing push; Project now includes the concurrent work.', async () => {
    const memory = await until('CHANGELOG to reach regular memory or the inbox', async () => { const view = await client.memory(projectId); return [...view.notes, ...view.inbox].some(note => /CHANGELOG/u.test(note.content)) ? view : undefined; }, minutes(35));
    const notes = [...memory.notes, ...memory.inbox], note = notes.find(row => /CHANGELOG/u.test(row.content)); const runtime = /^runtime:\s*["']?(claude|codex)["']?\s*$/mu.exec(note.content)?.[1]; assert(runtime, 'The learned note must retain its source provider.');
    const learnedData = notes.some(row => /SANDBOX_DATA_DIR/u.test(row.content)); const other = runtime === 'claude' ? 'codex' : 'claude';
    const base = github('git/ref/heads/main').object.sha;
    const receipt = await client.task(projectId, 'Add sort by creation date to the customers page', 'Add sort by creation date to the customers page.', { runtimeId: other });
    a4Task = await until('the cross-provider task to start', async () => { const task = (await client.tasks(projectId)).find(row => row.id === receipt.taskId); return task?.threadId ? task : undefined; }, minutes(10)); await client.watch(projectId, a4Task.threadId);
    const view = await until('the cross-provider first prompt to be recorded', async () => { const view = await client.thread(projectId, a4Task.threadId); return userPrompts(view).length ? view : undefined; }, minutes(10));
    assert.equal(view.thread.runtime, other); const prompt = userPrompts(view)[0]; assert(/Project memory/u.test(prompt) && /CHANGELOG/u.test(prompt));
    await createA5();
    const observerView = await until('an A5 thread to receive Project now while sorting runs', async () => { for (const receipt of a5Tasks) { const task = (await client.tasks(projectId)).find(row => row.id === receipt.taskId); if (!task?.threadId) continue; const view = await client.thread(projectId, task.threadId); if (userPrompts(view).some(text => /Project now/u.test(text) && text.includes(a4Task.title))) return view; } }, minutes(10));
    await pr(client, projectId, a4Task);
    const first = client.ledger(projectId).find(row => row.type === 'coordinator-event' && row.data.kind === 'thread-published' && row.data.threadId === a4Task.threadId && row.data.result === 'pr-opened')?.data.commit; assert(first);
    const firstDiff = github(`compare/${base}...${first}`); assert(firstDiff.files.some(row => row.filename === 'CHANGELOG.md'));
    const checks = await until('the first push result check', () => { const checks = github(`commits/${first}/check-runs?per_page=100`).check_runs; return checks.find(row => row.name === 'result' && row.status === 'completed'); }, minutes(20)); assert.equal(checks.conclusion, 'success');
    if (learnedData) { const turns = publicTranscript(await client.thread(projectId, a4Task.threadId)), commands = turns.flatMap(row => row.tools).filter(tool => /Bash|exec_command|shell/iu.test(tool.name) && /npm\s+(?:run\s+)?test|vitest/u.test(tool.input)); assert(commands.length); assert(/SANDBOX_DATA_DIR/u.test(commands[0].input)); assert(!commands.some(row => /SANDBOX_DATA_DIR is not set/u.test(row.output ?? ''))); }
    recorder.receipt.notes.push(note.permalink); return { learnedBy: runtime, receivedBy: other, note: note.permalink, prompt: prompt.slice(0, 1800), firstCommit: first, checkId: checks.id, observer: observerView.thread.id };
  });
  await recorder.step('A5', 'Three questions share card/context numbering; one owner chat answer is distributed to each thread without mixing answers; date formatting uses the notebook.', async () => {
    if (!a5Tasks) await createA5();
    const view = await until('three owner questions to open', async () => { const view = await client.work(projectId); return view.decisions.open.length === 3 ? view : undefined; }, minutes(30)); a5Questions = view.decisions.open;
    const tasks = await client.tasks(projectId); a5Tasks = a5Tasks.map(receipt => tasks.find(row => row.id === receipt.taskId)); assert(a5Tasks.every(Boolean));
    for (const task of a5Tasks) { assert(task.threadId); await client.watch(projectId, task.threadId); }
    assert(!a5Questions.some(question => question.threadId === a5Tasks[3].threadId));
    const notebookMessage = client.ledger(projectId).filter(row => row.type === 'coordinator-tool').map(row => row.data).find(tool => tool.tool === 'jevellan_thread_message' && input(tool).threadId === a5Tasks[3].threadId && /DD\/MM\/YYYY/u.test(input(tool).text ?? '')); assert(notebookMessage);
    await page.goto(`${client.config.hub}/projects/${projectId}`); const waiting = page.getByRole('button', { name: /^Waiting/u }); if (await waiting.isVisible()) await waiting.click();
    const cards = page.locator('.pw-decision'); await expect(cards).toHaveCount(3);
    const labels = a5Questions.map((question, index) => { const position = a5Tasks.findIndex(task => task.threadId === question.threadId); assert(position >= 0 && position < 3); return `${index + 1} ${['archive', 'amber', '25'][position]}`; });
    for (let index = 0; index < 3; index++) { await expect(cards.nth(index).getByLabel(`Question ${index + 1}`, { exact: true })).toHaveText(String(index + 1)); await expect(cards.nth(index)).toContainText(a5Questions[index].question); }
    const latest = client.ledger(projectId).findLast(row => row.type === 'coordinator-text')?.data.text ?? ''; for (let index = 0; index < 3; index++) { assert(new RegExp(`(?:^|\\n)\\s*${index + 1}[.)]`, 'u').test(latest)); assert(latest.includes(a5Tasks.find(task => task.threadId === a5Questions[index].threadId).title)); for (const option of a5Questions[index].options) assert(latest.includes(option.label)); } assert(!/(?:^|\n)\s*4[.)]/u.test(latest));
    answer = labels.join(', '); await client.owner(projectId, answer, recorder);
    const answered = await client.work(projectId); assert.equal(answered.decisions.open.length, 0);
    for (const question of a5Questions) { const saved = answered.decisions.answered.find(row => row.id === question.id); assert.equal(saved?.answer?.source, 'owner-chat'); assert.equal(saved.answer.ownerMessage, answer); }
    const messages = client.ledger(projectId).filter(row => row.type === 'coordinator-tool' && row.data.tool === 'jevellan_thread_message').map(row => input(row.data));
    for (let index = 0; index < 3; index++) { const own = messages.findLast(row => row.threadId === a5Tasks[index].threadId), value = ['archive', 'amber', '25'][index]; assert(own?.text.toLowerCase().includes(value)); for (let other = 0; other < 3; other++) if (other !== index) assert(!own.text.toLowerCase().includes(['archive', 'amber', '25'][other])); }
    return { questions: a5Questions.map(({ id, threadId, question }) => ({ id, threadId, question })), answer };
  });
  await recorder.step('A6', 'The pagination cancellation is sent immediately after A5 answers; its work stops and never merges.', async () => {
    const turn = await client.owner(projectId, 'Actually, drop the pagination one.', recorder);
    const task = await until('pagination to be cancelled or stopped', async () => { const task = (await client.tasks(projectId)).find(row => row.id === a5Tasks[2].id); const view = await client.thread(projectId, task.threadId); return task.state === 'cancelled' || view.thread.state === 'stopped' ? { task, view } : undefined; }, minutes(5));
    if (task.view.thread.pr) assert(!github(`pulls/${task.view.thread.pr.number}`).merged); assert(/drop|cancel|stop/iu.test(turn.reply)); return { taskId: task.task.id, threadId: task.view.thread.id, reply: turn.reply };
  });
  await recorder.step('A7', 'Status names every active thread/state/PR and changes no task.', async () => {
    const before = await client.tasks(projectId), work = await client.work(projectId), threads = work.threads.filter(row => !['done', 'stopped', 'failed'].includes(row.state)); assert(threads.length, 'Status must be requested while threads are active.');
    const turn = await client.owner(projectId, 'status?', recorder); assert(!turn.tools.some(row => ['jevellan_task_create', 'jevellan_task_update', 'jevellan_task_action'].includes(row.tool)));
    const after = await client.tasks(projectId); assert.deepEqual(after.map(row => [row.id, row.title, row.brief]), before.map(row => [row.id, row.title, row.brief]));
    for (const thread of threads) { assert(turn.reply.includes(thread.title)); if (thread.pr) assert(turn.reply.includes(String(thread.pr.number))); assert(/running|active|working|waiting|checks|idle|publishing|review|queued|preparing/iu.test(turn.reply)); }
    return { threads: threads.map(({ id, title, state, pr }) => ({ id, title, state, pull: pr?.number })), reply: turn.reply };
  });
  await recorder.step('A5-output', 'The answered task PRs archive customers, use amber, use page size 25 when published, and render DD/MM/YYYY.', async () => {
    for (let index = 0; index < 3; index++) { const expected = ['archive', 'amber', '25'][index]; const prompt = await until('the answered thread to receive its own answer', async () => { const view = await client.thread(projectId, a5Tasks[index].threadId); return userPrompts(view).find(text => text.toLowerCase().includes(expected) && /coordinator|owner/iu.test(text)); }, minutes(10)); for (let other = 0; other < 3; other++) if (other !== index) assert(!prompt.toLowerCase().includes(['archive', 'amber', '25'][other])); }
    const checks = [/archiv/iu, /amber|#f59e0b|#ffbf00/iu, /\b25\b/u, /DD\/MM\/YYYY|toLocaleDateString|en-GB/u], pulls = [];
    for (let index = 0; index < 4; index++) { const view = await pr(client, projectId, a5Tasks[index], minutes(30)); const diff = changedSource(view.thread.pr.number); assert(checks[index].test(diff.patch)); pulls.push(view.thread.pr.number); }
    return { pulls };
  });
  await recorder.step('A8', 'A phone tap runs the reserved owner script in the thread worktree; its zero exit result starts the next turn without owner chat and the task finishes.', async () => {
    const before = new Set((await client.tasks(projectId)).map(row => row.id)); await client.owner(projectId, 'Generate seed data for the customers screen. The last step is scripts/owner-only.sh, which only I run.', recorder);
    const found = await until('a seed-data thread to report the owner command', async () => { for (const task of (await client.tasks(projectId)).filter(row => !before.has(row.id) && row.threadId)) { const view = await client.thread(projectId, task.threadId), report = view.reports.find(row => ['blocked', 'needs-decision'].includes(row.status) && row.ownerCommands?.some(command => command.command.includes('scripts/owner-only.sh') && command.cwd === 'worktree')); if (report) return { task, view, report }; } }, minutes(20)); seedThread = found.view.thread;
    await client.watch(projectId, seedThread.id); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${client.config.hub}/projects/${projectId}/threads/${seedThread.id}`);
    const card = page.locator('.owner-command').filter({ hasText: 'scripts/owner-only.sh' }).first(); await expect(card).toContainText('scripts/owner-only.sh'); await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeVisible(); await card.getByRole('button', { name: 'Run in Terminal', exact: true }).click(); await expect(page).toHaveURL(/\/terminals\//u);
    const terminalId = new URL(page.url()).pathname.split('/').at(-1), snapshot = await until('the owner script completion record', async () => { const snapshot = await client.terminalSnapshot(terminalId); return snapshot.commands.some(row => row.command.includes('owner-only.sh') && row.exitCode === 0) ? snapshot : undefined; }, minutes(2)); assert.equal(snapshot.session.deviceId, seedThread.ownerDeviceId);
    await client.run('test -f owner-ran.txt && cat owner-ran.txt'); await until('owner-ran.txt in the worktree', async () => (await client.terminalSnapshot(terminalId)).commands.some(row => row.command.includes('test -f owner-ran.txt') && row.exitCode === 0), minutes(2));
    const resumed = await until('the command result to reach the thread', async () => { const view = await client.thread(projectId, seedThread.id); return userPrompts(view).find(text => /The owner ran your command/u.test(text) && /Exit code: 0/u.test(text) && /Owner seed step complete/u.test(text)); }, minutes(2));
    await page.goto(`${client.config.hub}/projects/${projectId}/threads/${seedThread.id}`); await expect(page.locator('.owner-command').first()).toContainText('Ran in terminal at'); await until('the seed-data thread to reach done', async () => { await mergeWhenAsked(client, projectId, seedThread.id, recorder); return (await client.thread(projectId, seedThread.id)).thread.state === 'done'; }, minutes(30));
    return { threadId: seedThread.id, terminalId, cwd: snapshot.session.cwd, commandResult: resumed.slice(-1800) };
  });
  await recorder.step('A9', 'A refused force-delete is recorded by the safety hook and returned as an exact owner command.', async () => {
    await client.terminal(projectId, { deviceId: seedThread.ownerDeviceId, threadId: seedThread.id, cwd: 'worktree' }); const terminalId = new URL(page.url()).pathname.split('/').at(-1); await client.run('git branch old/experiment'); await until('the owner-created local branch', async () => (await client.terminalSnapshot(terminalId)).commands.some(row => row.command === 'git branch old/experiment' && row.exitCode === 0), minutes(2));
    await client.owner(projectId, 'In the seed data worktree, also delete the local branch old/experiment with git branch -D.', recorder);
    const evidence = await until('the refused delete to become an owner command', async () => { for (const thread of (await client.work(projectId)).threads) { const view = await client.thread(projectId, thread.id); const report = view.reports.find(row => row.ownerCommands?.some(command => command.command.includes('git branch -D old/experiment'))); if (!report) continue; const transcript = publicTranscript(view); assert(transcript.some(turn => turn.tools.some(tool => /denied|refused|not allowed|ownerCommands/iu.test(tool.output ?? ''))), 'The safety hook denial must be observed, not merely promised.'); return { threadId: thread.id, ownerCommands: report.ownerCommands }; } }, minutes(20)); return evidence;
  });
  await recorder.step('A10', 'The coordinator reads the owner terminal and diagnoses the invoice date/time-zone failure without asking for pasted output.', async () => {
    const session = await client.terminal(projectId, { deviceId: client.config.proDeviceId }); await client.run('TZ=Asia/Tokyo npx vitest run src/invoices');
    await until('the deliberately failing invoice command', async () => (await client.terminalSnapshot(session.id)).commands.some(row => row.command.includes('Asia/Tokyo') && row.exitCode !== null && row.exitCode !== 0), minutes(5));
    const turn = await client.owner(projectId, "I just ran the invoice tests in my terminal and they failed. What's wrong?", recorder); assert(turn.tools.some(tool => tool.tool === 'jevellan_terminal_read')); assert(/time.?zone|date mismatch|TZ|Tokyo/iu.test(turn.reply)); assert(!/paste|copy.*output/iu.test(turn.reply)); return { terminalId: session.id, tools: turn.tools, reply: turn.reply };
  });
  await recorder.step('A11', 'Refill proposes at most one sufficiently detailed draft per goal; rejection is remembered and neither title similarity nor Jev finds repeated work.', async () => {
    for (const task of await client.tasks(projectId)) if (['draft', 'queued', 'active', 'in-review'].includes(task.state)) await client.action(projectId, task, 'cancel');
    await client.settings(projectId, { refill: { enabled: true, minIntervalMinutes: 10 } });
    const drafts = await until('one draft per goal', async () => { const drafts = (await client.tasks(projectId)).filter(row => row.state === 'draft'); return drafts.length >= 2 ? drafts : undefined; }, minutes(15)); assert.equal(new Set(drafts.map(row => row.goalId)).size, drafts.length); assert(drafts.every(row => row.brief.length >= 400));
    const rejected = drafts[0], approved = drafts[1]; await client.action(projectId, rejected, 'reject', "Not this one, and don't propose it again"); await client.action(projectId, approved, 'approve');
    const newer = await until('the next refill to propose new work', async () => { const tasks = await client.tasks(projectId); return tasks.filter(row => row.state === 'draft' && !drafts.some(old => old.id === row.id)).length ? tasks.filter(row => row.state === 'draft' && !drafts.some(old => old.id === row.id)) : undefined; }, minutes(20));
    assert(jevKey, 'A dedicated Jev test key is required for the real rejection assertion.'); const jev = new JevClient({ key: () => jevKey, timeoutMs: 60000 }); const scores = [];
    for (const draft of newer) { const similarity = titleSimilarity(rejected.title, draft.title); assert(similarity < 0.6); const response = await jev.decide({ schema: 'jev-request-v1', model: jevModel, state: JSON.stringify({ rejected: { title: rejected.title, brief: rejected.brief }, proposed: { title: draft.title, brief: draft.brief } }), questions: { same: { type: 'noul', instructions: 'This is the same work as the rejected task', criteria: { true: 'The proposed task repeats the rejected work.', false: 'The proposed task is different work.' } } } }); assert(response.answers.same.noul < 0.5); scores.push({ taskId: draft.id, titleSimilarity: similarity, noul: response.answers.same.noul }); }
    const notebook = await client.call('GET', `/api/projects/${projectId}/notebook`), memory = await client.memory(projectId); assert(JSON.stringify(notebook).includes(rejected.title) || [...memory.notes, ...memory.inbox].some(row => row.content.includes(rejected.title)));
    const cancelled = await client.thread(projectId, a5Tasks[2].threadId); if (cancelled.thread.pr) assert(!github(`pulls/${cancelled.thread.pr.number}`).merged, 'Cancelled pagination must still be unmerged at scenario end.');
    return { rejected: rejected.id, approved: approved.id, scores };
  });
}
