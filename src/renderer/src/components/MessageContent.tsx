import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { isInteractiveHtml } from '../plugin/bridgeShim'
import { extractStyleBlocks, scopeCss, scopeClassFor } from './messageHtmlScope'
import { WcvMessageFrame } from './WcvMessageFrame'
import { InlineCardFrame } from './InlineCardFrame'
import { useSettingsStore } from '../stores/settingsStore'
import {
  resolveCardMode,
  DEFAULT_CARD_RENDER_MODE,
  DEFAULT_CARD_SIZING
} from '../../../shared/cardRenderMode'
import type { CardRenderMode } from '../../../shared/cardRenderMode'

interface Props {
  content: string
  /** Optional card-level CSS (data.extensions.rp_terminal.css), scoped to the frame. */
  css?: string
  /** Right-click anywhere in the message (incl. inside the rendered card); gives viewport coords. */
  onContextMenu?: (x: number, y: number) => void
}

// An HTML block is a ```html fence, a plain ``` fence whose payload is a full <html>/<body>
// frontend card, or a bare <html>/<body> block emitted without a code fence.
const HTML_BLOCK =
  /```html\s*([\s\S]*?)```|```\s*((?:<!doctype\s+html[^>]*>\s*)?<(?:html|body)[\s\S]*?<\/(?:html|body)>)\s*```|(<(?:html|body)[\s\S]*?<\/(?:html|body)>)/gi

/**
 * Renders an AI message. SillyTavern-style beautification regex emits ```html
 * fenced documents (or bare <body>/<html> frontend cards); those segments are
 * rendered inside a sandboxed iframe — interactive (scripted) when they carry a
 * <script>, otherwise sanitized + script-free. Everything else renders as
 * GitHub-flavored markdown.
 */
export const MessageContent: React.FC<Props> = ({ content, css, onContextMenu }) => {
  const parts = useMemo(() => splitHtml(content), [content])
  const globalMode =
    useSettingsStore((s) => s.settings?.cards?.renderMode) ?? DEFAULT_CARD_RENDER_MODE
  const globalSizing = useSettingsStore((s) => s.settings?.cards?.sizing) ?? DEFAULT_CARD_SIZING
  return (
    <div
      className="message-content"
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
          // A scripted html block is the card's regex-injected "frontend card" — run it as-is in an
          // isolated WebContentsView where the preload shim is the TavernHelper compat layer, so the
          // card's own code does its (possibly nested) loading. Script-free html stays a light, static,
          // sanitized inline frame.
          isInteractiveHtml(p.text) ? (
            resolveCardMode(p.mode, globalMode) === 'isolated' ? (
              <WcvMessageFrame key={i} html={p.text} sizing={globalSizing} />
            ) : (
              <InlineCardFrame
                key={i}
                html={p.text}
                sizing={globalSizing}
                onContextMenu={onContextMenu}
              />
            )
          ) : (
            <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
          )
        ) : p.type === 'inline-html' ? (
          <InlineHtml key={i} html={p.text} />
        ) : p.text.trim() ? (
          <Markdown key={i} remarkPlugins={[remarkGfm]}>
            {p.text}
          </Markdown>
        ) : null
      )}
    </div>
  )
}

// 'inline-html' is a lightweight, script-free HTML block (an item/status card `<div>`, a table, …)
// rendered INLINE in the message DOM (sanitized, no iframe); 'html' is a full-document or scripted
// block that runs in an isolated frame.
type Segment = { type: 'md' | 'html' | 'inline-html'; text: string; mode?: CardRenderMode }

// A render-mode marker the regex applier emits before a card block (see regexStore.apply). It is NOT
// necessarily flush against the block: the card payload is often wrapped in a ``` code fence, so the
// marker can be followed by the opening fence (e.g. `<!--rpt:mode=isolated-->```\n<body>…`). So match
// the marker anywhere in the md before the block — NOT anchored to the end — and strip it in place.
const MODE_MARKER = /<!--\s*rpt:mode=(inline|isolated)\s*-->/i

// Bare top-level HTML the model may emit inline — an item/status card as a `<div>`, a `<table>`,
// etc. NOT wrapped in <body>/<html> or a ```html fence. A conservative allowlist of structural
// elements so we never hijack body state tags (<tp>/<gametxt>/<UpdateVariable>) or content
// react-markdown already renders from markdown syntax (lists/tables). These lift anywhere.
const BARE_HTML_STRUCTURAL_TAGS =
  'div|section|article|aside|header|footer|main|nav|figure|details|table|center|form'
