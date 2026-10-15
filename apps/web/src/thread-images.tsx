import { useEffect, useRef, useState } from 'react';
import { ConversationFileSchema } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal } from './components.js';
import './thread-images.css';

const name = (ref: string) => ref.split('/').at(-1) ?? ref;
function ImageFile({ base, file, alt }: { base: string; file: string; alt: string }) {
  const [state, setState] = useState<{ file: string; url?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void api(`${base}/image?ref=${encodeURIComponent(file)}`, ConversationFileSchema, 'GET', undefined, { signal: controller.signal }).then(result => {
      if (result.kind !== 'image' || !result.mime) throw new Error('This file is not an image.');
      if (controller.signal.aborted) return;
      setState({ file, url: `data:${result.mime};base64,${result.content}` });
    }).catch(error => { if (!controller.signal.aborted) setState({ file, error: error instanceof Error ? error.message : 'Image unavailable.' }); });
    return () => controller.abort();
  }, [base, file]);
  if (state?.file !== file) return <span className="muted" role="status">Loading image…</span>;
  if (state.error) return <span className="thread-image-error" role="status">Image unavailable. {state.error}</span>;
  return <img src={state.url} alt={alt} draggable={false} />;
}
function Thumbnail({ base, file, open }: { base: string; file: string; open(ref: string): void }) {
  const ref = useRef<HTMLButtonElement>(null); const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: '100px' });
    if (ref.current) observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  return <button ref={ref} type="button" className="thread-image-thumb" aria-label={`Open image ${name(file)}`} title={file} onClick={() => open(file)}>
    <span className="thread-image-preview">{visible && <ImageFile base={base} file={file} alt={name(file)} />}</span><span>{name(file)}</span>
  </button>;
}
export function ThreadImageStrip({ base, files, open }: { base: string; files: readonly string[]; open(ref: string): void }) {
  if (!files.length) return null;
  return <div className="thread-image-strip" aria-label="Images from this entry">{files.slice(0, 4).map(file => <Thumbnail key={file} base={base} file={file} open={open} />)}
    {files.length > 4 && <button type="button" className="secondary" onClick={() => open(files[4]!)}>+{files.length - 4} images</button>}</div>;
}
export function ThreadImageGallery({ base, files, selected, select, close }: { base: string; files: readonly string[]; selected: string; select(ref: string): void; close(): void }) {
  const index = files.indexOf(selected); const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const move = (delta: number) => { const next = files[index + delta]; if (next) select(next); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return; event.preventDefault(); const next = files[index + (event.key === 'ArrowRight' ? 1 : -1)]; if (next) select(next); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [files, index, select]);
  return <Modal title="Session images" close={close}>
    <div className="thread-image-gallery">
      <div className="thread-image-navigation">
        <button type="button" className="secondary" aria-label="Previous image" disabled={index <= 0} onClick={() => move(-1)}>←</button>
        <span role="status">{index + 1} / {files.length}</span>
        <button type="button" className="secondary" aria-label="Next image" disabled={index >= files.length - 1} onClick={() => move(1)}>→</button>
      </div>
      <div className="thread-image-stage" onTouchStart={event => { if (event.touches.length !== 1) { start.current = undefined; return; } const touch = event.touches[0]!; start.current = { x: touch.clientX, y: touch.clientY }; }}
        onTouchEnd={event => { const touch = event.changedTouches[0], from = start.current; start.current = undefined; if (from && touch && Math.abs(touch.clientX - from.x) > 60 && Math.abs(touch.clientX - from.x) > Math.abs(touch.clientY - from.y) * 1.5) move(touch.clientX < from.x ? 1 : -1); }}>
        <ImageFile key={selected} base={base} file={selected} alt={name(selected)} />
      </div>
      <p className="thread-image-caption">{selected}</p>
      <p className="muted small-text">Swipe or use the arrows to browse. Images show the files currently saved in this thread’s worktree.</p>
    </div>
  </Modal>;
}
