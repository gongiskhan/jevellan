import { expect, test } from 'vitest';
import { imageReferences, turnImages } from '../apps/web/src/thread-image-refs.js';

test('finds Claude Read, Codex view_image and screenshot tool paths without dropping spaces', () => {
  for (const key of ['file_path', 'path', 'filename']) expect(imageReferences(JSON.stringify({ [key]: '/work/shots/home phone.png' }))).toContain('/work/shots/home phone.png');
  expect(turnImages({ id: 'turn', role: 'assistant', blocks: [{ type: 'tool', id: 'read', name: 'Read', input: '{"file_path":"screens/home.png"}', output: '[Image attachment]', state: 'completed' }] })).toEqual(['screens/home.png']);
});
test('finds Markdown, quoted paths and screenshot outputs, bounds and deduplicates entries', () => {
  expect(imageReferences('![Home](<screens/home phone.png>)\n`shots/desktop.png`\nSaved /work/shots/home.webp.')).toEqual(expect.arrayContaining(['screens/home phone.png', 'shots/desktop.png', '/work/shots/home.webp']));
  expect(imageReferences('`shot.png` `shot.png`')).toEqual(['shot.png']);
  expect(imageReferences(Array.from({ length: 220 }, (_, i) => `shots/${i}.png`).join('\n'))).toHaveLength(200);
});
test('refuses remote URLs, data images, traversal and non-images as local references', () => {
  for (const input of ['https://example.test/shot.png', 'data:image/png;base64,abc', '../other/shot.png', 'readme.md', '![remote](https://example.test/shot.png)', '"../other/shot.png"']) expect(imageReferences(input), input).toEqual([]);
});

test('source code and shell templates do not become phantom screenshot entries', () => {
  expect(turnImages({ id: 'turn', role: 'assistant', blocks: [{ type: 'tool', id: 'write', name: 'Write', input: JSON.stringify({ file_path: 'capture.py', content: 'capture("home.png")' }), state: 'completed' }] })).toEqual([]);
  expect(turnImages({ id: 'listing', role: 'assistant', blocks: [{ type: 'tool', id: 'ls', name: 'Bash', input: '{"command":"ls shots"}', output: 'one.png\ntwo.png', state: 'completed' }] })).toEqual([]);
  expect(imageReferences('`${OUT}debug-task-${scale}x.png`')).toEqual([]);
});

test('a screenshot path is not offered before its capture tool has finished writing the file', () => {
  const block = { type: 'tool' as const, id: 'capture', name: 'Screenshot', input: '{"path":"shots/phone.png"}', state: 'running' as const };
  expect(turnImages({ id: 'turn', role: 'assistant', blocks: [block] })).toEqual([]);
  expect(turnImages({ id: 'turn', role: 'assistant', blocks: [{ ...block, state: 'completed' }] })).toEqual(['shots/phone.png']);
});
