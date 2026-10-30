import { clockStamp } from './time.js';

/** The time at the end of a chat response: local HH:MM, full date on hover. */
export function ResponseTime({ at }: { at: string }) {
  const stamp = clockStamp(at);
  return stamp ? <p className="response-time"><time dateTime={at} title={stamp.title}>{stamp.label}</time></p> : null;
}
