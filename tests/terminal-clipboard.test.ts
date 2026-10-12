import { afterEach, expect, test, vi } from 'vitest';
import { copyPendingText } from '../apps/web/src/clipboard.js';
afterEach(() => vi.unstubAllGlobals());
test('terminal copy starts the ClipboardItem write inside the gesture before its server text resolves', async () => {
  let supply!: (text: string) => void; const text = new Promise<string>(resolve => { supply = resolve; });
  class Item { constructor(readonly content: Record<string, Promise<Blob>>) {} }
  const copied: string[] = [], write = vi.fn(async (items: Item[]) => { copied.push(await (await items[0]!.content['text/plain']!).text()); });
  vi.stubGlobal('window', { isSecureContext: true }); vi.stubGlobal('navigator', { clipboard: { write } }); vi.stubGlobal('ClipboardItem', Item);
  const result = copyPendingText(text); expect(write).toHaveBeenCalledOnce(); expect(copied).toEqual([]);
  supply('$ echo café\ncafé'); expect(await result).toBe(true); expect(copied).toEqual(['$ echo café\ncafé']);
});
