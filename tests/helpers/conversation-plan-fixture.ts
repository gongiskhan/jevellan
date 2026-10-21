import { projectFixture } from './project-fixture.js';

export async function conversationPlanFixture(control = false) {
  const f = await projectFixture({ control });
  const id = 'plan_read_fixture';
  await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Plan reader fixture', message: 'Explain the simulated fixture.', clientMessageId: 'plan_reader_first', choices: { schema: 'composer-initial-v1', once: {}, pins: { modelId: 'fixture', effort: 'low' } } });
  await f.app.conversations.wait(id);
  const content = { unknownExtra: false, risks: [], steps: [{ name: 'Inspect', description: 'Preserve data.', optional: null }], title: 'Fixture plan' };
  const pointer = f.app.conversations.ledger(id).putBlob(content).ref;
  return { f, id, content, pointer };
}
