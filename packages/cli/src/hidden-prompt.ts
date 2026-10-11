import { StringDecoder } from 'node:string_decoder';

/** Terminal-only secret input: no echo, arguments, environment variable or saved prompt history. */
export function hiddenPrompt(prompt: string): Promise<string> {
  const input = process.stdin, output = process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('Enter the migration passphrase in an interactive terminal.');
  const wasRaw = input.isRaw; output.write(prompt); input.setRawMode(true); input.resume();
  return new Promise((accept, reject) => {
    let value = ''; const decoder = new StringDecoder('utf8');
    const finish = (error?: Error) => {
      input.off('data', receive); input.off('end', ended); input.off('error', failed);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      if (error) { value = ''; reject(error); } else accept(value);
    };
    const ended = () => finish(new Error('Migration passphrase input closed.'));
    const failed = () => finish(new Error('Migration passphrase input failed.'));
    const receive = (data: Buffer | string) => {
      for (const character of typeof data === 'string' ? data : decoder.write(data)) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003' || character === '\u0004') { finish(new Error('Migration cancelled.')); return; }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ' && character !== '\u001b') value += character;
        if (value.length > 1024) { finish(new Error('The migration passphrase is too long.')); return; }
      }
    };
    input.on('data', receive); input.once('end', ended); input.once('error', failed);
  });
}
