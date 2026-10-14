import { useState } from 'react';
import { CursorTranscriptSchema, type CoordinatorView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal } from './components.js';
import { TranscriptTurn } from './session-transcript.js';

export function SessionHistory({ entries, path }: { entries: CoordinatorView['sessionHistory']; path: string }) {
  const [transcript, setTranscript] = useState<ReturnType<typeof CursorTranscriptSchema.parse>>();
  const [error, setError] = useState('');
  if (!entries?.length) return null;
  return <details><summary>Earlier sessions ({entries.length})</summary>
    {entries.map(entry => <p key={entry.key}><a href={`${path}?session=${entry.key}`} onClick={event => {
      event.preventDefault(); setError(''); void api(`${path}?session=${entry.key}`, CursorTranscriptSchema).then(setTranscript).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The earlier transcript is unavailable.'));
    }}>{entry.runtime} {entry.model} · {new Date(entry.at).toLocaleString()}</a></p>)}
    {error && <p role="alert">{error}</p>}
    {transcript && <Modal title="Earlier session" close={() => setTranscript(undefined)}><div className="cursor-transcript">{transcript.turns.map((turn, index) => <TranscriptTurn key={index} turn={turn} userLabel="Prompt" collapseLongUser={3000} />)}</div></Modal>}
  </details>;
}
