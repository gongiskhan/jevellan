import { useState } from 'react';
import { CursorTranscriptSchema, EARLIER_TRANSCRIPT_UNAVAILABLE, TRANSCRIPT_PROMPT, HISTORY_PROMPT_COLLAPSE_CHARACTERS, type SessionHistoryView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal } from './components.js';
import { TranscriptTurn } from './session-transcript.js';

export function SessionHistory({ view }: { view?: SessionHistoryView | undefined }) {
  const [transcript, setTranscript] = useState<ReturnType<typeof CursorTranscriptSchema.parse>>();
  const [error, setError] = useState('');
  if (!view?.visible) return null;
  return <details><summary>{view.summary}</summary>
    {view.entries.map(entry => <p key={entry.key}><a href={entry.href} onClick={event => {
      event.preventDefault(); setError(''); void api(entry.href, CursorTranscriptSchema).then(setTranscript).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : EARLIER_TRANSCRIPT_UNAVAILABLE));
    }}>{entry.runtime} {entry.model} · {new Date(entry.at).toLocaleString()}</a></p>)}
    {error && <p role="alert">{error}</p>}
    {transcript && <Modal title={view.title} close={() => setTranscript(undefined)}><div className="cursor-transcript">{transcript.turns.map((turn, index) => <TranscriptTurn key={index} turn={turn} userLabel={TRANSCRIPT_PROMPT} collapseLongUser={HISTORY_PROMPT_COLLAPSE_CHARACTERS} />)}</div></Modal>}
  </details>;
}
