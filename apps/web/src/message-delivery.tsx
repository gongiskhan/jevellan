export function MessageDelivery({ mode, change, running, canSteer = true, canSend = true, disabled = false, cursor = false }: {
  mode: 'steer' | 'next'; change(mode: 'steer' | 'next'): void; running: boolean;
  canSteer?: boolean; canSend?: boolean; disabled?: boolean; cursor?: boolean;
}) {
  return <label className="message-delivery">
    <span className="sr-only">Message delivery</span>
    <select aria-label="Message delivery" value={mode} onChange={event => change(event.target.value as 'steer' | 'next')} disabled={disabled}>
      <option value="next" disabled={!canSend}>{running ? 'Send after this step' : 'Send message'}</option>
      <option value="steer" disabled={!running || !canSteer}>Steer current work</option>
    </select>
    <span className="muted small-text">
      {mode === 'steer'
        ? cursor ? 'Delivered after Cursor’s next tool call.' : 'Interrupts this step and continues with your correction.'
        : running ? cursor ? 'Starts a new turn when Cursor finishes.' : 'Added to the next step without interrupting.' : 'Continue this conversation.'}
    </span>
  </label>;
}
