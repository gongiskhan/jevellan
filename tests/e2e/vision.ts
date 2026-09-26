import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { minimalEnvironment } from '../../packages/core/dist/index.js';

// Vision checks from section 16 of the brief: every browser screenshot is judged against a fixed rubric.
// Only blocking problems fail a test; cosmetic remarks are kept with the evidence.
export const VisionResultSchema = z.object({
  ok: z.boolean(),
  blocking: z.array(z.string()),
  cosmetic: z.array(z.string()),
});
export const VisionEvidenceSchema = z.object({
  schema: z.literal('vision-check-v1'),
  label: z.enum(['live', 'not run']),
  reason: z.string().optional(),
  model: z.string().optional(),
  test: z.string(),
  layout: z.string(),
  screenshot: z.string(),
  expected: z.string(),
  result: VisionResultSchema.optional(),
});
export type VisionEvidence = z.infer<typeof VisionEvidenceSchema>;

const model = process.env.JEVELLAN_TEST_VISION_MODEL ?? 'claude-opus-5-5';
export const visionAvailable = () =>
  process.env.JEVELLAN_VISION !== 'off' && !!process.env.JEVELLAN_TEST_CLAUDE_TOKEN;

const rubric = (expected: string) =>
  `Does this screen show ${expected}? List only blocking problems: overlapping elements, text cut off, unreadable text, controls hidden or unreachable. Answer JSON {ok, blocking[], cosmetic[]}. Reply with the JSON object only.`;

export async function judgeScreenshot(image: Buffer, expected: string): Promise<z.infer<typeof VisionResultSchema>> {
  const token = process.env.JEVELLAN_TEST_CLAUDE_TOKEN;
  if (!token) throw new Error('JEVELLAN_TEST_CLAUDE_TOKEN is not set.');
  // An isolated, disposable Claude home: never the user's own ~/.claude.
  const home = mkdtempSync(join(tmpdir(), 'jevellan-vision-'));
  try {
    const message: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
          { type: 'text', text: rubric(expected) },
        ],
      },
    };
    async function* prompt() {
      yield message;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    let text = '';
    try {
      for await (const event of query({
        prompt: prompt(),
        options: {
          model,
          cwd: home,
          maxTurns: 1,
          allowedTools: [],
          settingSources: [],
          permissionMode: 'dontAsk',
          abortController: controller,
          env: minimalEnvironment('claude', home, { CLAUDE_CODE_OAUTH_TOKEN: token }),
          stderr: () => {},
        },
      })) {
        if (event.type === 'result') {
          if (event.subtype !== 'success') throw new Error(`The vision check did not complete (${event.subtype}).`);
          text = event.result;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return VisionResultSchema.parse(JSON.parse(json));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function writeVisionEvidence(evidence: VisionEvidence) {
  const folder = join('docs', 'acceptance', 'vision', evidence.layout);
  mkdirSync(folder, { recursive: true });
  const name = `${evidence.test.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 90)}--${basename(evidence.screenshot, '.png')}.json`;
  writeFileSync(join(folder, name), JSON.stringify(VisionEvidenceSchema.parse(evidence), null, 2) + '\n');
}

export const visionModel = model;
