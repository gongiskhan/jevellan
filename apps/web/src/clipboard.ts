/**
 * Copies `text` from a button press. The Clipboard API exists only in secure contexts, and the app also runs on the optional
 * plain-HTTP Tailnet URL (client-id.ts), so a hidden field selected for `execCommand('copy')` covers that case (D304). False
 * when neither copied: the caller then selects the text on the page for the person to copy.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && typeof navigator.clipboard?.writeText === 'function') {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* Refused: the selection below may still copy. */ }
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true; field.tabIndex = -1; field.setAttribute('aria-hidden', 'true');
  // Fixed at the top so selecting it never scrolls the page; 16 px so iOS does not zoom in while it holds the selection.
  Object.assign(field.style, { position: 'fixed', top: '0', left: '-9999px', width: '1px', height: '1px', fontSize: '16px', opacity: '0' });
  document.body.append(field);
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch { return false; } finally {
    field.remove(); focused?.focus({ preventScroll: true });
  }
}

/** Selects an element's text on the page, so a person can copy it from the browser's own menu. */
export function selectText(element: Element): void {
  const range = document.createRange(); range.selectNodeContents(element);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
