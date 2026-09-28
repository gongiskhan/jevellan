import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Icon } from './icons.js';

export function MessageInput({ value, change, label, placeholder, inputRef }: {
  value: string; change(value: string): void; label: string; placeholder: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '0px';
      input.style.height = `${Math.max(44, Math.min(input.scrollHeight + 2, (window.visualViewport?.height ?? window.innerHeight) / 3))}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer.observe(input);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, [value, ref]);
  return <textarea ref={ref} rows={1} aria-label={label} value={value} placeholder={placeholder}
    onChange={event => change(event.target.value)}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.currentTarget.form?.requestSubmit();
      }
    }} />;
}

export function MessageDelivery({ running, canSteer = true, canSend = true, disabled, queue, cursor = false }: {
  running: boolean; canSteer?: boolean; canSend?: boolean; disabled: boolean; queue(): void; cursor?: boolean;
}) {
  const primary = running ? 'Steer' : 'Send';
  const unavailable = cursor ? 'Connection hooks and an active Cursor turn are needed. Use the session’s settings in the list.' : 'Message delivery is unavailable.';
  return <div className="message-actions">
    <button type="submit" className="send-icon" aria-label={primary}
      title={!(running ? canSteer : canSend) ? unavailable : running ? cursor ? 'Steer after the next tool call' : 'Steer current work' : 'Send message'}
      disabled={disabled || !(running ? canSteer : canSend)}><Icon name="send" size={20} /></button>
    <button type="button" className="queue-icon" aria-label="Queue message" onClick={queue}
      title={!canSend ? unavailable : running ? 'Queue for when current work finishes' : 'Queue is available while work is running'}
      disabled={disabled || !running || !canSend}><Icon name="queue" size={20} /></button>
  </div>;
}

export function LatestUserMessage({ text }: { text: string | undefined }) {
  return text ? <div className="latest-user-message" aria-label="Latest user message" title={text}>
    <Icon name="message" size={15} /><p>{text}</p>
  </div> : null;
}
