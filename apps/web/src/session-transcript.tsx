import { Fragment, memo } from 'react';
import type { CursorTurn } from '@jevellan/core/client';
import { Markdown } from './components.js';
import { EvidenceLink } from './evidence.js';
import { transcriptGroups, toolAwaitingResult } from './transcript-groups.js';
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
export const TranscriptTurn = memo(function TranscriptTurn({ turn, onOpen, onOpenImage, userLabel, collapseLongUser, focus = false, active = false }: {
  focus?: boolean; active?: boolean; turn: CursorTurn; onOpen?(ref: string): void; onOpenImage?(ref: string): void; userLabel?: string | undefined; collapseLongUser?: number | undefined;
}) {
  const groups = transcriptGroups(turn.blocks);
  const blocks = groups.map((block, index) => {
    const current = active && turn.role === 'assistant' && index === groups.length - 1;
    if (block.type === 'thinking') return <details className="cursor-thinking" key={index} open><summary>Thinking</summary><Markdown {...(onOpen ? { onOpen } : {})} {...(onOpenImage ? { onOpenImage } : {})}>{block.text}</Markdown></details>;
    if (block.type === 'text') {
      const body = <Markdown {...(onOpen ? { onOpen } : {})} {...(onOpenImage ? { onOpenImage } : {})}>{block.text}</Markdown>;
      return focus ? <details className="cursor-text-block" key={index} open={current}><summary>{preview(block.text) || 'Message'}</summary>{body}</details> : <Fragment key={index}>{body}</Fragment>;
    }
    const running = current && toolAwaitingResult(block.calls.at(-1)!);
    const heading = <><span>{block.name}</span><span className="muted small-text">{block.calls.length > 1 ? `${block.calls.length} calls` : ''}{running ? ' · Waiting for result' : ''}</span></>;
    const calls = block.calls.map((call, callIndex) => {
      const body = <>
        <div className="cursor-tool-state muted small-text">{call.state === 'running' ? 'In progress' : call.state === 'unknown' ? 'Recorded' : call.state}</div>
        {call.input && <><div className="cursor-output-label">Input</div><pre><code>{call.input}</code></pre></>}
        {onOpen && toolFiles(call.input).map(path => <p className="tool-file" key={path}><EvidenceLink value={path} file open={onOpen} /></p>)}
        {call.output !== undefined && <><div className="cursor-output-label">Output</div><pre><code>{call.output || 'No text output.'}</code></pre></>}
        {call.output === undefined && <p className="muted small-text">{call.state === 'running' ? 'Waiting for the tool’s result…' : 'The saved transcript does not include this tool’s result.'}</p>}
      </>;
      return focus && block.calls.length > 1
        ? <details className="cursor-tool-call" key={call.id} open={running && callIndex === block.calls.length - 1}><summary>{block.name} · {callIndex + 1} · {call.state}</summary>{body}</details>
        : <div className="cursor-tool-call" key={call.id}>{body}</div>;
    });
    return focus
      ? <details className="cursor-tool" key={block.calls[0]!.id} aria-label={`${block.name} tool calls`} open={running}><summary className="cursor-tool-header">{heading}</summary>{calls}</details>
      : <section className="cursor-tool" key={block.calls[0]!.id} aria-label={`${block.name} tool calls`}><div className="cursor-tool-header">{heading}</div>{calls}</section>;
  });
  const text = turn.role === 'user' && collapseLongUser !== undefined ? userText(turn) : '';
  return <article className={`cursor-turn cursor-turn-${turn.role}`}>
    {turn.role === 'user' && <div className="cursor-turn-label">{turn.automated ? 'Automatic update' : userLabel ?? 'You'}</div>}
    {!focus && collapseLongUser !== undefined && text.length > collapseLongUser
      ? <details className="pw-prompt"><summary><span>{preview(text)}</span></summary>{blocks}</details>
      : blocks}
  </article>;
}, (previous, next) => previous.focus === next.focus && previous.active === next.active && previous.onOpen === next.onOpen && previous.onOpenImage === next.onOpenImage && previous.userLabel === next.userLabel && previous.collapseLongUser === next.collapseLongUser
  && JSON.stringify(previous.turn) === JSON.stringify(next.turn));
