import { LibraryMessage } from './project-library.js';
import { Fragment, memo } from 'react';
import type { CursorTurn, PreparedTranscriptGroup } from '@jevellan/core/client';
import { Markdown } from './components.js';
import { EvidenceLink } from './evidence.js';
import { ResponseTime } from './response-time.js';
import { prepareTranscriptGroups, transcriptTurnPresentation } from '@jevellan/core/client';
import './cursor-sessions.css';

/**
 * One native transcript turn. `userLabel` replaces `You` on prompts that are not automated (thread transcripts say
 * `Prompt`), and `collapseLongUser` folds user turns longer than that many characters behind their first line. Without
 * them the output is the conversation and session rendering.
 */
export const TranscriptTurn = memo(function TranscriptTurn({ projectId, turn, onOpen, onOpenImage, userLabel, collapseLongUser, focus = false, active = false, prepared }: {
  prepared?: PreparedTranscriptGroup[] | undefined; projectId?: string | undefined; focus?: boolean; active?: boolean; turn: CursorTurn; onOpen?(ref: string): void; onOpenImage?(ref: string): void; userLabel?: string | undefined; collapseLongUser?: number | undefined;
}) {
  const groups = prepared ?? prepareTranscriptGroups(turn, active);
  const presentation = turn.presentation ?? transcriptTurnPresentation(turn, { active, focus, userLabel, collapseLongUser }, groups);
  const blocks = groups.map((block, index) => {
    const current = block.active, display = presentation.groups[index]!;
    if (block.type === 'thinking') return <details className="cursor-thinking" key={index} open><summary>Thinking</summary><Markdown {...(onOpen ? { onOpen } : {})} {...(onOpenImage ? { onOpenImage } : {})}>{block.text}</Markdown></details>;
    if (block.type === 'text') {
      const body = projectId && turn.role === 'user' ? <LibraryMessage projectId={projectId} text={block.text} /> : <Markdown {...(onOpen ? { onOpen } : {})} {...(onOpenImage ? { onOpenImage } : {})}>{block.text}</Markdown>;
      return focus ? <details className="cursor-text-block" key={index} open={current}><summary>{display.preview}</summary>{body}</details> : <Fragment key={index}>{body}</Fragment>;
    }
    const running = block.awaitingResult;
    const heading = <><span>{block.name}</span><span className="muted small-text">{display.countLabel}{display.waitingSuffix}</span></>;
    const calls = block.calls.map((call, callIndex) => {
      const body = <>
        <div className="cursor-tool-state muted small-text">{display.calls[callIndex]!.stateLabel}</div>
        {call.input && <><div className="cursor-output-label">Input</div><pre><code>{call.input}</code></pre></>}
        {onOpen && display.calls[callIndex]!.files.map(path => <p className="tool-file" key={path}><EvidenceLink value={path} file open={onOpen} /></p>)}
        {call.output !== undefined && <><div className="cursor-output-label">Output</div><pre><code>{call.output || 'No text output.'}</code></pre></>}
        {call.output === undefined && <p className="muted small-text">{display.calls[callIndex]!.noResultText}</p>}
      </>;
      return focus && block.calls.length > 1
        ? <details className="cursor-tool-call" key={call.id} open={running && callIndex === block.calls.length - 1}><summary>{block.name} · {callIndex + 1} · {call.state}</summary>{body}</details>
        : <div className="cursor-tool-call" key={call.id}>{body}</div>;
    });
    return focus
      ? <details className="cursor-tool" key={block.calls[0]!.id} aria-label={`${block.name} tool calls`} open={running}><summary className="cursor-tool-header">{heading}</summary>{calls}</details>
      : <section className="cursor-tool" key={block.calls[0]!.id} aria-label={`${block.name} tool calls`}><div className="cursor-tool-header">{heading}</div>{calls}</section>;
  });
  return <article className={`cursor-turn cursor-turn-${turn.role}`}>
    {presentation.label !== null && <div className="cursor-turn-label">{presentation.label}</div>}
    {presentation.collapsed
      ? <details className="pw-prompt"><summary><span>{presentation.preview}</span></summary>{blocks}</details>
      : blocks}
    {turn.role === 'assistant' && turn.at && groups.some(block => block.type === 'text') && <ResponseTime at={turn.at} />}
  </article>;
}, (previous, next) => previous.projectId === next.projectId && previous.focus === next.focus && previous.active === next.active && previous.onOpen === next.onOpen && previous.onOpenImage === next.onOpenImage && previous.userLabel === next.userLabel && previous.collapseLongUser === next.collapseLongUser
  && JSON.stringify(previous.prepared) === JSON.stringify(next.prepared) && JSON.stringify(previous.turn) === JSON.stringify(next.turn));
