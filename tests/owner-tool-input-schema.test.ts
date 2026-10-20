import { expect, test } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ComposerChoiceSchema, CorrectStepSchema, OWNER_TOOLS, StepCorrectionPreviewSchema, ownerToolInputSchema } from '../packages/core/dist/index.js';

const tool = OWNER_TOOLS.find(row => row.name === 'jev')!;
const examples = [
  { action: 'composer_save', request: ComposerChoiceSchema.parse({ schema: 'composer-choice-v1', clientRequestId: 'metadata_composer', generation: 0, field: 'effort', mode: 'once', value: 'high' }) },
  { action: 'correction_save', request: CorrectStepSchema.parse({ schema: 'correct-step-v1', clientRequestId: 'metadata_correction', generation: 0, stretch: 1, mode: 'noted', choices: { effort: 'high' } }) },
  { action: 'correction_preview', request: StepCorrectionPreviewSchema.parse({ schema: 'step-correction-preview-v1', clientRequestId: 'metadata_preview', generation: 0, stretch: 1, fields: { action: 'reply', modelId: 'fixture', effort: 'high' } }) },
];

test.each(examples)('advertised MCP inputs accept the valid $action request document', ({ action, request }) => {
  const args = { conversation: 'conversation_fixture', request };
  expect(tool.actions.find(row => row.name === action)!.input.safeParse(args).success).toBe(true);
  const validate = new AjvJsonSchemaValidator().getValidator(ownerToolInputSchema(tool));
  expect(validate({ action, ...args }).valid).toBe(true);
});

test('the canonical action still refuses a request document belonging to another action', () => {
  expect(tool.actions.find(row => row.name === 'correction_save')!.input.safeParse({ conversation: 'conversation_fixture', request: examples[0]!.request }).success).toBe(false);
});