// Phrasing markup (a styled `<span>`, a `<ruby>` annotation) also lifts, but ONLY when the region
// stands alone on its own line: spans occur constantly inside prose and markdown constructs, and
// lifting one mid-line would split the sentence — or the surrounding GFM list — into separate
// blocks. (`<rt>`/`<rp>` need no entry: matchBareElement matches the balanced outer <ruby> whole.)
const BARE_HTML_PHRASING_TAGS = 'span|ruby'
const BARE_HTML_TAGS = `${BARE_HTML_STRUCTURAL_TAGS}|${BARE_HTML_PHRASING_TAGS}`
const PHRASING_START_RE = new RegExp(`^<(?:${BARE_HTML_PHRASING_TAGS})\\b`, 'i')
// A region STARTS at a container or a `<style>` sheet; a `<script>` only joins as a SIBLING (a lone
// bare `<script>` stays markdown rather than auto-running). Used to find + extend an HTML region.
const REGION_START_RE = new RegExp(`<(?:${BARE_HTML_TAGS}|style)\\b`, 'i')
const REGION_NEXT_RE = new RegExp(`<(?:${BARE_HTML_TAGS}|style|script)\\b`, 'i')

/**
 * The index just past the balanced close of the HTML element whose opening `<tag…>` starts at
 * `start`, or -1 if it never closes (so the caller falls back to treating the rest as markdown).
 * Counts nested opens of the SAME tag so a card's inner `<div>`s don't end the block early.
 * Pragmatic (not a full HTML parser): attribute values containing `>` would confuse it, but the
 * presentational cards we target don't use them.
 */
const matchBareElement = (text: string, start: number): number => {
  const open = /^<([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/.exec(text.slice(start))
  if (!open) return -1
  if (open[2] === '/') return start + open[0].length // self-closed: <div/>
  const tag = open[1]
  const openEnd = start + open[0].length
  const re = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, 'gi')
  re.lastIndex = openEnd
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0][1] === '/') {
      if (--depth === 0) return m.index + m[0].length
    } else if (m[1] !== '/') {
      depth++ // a nested NON-self-closed open of the same tag
    }
  }
  return -1
}

// End of one HTML element at `start`: a `<style>`/`<script>` block (to its raw close tag — CSS/JS
// content isn't parsed) or a balanced container element.
const matchHtmlElement = (text: string, start: number): number => {
  const tagM = /^<([a-zA-Z][\w-]*)\b/.exec(text.slice(start))
  if (!tagM) return -1
  const tag = tagM[1].toLowerCase()
  if (tag === 'style' || tag === 'script') {
    const cm = new RegExp(`</${tag}\\s*>`, 'i').exec(text.slice(start))
    return cm ? start + cm.index + cm[0].length : -1
  }
  return matchBareElement(text, start)
}

// Split a markdown segment around any bare top-level HTML regions. A "region" is a run of adjacent
// (whitespace-separated) HTML elements + `<style>`/`<script>` blocks — so a card and its SIBLING
// `<style>` sheet (the common `<div>…</div><style>…</style>` shape) stay together. The prose around
// a region stays markdown; the region renders inline ('inline-html', styles scoped to the card)
// unless it carries a `<script>` (which needs the isolated, sandboxed frame → 'html').
// True when only whitespace sits between the region [start, end) and its line boundaries.
const standsAloneOnLine = (md: string, start: number, end: number): boolean => {
  const lineStart = md.lastIndexOf('\n', start - 1) + 1
  const lineEnd = md.indexOf('\n', end)
  return (
    /^\s*$/.test(md.slice(lineStart, start)) &&
    /^\s*$/.test(md.slice(end, lineEnd === -1 ? md.length : lineEnd))
  )
}

const splitBareHtml = (md: string): Segment[] => {
  const out: Segment[] = []
  let i = 0 // start of the not-yet-emitted markdown
  let scan = 0 // search cursor — moves past rejected phrasing candidates; `i` does not
  for (;;) {
    const m = REGION_START_RE.exec(md.slice(scan))
    if (!m) break
    const start = scan + m.index
    let end = matchHtmlElement(md, start)
    if (end < 0) break // unclosed: the rest stays markdown
    // Absorb following sibling HTML/style/script blocks (only whitespace between) into the region.
    for (;;) {
      const ws = /^\s*/.exec(md.slice(end))?.[0].length ?? 0
      const next = REGION_NEXT_RE.exec(md.slice(end + ws))
      if (!next || next.index !== 0) break
      const ne = matchHtmlElement(md, end + ws)
      if (ne < 0) break
      end = ne
    }
    // A phrasing region embedded in a line of prose (or a list item / table row) stays markdown.
    if (PHRASING_START_RE.test(md.slice(start)) && !standsAloneOnLine(md, start, end)) {
      scan = start + 1
      continue
    }
    if (start > i) out.push({ type: 'md', text: md.slice(i, start) })
    // Bare regions ALWAYS render inline (CSS scoped, body DOMPurify-sanitized). A stray <script> here
    // is stripped, NOT executed — unfenced model output must never auto-run with app/bridge access.
    // An authored frontend card opts into the sandboxed scripted frame via a ```html fence or <body>
    // (matched by HTML_BLOCK above), so those still reach the frame; only bare HTML changed.
    out.push({ type: 'inline-html', text: md.slice(start, end) })
    i = end
    scan = end
  }
  const tail = md.slice(i)
  if (tail) out.push({ type: 'md', text: tail })
  return out.length ? out : [{ type: 'md', text: md }]
}

