import { memo } from 'react';
import type { CursorTurn } from '@jevellan/core/client';
import { Markdown } from './components.js';
import { EvidenceLink } from './evidence.js';
import './cursor-sessions.css';

function toolFiles(input: string) {
  try { const value: unknown = JSON.parse(input); if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>; return [...new Set([row.path, row.file_path, row.filePath].filter((item): item is string => typeof item === 'string'))];
  } catch { return []; }
}
const userText = (turn: CursorTurn) => turn.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
const preview = (text: string) => { const line = text.trim().split('\n')[0]!.trim(); return line.length > 160 ? `${line.slice(0, 159)}…` : line; };

/**
 * One native transcript turn. `userLabel` replaces `You` on prompts that are not automated (thread transcripts say
 * `Prompt`), and `collapseLongUser` folds user turns longer than that many characters behind their first line. Without
 * them the output is the conversation and session rendering.
 */
export const TranscriptTurn = memo(function TranscriptTurn({ turn, onOpen, userLabel, collapseLongUser }: {
  turn: CursorTurn; onOpen?(ref: string): void; userLabel?: string | undefined; collapseLongUser?: number | undefined;
}) {
  const blocks = turn.blocks.map((block, index) => block.type === 'text'
    ? <Markdown key={index} {...(onOpen ? { onOpen } : {})}>{block.text}</Markdown>
    : block.type === 'thinking'
      ? <details className="cursor-thinking" key={index} open><summary>Thinking</summary><Markdown {...(onOpen ? { onOpen } : {})}>{block.text}</Markdown></details>
      : <details className="cursor-tool" key={block.id}>
        <summary><span>{block.name}</span><span className="muted small-text">{block.state === 'running' ? 'In progress' : block.state === 'unknown' ? 'Recorded' : block.state}</span></summary>
        {block.input && <><div className="cursor-output-label">Input</div><pre><code>{block.input}</code></pre></>}
        {onOpen && toolFiles(block.input).map(path => <p className="tool-file" key={path}><EvidenceLink value={path} file open={onOpen} /></p>)}
        {block.output !== undefined && <><div className="cursor-output-label">Output</div><pre><code>{block.output || 'No text output.'}</code></pre></>}
        {block.output === undefined && <p className="muted small-text">{block.state === 'running' ? 'Waiting for the tool’s result…' : 'The saved transcript does not include this tool’s result.'}</p>}
      </details>);
  const text = turn.role === 'user' && collapseLongUser !== undefined ? userText(turn) : '';
  return <article className={`cursor-turn cursor-turn-${turn.role}`}>
    {turn.role === 'user' && <div className="cursor-turn-label">{turn.automated ? 'Automatic update' : userLabel ?? 'You'}</div>}
    {collapseLongUser !== undefined && text.length > collapseLongUser
      ? <details className="pw-prompt"><summary><span>{preview(text)}</span></summary>{blocks}</details>
      : blocks}
  </article>;
}, (previous, next) => previous.onOpen === next.onOpen && previous.userLabel === next.userLabel && previous.collapseLongUser === next.collapseLongUser
  && JSON.stringify(previous.turn) === JSON.stringify(next.turn));
