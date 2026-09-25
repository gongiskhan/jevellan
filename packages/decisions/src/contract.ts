import { z } from 'zod';

const text = z.string().min(1);
const probability = z.number().min(0).max(1);
const questionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const probabilities = z.record(text, probability);

export const JevQuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), instructions: text, criteria: z.record(text, text).refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255, 'Choice requires 2–255 options.') }),
  z.strictObject({ type: z.literal('score'), instructions: text, criteria: z.array(text).min(2).max(10) }),
  z.strictObject({ type: z.literal('noul'), instructions: text, criteria: z.strictObject({ true: text, false: text }) }),
]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;
export const JevQuestionsSchema = z.record(questionId, JevQuestionSchema).refine((value) => Object.keys(value).length > 0, 'At least one question is required.');
export type JevQuestions = z.infer<typeof JevQuestionsSchema>;

export const JevRequestSchema = z.strictObject({
  schema: z.literal('jev-request-v1'), model: text,
  state: text.refine((value) => { try { JSON.parse(value); return true; } catch { return false; } }, 'State must be JSON text.'),
  questions: JevQuestionsSchema,
});
export type JevRequest = z.infer<typeof JevRequestSchema>;

export const JevAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), choice: text, probabilities, confidence: probability }),
  z.strictObject({ type: z.literal('score'), score: z.number(), legend: z.record(z.string(), z.string()), probabilities, confidence: probability }),
  z.strictObject({ type: z.literal('noul'), noul: probability }),
]);
export const JevUsageSchema = z.strictObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });
const WireResponseSchema = z.strictObject({ model: text, answers: z.record(questionId, JevAnswerSchema), usage: JevUsageSchema });
export const JevResponseSchema = WireResponseSchema.extend({ schema: z.literal('jev-response-v1') });
export type JevResponse = z.infer<typeof JevResponseSchema>;

const WireModelsSchema = z.strictObject({ models: z.array(z.strictObject({ name: text, description: z.string(), release_date: text })) });
export const JevModelsSchema = WireModelsSchema.extend({ schema: z.literal('jev-models-v1') });
export type JevModels = z.infer<typeof JevModelsSchema>;

const errorMessages = {
  'no-key': 'no key configured', auth: 'authentication failed', 'rate-limited': 'rate limited',
  unavailable: 'service unavailable', timeout: 'request timed out', network: 'connection failed',
  'invalid-request': 'invalid request', 'invalid-response': 'invalid response', cancelled: 'decision cancelled',
  'state-too-large': 'decision context exceeds the size limit',
} as const;
export type JevErrorKind = keyof typeof errorMessages;
export class JevError extends Error {
  constructor(readonly kind: JevErrorKind) { super(errorMessages[kind]); this.name = 'JevError'; }
}

export function buildJevRequest(input: JevRequest): Omit<JevRequest, 'schema'> {
  const result = JevRequestSchema.safeParse(input);
  if (!result.success) throw new JevError('invalid-request');
  const { model, state, questions } = result.data;
  return { model, state, questions };
}

function sameKeys(actual: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(actual).length === keys.length && keys.every((key) => Object.hasOwn(actual, key));
}
function distribution(value: Record<string, number>, keys: string[]): boolean {
  return sameKeys(value, keys) && Math.abs(Object.values(value).reduce((sum, p) => sum + p, 0) - 1) <= 0.02 + Number.EPSILON;
}

export function parseJevResponse(body: string, questions: JevQuestions): JevResponse {
  try {
    const response = WireResponseSchema.parse(JSON.parse(body));
    const answers: JevResponse['answers'] = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = Object.hasOwn(response.answers, id) ? response.answers[id] : undefined;
      if (!answer || answer.type !== question.type) throw new JevError('invalid-response');
      if (question.type === 'choice' && answer.type === 'choice') {
        if (!Object.hasOwn(question.criteria, answer.choice) || !distribution(answer.probabilities, Object.keys(question.criteria))
          || answer.probabilities[answer.choice]! < Math.max(...Object.values(answer.probabilities)) - 0.011) throw new JevError('invalid-response');
      }
      if (question.type === 'score' && answer.type === 'score') {
        const keys = question.criteria.map((_, index) => String(index));
        if (!distribution(answer.probabilities, keys) || !sameKeys(answer.legend, keys)
          || answer.score < 0 || answer.score > keys.length - 1) throw new JevError('invalid-response');
      }
      Object.defineProperty(answers, id, { value: answer, enumerable: true, writable: true, configurable: true });
    }
    return JevResponseSchema.parse({ ...response, schema: 'jev-response-v1', answers });
  } catch { throw new JevError('invalid-response'); }
}

export function parseJevModels(body: string): JevModels {
  try { return JevModelsSchema.parse({ ...WireModelsSchema.parse(JSON.parse(body)), schema: 'jev-models-v1' }); }
  catch { throw new JevError('invalid-response'); }
}