export const splitHtml = (content: string): Segment[] => {
  const segs: Segment[] = []
  const re = new RegExp(HTML_BLOCK)
  let last = 0
  let m: RegExpExecArray | null
  let pendingMode: CardRenderMode | undefined
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      let md = content.slice(last, m.index)
      const mk = md.match(MODE_MARKER)
      if (mk) {
        pendingMode = mk[1].toLowerCase() as CardRenderMode
        // Strip the marker in place (it may sit before a code fence, not at the end of the md).
        const at = mk.index ?? 0
        md = md.slice(0, at) + md.slice(at + mk[0].length)
      }
      // Push the md text only if non-empty: a segment that was ONLY a mode marker becomes '' after
      // stripping, so we skip it (the marker must never render as text).
      if (md) segs.push({ type: 'md', text: md })
    }
    segs.push({
      type: 'html',
      text: m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3],
      mode: pendingMode
    })
    pendingMode = undefined
    last = m.index + m[0].length
  }
  if (last < content.length) segs.push({ type: 'md', text: content.slice(last) })
  if (segs.length === 0) segs.push({ type: 'md', text: content })
  // Second pass: lift bare top-level HTML blocks out of the markdown segments (the <body>/<html>/
  // ```html blocks were already extracted above and aren't re-scanned). Mode markers only precede
  // the model's own frontend cards, so these inline blocks default to inline mode.
  return segs.flatMap((s) => (s.type === 'md' ? splitBareHtml(s.text) : [s]))
}

const FRAGMENT_BASE = `
  :root { color-scheme: dark; }
  body { margin: 0; color: #e0e0e0; background: transparent;
         font-family: 'Inter', system-ui, sans-serif; line-height: 1.5; }
  a { color: #5b8def; }
  img { max-width: 100%; }
`

// Tags barred from the card body. Scripts + event handlers + javascript: URLs are stripped by
// DOMPurify's defaults; we also bar embedders, `<form>` (submission/phishing), and `<base>`/`<meta>`/
// `<link>`. `<style>` is extracted + scoped BEFORE sanitizing (so it's gone from the body here).
// `<input>`/`<label>`/`<button>` are deliberately allowed — CSS-`:checked` cards need them, and
// without scripts/`<form>` they're inert. Scripted cards never reach here (routed to a frame).
const INLINE_HTML_FORBID_TAGS = [
  'style',
  'link',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'form'
]

/**
 * Render a model-authored card INLINE in the message DOM (no iframe) so it blends with the prose.
 * Any `<style>` is lifted out and scoped to this card's unique container class (selector-prefixing,
 * `@import` stripped — see messageHtmlScope) so its CSS can't leak into the app UI; the body is
 * DOMPurify-sanitized. `<style>` (React child, not innerHTML) keeps a stray `</style>` in CSS text
 * from breaking out. CSS-`:checked` interactivity (a `<label>` toggling a `<checkbox>`) works
 * natively. Inline-only trade-off: model HTML lives in the app document (per the deferred-hardening
 * stance) — scripts/handlers are still stripped.
 */
const InlineHtml: React.FC<{ html: string }> = ({ html }) => {
  const scope = scopeClassFor(useId())
  const { body, css } = useMemo(() => {
    const { html: bodyHtml, css: rawCss } = extractStyleBlocks(html)
    return {
      // No ADD_TAGS/ADD_ATTR loosening needed for presentational markup: DOMPurify's defaults
      // already allow phrasing tags (<span>/<ruby>/<rt>/<rp>) and the style attribute.
      body: DOMPurify.sanitize(bodyHtml, {
        FORBID_TAGS: INLINE_HTML_FORBID_TAGS,
        ADD_ATTR: ['target']
      }),
      css: scopeCss(rawCss, scope)
    }
  }, [html, scope])
  return (
    <div className={`inline-html ${scope}`}>
      {css ? <style>{css}</style> : null}
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  )
}

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
