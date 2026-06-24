import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { ReasoningState } from '../../../shared/responseView'
import {
  REASONING_CONTENT_SLOTS,
  extractReasoningTitle,
  extractTpInfo,
  formatTp,
  reasoningSkeleton
} from '../../../shared/reasoningView'

interface Props {
  /** Reasoning text so far (streams in while `state==='thinking'`). */
  reasoning: string
  /** The response body — used only to read a `<tp>` line; '' while still thinking. */
  body: string
  state: ReasoningState
  /** Card-authored HTML shell with {{slots}}; absent ⇒ the built-in native panel. */
  template?: string
  /** Card CSS (data.extensions.rp_terminal.css), scoped to the frame. */
  css?: string
}

// Mirrors MessageContent's static-frame base so a card's reasoning shell renders on the app's
// dark surface without each card re-declaring it.
const FRAGMENT_BASE = `
  :root { color-scheme: dark; }
  html, body { margin: 0; }
  body { color: #d8d8e0; background: transparent;
         font-family: 'Inter', system-ui, sans-serif; line-height: 1.5; }
`

/**
 * The reasoning UI that `<think>` folds into. With a card `template`, the reasoning streams into a
 * card-themed HTML shell rendered in an isolated same-origin (script-free) iframe; without one, it
 * falls back to the app's built-in collapsible panel. The SAME component renders the live
 * (streaming) and the settled view, so they look identical.
 */
export function ReasoningPanel({
  reasoning,
  body,
  state,
  template,
  css
}: Props): React.ReactElement {
  return template ? (
    <ReasoningFrame template={template} css={css} reasoning={reasoning} body={body} state={state} />
  ) : (
    // Built-in fallback — auto-open while the model is still thinking.
    <details className="reasoning-block" open={state === 'thinking'}>
      <summary className="reasoning-summary">💭 Reasoning</summary>
      <div className="reasoning-content">{reasoning}</div>
    </details>
  )
}

function ReasoningFrame({
  template,
  css,
  reasoning,
  body,
  state
}: Required<Pick<Props, 'template' | 'reasoning' | 'body' | 'state'>> & {
  css?: string
}): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(48)

  // Slot values. Title comes from the reasoning text; the tp line from the body (present once the
  // body starts streaming). Recomputed only when their inputs change, not every parent re-render.
  const values = useMemo<Record<string, string>>(() => {
    const title = extractReasoningTitle(reasoning)
    const tp = extractTpInfo(body)
    return {
      reasoning,
      title,
      tp: formatTp(tp),
      time: tp?.time ?? '',
      location: tp?.location ?? '',
      weather: tp?.weather ?? ''
    }
  }, [reasoning, body])
  // Latest values for the (out-of-render) load handler + resize observer to read.
  const valuesRef = useRef(values)

  // The document skeleton depends ONLY on template/css/state — NOT the streamed slot values — so it
  // isn't rebuilt (iframe reloaded) per token. Content slots are empty `<span>`s filled in place
  // below; a state transition (thinking→done) is the one thing that rebuilds it.
  const srcDoc = useMemo(() => {
    const skeleton = reasoningSkeleton(template, state)
    const clean = DOMPurify.sanitize(skeleton, {
      ADD_TAGS: ['style'],
      ADD_ATTR: ['data-rpt-slot', 'data-state', 'open', 'target'],
      FORBID_TAGS: ['script'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick']
    })
    return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAGMENT_BASE}${css || ''}</style></head><body>${clean}</body></html>`
  }, [template, css, state])

  // Paint streamed values into the iframe via textContent (never reparsed as HTML, so reasoning
  // content can't inject markup) and resync height. Runs in place — no reload — as tokens arrive.
  useEffect(() => {
    valuesRef.current = values
    const doc = ref.current?.contentDocument
    if (!doc) return
    for (const k of REASONING_CONTENT_SLOTS) {
      const el = doc.querySelector(`[data-rpt-slot="${k}"]`)
      if (el) el.textContent = values[k] || ''
    }
    if (doc.documentElement) setHeight(doc.documentElement.scrollHeight + 2)
  }, [values])

  // On (re)load — initial mount or a state-transition rebuild — repaint from the latest values and
  // keep height synced as the streamed text grows.
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    const repaint = (): void => {
      const doc = frame.contentDocument
      if (!doc) return
      for (const k of REASONING_CONTENT_SLOTS) {
        const el = doc.querySelector(`[data-rpt-slot="${k}"]`)
        if (el) el.textContent = valuesRef.current[k] || ''
      }
      if (doc.documentElement) setHeight(doc.documentElement.scrollHeight + 2)
    }
    const onLoad = (): void => {
      repaint()
      try {
        const b = frame.contentDocument?.body
        if (b && 'ResizeObserver' in window) {
          observer = new ResizeObserver(repaint)
          observer.observe(b)
        }
      } catch {
        /* cross-origin guard (shouldn't happen — same-origin) */
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
      className="reasoning-frame"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="reasoning"
    />
  )
}
