import React, { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'

interface Props {
  content: string
  /** Optional card-level CSS (data.extensions.rp_terminal.css), scoped to the frame. */
  css?: string
  /** Right-click anywhere in the message (incl. inside the rendered card); gives viewport coords. */
  onContextMenu?: (x: number, y: number) => void
}

const HTML_FENCE = /```html\s*([\s\S]*?)```/gi

/**
 * Renders an AI message. SillyTavern-style beautification regex emits ```html
 * fenced documents; those segments are rendered as sanitized HTML inside a
 * sandboxed iframe (script-free, CSS fully isolated). Everything else renders as
 * GitHub-flavored markdown.
 */
export const MessageContent: React.FC<Props> = ({ content, css, onContextMenu }) => {
  const parts = useMemo(() => splitHtml(content), [content])
  return (
    <div
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              onContextMenu(e.clientX, e.clientY)
            }
          : undefined
      }
    >
      {parts.map((p, i) =>
        p.type === 'html' ? (
          <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
        ) : p.text.trim() ? (
          <Markdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </Markdown>
        ) : null
      )}
    </div>
  )
}

type Segment = { type: 'md' | 'html'; text: string }

const splitHtml = (content: string): Segment[] => {
  const segs: Segment[] = []
  const re = new RegExp(HTML_FENCE)
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segs.push({ type: 'md', text: content.slice(last, m.index) })
    segs.push({ type: 'html', text: m[1] })
    last = m.index + m[0].length
  }
  if (last < content.length) segs.push({ type: 'md', text: content.slice(last) })
  if (segs.length === 0) segs.push({ type: 'md', text: content })
  return segs
}

const FRAGMENT_BASE = `
  :root { color-scheme: dark; }
  body { margin: 0; color: #e0e0e0; background: transparent;
         font-family: 'Inter', system-ui, sans-serif; line-height: 1.5; }
  a { color: #5b8def; }
  img { max-width: 100%; }
`

const HtmlFrame: React.FC<{
  html: string
  css?: string
  onContextMenu?: (x: number, y: number) => void
}> = ({ html, css, onContextMenu }) => {
  const ref = useRef<HTMLIFrameElement>(null)
  const ctxRef = useRef(onContextMenu)
  ctxRef.current = onContextMenu
  const [height, setHeight] = useState(80)

  const srcDoc = useMemo(() => {
    const isFullDoc = /<!doctype|<html[\s>]/i.test(html)
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: isFullDoc,
      ADD_TAGS: ['style', 'link'],
      ADD_ATTR: ['target', 'rel', 'href'],
      FORBID_TAGS: ['script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick']
    })
    if (isFullDoc) return clean
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAGMENT_BASE}${css || ''}</style></head><body>${clean}</body></html>`
  }, [html, css])

  // Measure content height (same-origin sandbox, no scripts) and keep it synced
  // as images/fonts load via a ResizeObserver on the frame's document.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    const measure = (): void => {
      try {
        const doc = frame.contentDocument
        if (doc?.documentElement) setHeight(doc.documentElement.scrollHeight + 4)
      } catch {
        /* cross-origin guard */
      }
    }
    const onCtx = (e: Event): void => {
      e.preventDefault()
      const me = e as MouseEvent
      const rect = ref.current?.getBoundingClientRect()
      // Translate iframe-local coords into the parent viewport.
      ctxRef.current?.((rect?.left ?? 0) + me.clientX, (rect?.top ?? 0) + me.clientY)
    }
    const onLoad = (): void => {
      measure()
      try {
        const doc = frame.contentDocument
        const body = doc?.body
        if (body && 'ResizeObserver' in window) {
          observer = new ResizeObserver(measure)
          observer.observe(body)
        }
        // Right-click inside the (script-free, same-origin) card reaches us here.
        doc?.addEventListener('contextmenu', onCtx)
      } catch {
        /* ignore */
      }
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [srcDoc])

  return (
    <iframe
      ref={ref}
      className="card-frame"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="card content"
    />
  )
}
