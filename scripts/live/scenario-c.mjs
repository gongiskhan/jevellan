import assert from 'node:assert/strict';
import { github, until } from './client.mjs';

const minutes = n => n * 60000;
export async function scenarioC(client, projectId, recorder) {
  let beforeKey, compaction, invoice;
  await recorder.step('C1', 'The owner sets the invoice title convention in the persistent coordinator session with the test threshold.', async () => {
    await client.owner(projectId, "From now on, start the title of every invoice task with 'Invoices:'.", recorder);
    assert.equal((await client.work(projectId)).coordinator.session.context.thresholdPercent, 20);
    beforeKey = client.ledger(projectId).findLast(row => row.type === 'coordinator-turn-end')?.data.sessionKey; assert(beforeKey);
    return { sessionKey: beforeKey, thresholdPercent: 20 };
  });
  await recorder.step('C2', 'Natural owner messages containing real sandbox CI logs compact the same session within twelve turns; the next prompt starts with fresh context.', async () => {
    const runs = github('actions/runs?per_page=20').workflow_runs, logs = [];
    for (const run of runs) for (const job of github(`actions/runs/${run.id}/jobs?per_page=100`).jobs) { const { command } = await import('./client.mjs'); try { logs.push(command('gh', ['api', `repos/gongiskhan/jevellan-live-sandbox/actions/jobs/${job.id}/logs`], { timeout: 60000 })); } catch { /* Expired logs are skipped; no synthetic logs substitute. */ } if (logs.length >= 4) break; }
    assert(logs.some(log => /test|vitest|invoice/iu.test(log)), 'Real sandbox test output must be available.');
    for (let attempt = 0; attempt < 12; attempt++) {
      const log = logs[attempt % logs.length], repeated = `${log}\n`.repeat(Math.ceil(120000 / Math.max(1, log.length))).slice(0, 120000);
      await client.owner(projectId, `Here's last week's CI log, anything worrying?\n${repeated}`, recorder);
      compaction = client.ledger(projectId).find(row => row.type === 'session-compacted' && row.data.owner.kind === 'coordinator'); if (compaction) break;
    }
    assert(compaction, 'No coordinator compaction after twelve natural log messages.'); assert.equal(compaction.data.thresholdPercent, 20);
    const ended = client.ledger(projectId).findLast(row => row.type === 'coordinator-turn-end'); assert.equal(ended.data.sessionKey, beforeKey);
    return { compaction: compaction.data, sameSessionKey: beforeKey };
  });
  await recorder.step('C3', 'After compaction the fresh prompt keeps the convention and the new invoice task title starts Invoices:.', async () => {
    const before = new Set((await client.tasks(projectId)).map(row => row.id)); await client.owner(projectId, 'Add a PDF download for invoices.', recorder);
    const turn = client.ledger(projectId).find(row => row.type === 'coordinator-turn-start' && row.id > compaction.id); assert(turn?.data.prompt && !turn.data.promptTruncated); assert(/^Project notebook:/u.test(turn.data.prompt)); assert(/Project notebook:/u.test(turn.data.prompt));
    const tasks = (await client.tasks(projectId)).filter(row => !before.has(row.id)); assert.equal(tasks.length, 1); invoice = tasks[0]; assert(invoice.title.startsWith('Invoices:'));
    assert.equal(client.ledger(projectId).findLast(row => row.type === 'coordinator-turn-end').data.sessionKey, beforeKey); return { title: invoice.title, taskId: invoice.id, prompt: turn.data.prompt.slice(0, 1800) };
  });
  await recorder.step('C4', 'A real Codex thread compacts without rotating, receives Task, Project memory and Project now after compaction, and reaches done.', async () => {
    const receipt = await client.task(projectId, 'Write tests for every function in src/invoices and src/customers', 'Write tests for every function in src/invoices and src/customers.', { runtimeId: 'codex' });
    const task = await until('the Codex task thread', async () => (await client.tasks(projectId)).find(row => row.id === receipt.taskId && row.threadId), minutes(10)); await client.watch(projectId, task.threadId);
    const compacted = await until('the Codex thread compaction', () => client.ledger(projectId, task.threadId).find(row => row.type === 'session-compacted'), minutes(30)); assert.equal(compacted.data.runtime, 'codex'); assert.equal(compacted.data.thresholdPercent, 20);
    const after = await until('the first thread turn after compaction', () => client.ledger(projectId, task.threadId).find(row => row.type === 'thread-turn-start' && row.id > compacted.id), minutes(15)); assert(after.data.prompt && !after.data.promptTruncated); const prompt = after.data.prompt;
    const taskAt = prompt.indexOf(task.title), memoryAt = prompt.indexOf('Project memory'), nowAt = prompt.indexOf('Project now'); assert(taskAt >= 0 && memoryAt > taskAt && nowAt > memoryAt);
    const before = client.ledger(projectId, task.threadId).filter(row => row.type === 'thread-turn-end' && row.id < after.id).at(-1); const ended = await until('the resumed thread turn to finish', () => client.ledger(projectId, task.threadId).find(row => row.type === 'thread-turn-end' && row.id > after.id), minutes(30)); assert(before?.data.sessionKey && before.data.sessionKey === ended.data.sessionKey);
    await until('the Codex test-writing thread to reach done', async () => (await client.thread(projectId, task.threadId)).thread.state === 'done', minutes(30)); return { taskId: task.id, threadId: task.threadId, sessionKey: ended.data.sessionKey, compaction: compacted.data, prompt: prompt.slice(0, 1800) };
  });
}
