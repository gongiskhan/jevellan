import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { decodeReference, filePointer, remarkFilePaths } from './evidence-refs.js';
export default function Markdown({ children, onOpen }: { children: string; onOpen?(ref: string): void }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={onOpen ? [remarkGfm, remarkFilePaths] : [remarkGfm]}
        urlTransform={(value) => (onOpen && filePointer(value) ? value : defaultUrlTransform(value))}
        skipHtml
        components={{
          a: ({ href, children }) =>
            onOpen && href && !/^(?:https?:|mailto:|#)/i.test(href) ? (
              <button className="text-button evidence-link" onClick={() => onOpen(decodeReference(href))}>
                {children}
              </button>
            ) : (
              <a
                href={href}
                target={href?.startsWith('http') ? '_blank' : undefined}
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ),
          code: ({ children, className }) =>
            onOpen && !className && typeof children === 'string' && filePointer(children) ? (
              <button className="text-button evidence-link" onClick={() => onOpen(children)}>
                <code>{children}</code>
              </button>
            ) : (
              <code className={className}>{children}</code>
            ),
          img: ({ src, alt }) =>
            onOpen && src && !/^https?:/i.test(src) ? (
              <button className="text-button evidence-link" onClick={() => onOpen(decodeReference(src))}>
                {alt || src}
              </button>
            ) : (
              <img src={src} alt={alt} />
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
