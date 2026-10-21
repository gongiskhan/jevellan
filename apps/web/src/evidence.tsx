import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConversationFileSchema, ConversationEvidenceViewSchema, evidenceSourceSwitching, evidenceReference, relativeEvidenceReference, type ConversationEvidenceView, type EvidenceFilePresentation } from '@jevellan/core/client';
import { api } from './api.js';
import { Markdown, Panel } from './components.js';

export type EvidenceTarget = {
  ref: string;
  title?: string;
  stretch?: number | undefined;
  source?: 'step' | 'working-tree' | undefined;
  output?: boolean;
};
export function EvidenceLink({
  value,
  open,
  file = false,
}: {
  value: string;
  open(ref: string): void;
  file?: boolean;
}) {
  const reference = evidenceReference(value);
  if (reference.kind === 'url')
    return (
      <a href={value} target="_blank" rel="noopener noreferrer">
        {value}
      </a>
    );
  return file || reference.kind === 'pointer' || reference.kind === 'file' ? (
    <button className="text-button evidence-link" onClick={() => open(value)}>
      {value}
    </button>
  ) : (
    <code>{value}</code>
  );
}
type FileView = z.infer<typeof ConversationFileSchema>;
/**
 * Centers the selected line in the panel boxes that scroll it, and nothing outside them. `scrollIntoView` also scrolls the page:
 * with the panel beside a conversation, opening a source line moved the transcript up from its end, so Jump to latest came back
 * and a step's controls sat under the composer.
 */
function centerInPanel(line: HTMLElement) {
  for (let box = line.parentElement; box && box !== document.body; box = box.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(box).overflowY) || box.scrollHeight <= box.clientHeight) continue;
    const at = line.getBoundingClientRect();
    const port = box.getBoundingClientRect();
    box.scrollTop += at.top + at.height / 2 - (port.top + box.clientTop + box.clientHeight / 2);
  }
}
function FileContent({ value, presentation, open }: { value: FileView; presentation: EvidenceFilePresentation; open(ref: string): void }) {
  const highlighted = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState(presentation.initialSource);
  useEffect(() => {
    if (highlighted.current) centerInPanel(highlighted.current);
  }, [value]);
  const relativeLink = (ref: string) => open(relativeEvidenceReference(presentation.linkBase, ref));
  return (
    <>
      <p className="muted small-text">
        {presentation.sourceLabel}
        {value.commit && (
          <>
            {' '}
            · <code>{value.commit}</code>
          </>
        )}
      </p>
      {value.kind === 'image' ? (
        <img className="evidence-image" src={`data:${value.mime};base64,${value.content}`} alt={value.path} />
      ) : (
        <>
          {value.kind === 'markdown' && (
            <button className="text-button" onClick={() => setSource(!source)}>
              {source ? 'Rendered Markdown' : 'Show source'}
            </button>
          )}
          {value.kind === 'markdown' && !source ? (
            <Markdown onOpen={relativeLink}>{value.content}</Markdown>
          ) : (
            <pre className="file-code" aria-label="File contents">
              {value.content.split('\n').map((line, index) => (
                <span
                  className={`file-line${index + 1 === value.line ? ' selected-line' : ''}`}
                  key={index}
                  ref={index + 1 === value.line ? highlighted : undefined}
                >
                  <span className="line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <code>{line || ' '}</code>
                </span>
              ))}
            </pre>
          )}
        </>
      )}
    </>
  );
}
export function EvidencePanel({ id, target, close }: { id: string; target: EvidenceTarget; close(): void }) {
  const [current, setCurrent] = useState(target);
  const [evidence, setEvidence] = useState<ConversationEvidenceView>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setEvidence(undefined);
    setError('');
    const load = async () => {
      try {
        const value = await api(`/api/conversations/${id}/evidence-read`, ConversationEvidenceViewSchema, 'POST', {
          schema: 'conversation-evidence-request-v1', ref: current.ref, stretch: current.stretch, source: current.source ?? 'step', output: current.output ?? false,
        });
        if (active) setEvidence(value);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Evidence could not be opened.');
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [id, current]);
  const switching = evidence?.switching ?? evidenceSourceSwitching(current.ref, current.stretch, current.source);
  const open = (ref: string) => setCurrent({ ...current, ref, title: ref, output: false });
  return (
    <Panel title={current.title ?? current.ref} eyebrow={current.stretch ? `step ${current.stretch}` : undefined} close={close}>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : evidence?.view.kind === 'file' ? (
        <FileContent key={evidence.view.file.path} value={evidence.view.file} presentation={evidence.view.presentation} open={open} />
      ) : evidence ? (
        evidence.view.kind === 'markdown' ? <Markdown onOpen={open}>{evidence.view.text}</Markdown> : <pre className="evidence-output">{evidence.view.text}</pre>
      ) : (
        <p role="status">Loading evidence…</p>
      )}
      {switching && (
        <div className="actions">
          <button
            className="text-button"
            disabled={switching.workingDisabled}
            onClick={() => setCurrent({ ...current, source: 'working-tree' })}
          >
            {switching.workingLabel}
          </button>
          <button
            className="text-button"
            disabled={switching.recordedDisabled}
            onClick={() => setCurrent({ ...current, source: 'step' })}
          >
            {switching.recordedLabel}
          </button>
        </div>
      )}
    </Panel>
  );
}
