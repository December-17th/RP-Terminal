import React, { useEffect, useId, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { isInteractiveHtml } from '../plugin/bridgeShim'
import { extractStyleBlocks, scopeCss, scopeClassFor } from './messageHtmlScope'
import { WcvMessageFrame } from './WcvMessageFrame'
import { InlineCardFrame } from './InlineCardFrame'
import { HtmlFrame } from './HtmlFrame'
import { useSettingsStore } from '../stores/settingsStore'
import { useProfileStore } from '../stores/profileStore'
import { useCharacterStore } from '../stores/characterStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { resolveScriptedHtmlRoute } from './messageCardRouting'
import { DEFAULT_CARD_RENDER_MODE, DEFAULT_CARD_SIZING } from '../../../shared/cardRenderMode'
import type { CardRenderMode } from '../../../shared/cardRenderMode'
import type { CardChatScope } from '../../../shared/thRuntime/types'
import { useT } from '../i18n'

interface Props {
  content: string
  /** Optional card-level CSS (data.extensions.rp_terminal.css), scoped to the frame. */
  css?: string
  /** Right-click anywhere in the message (incl. inside the rendered card); gives viewport coords. */
  onContextMenu?: (x: number, y: number) => void
  /**
   * True while the owning message is still streaming. Scripted/interactive HTML cards are held behind a
   * lightweight placeholder until the message settles: mounting them mid-stream would run the card
   * `<script>` (host writes / network side effects), and `FloorBlock` re-runs it at settle → double
   * execution. Static (script-free) HTML cards, inline HTML, and markdown still render live. See
   * StreamingView.
   */
  streaming?: boolean
  /**
   * Panel chat scope (general entry point): when a scripted card here is rendered inside a UI panel whose
   * content IS its chat (the plot panel; future reasoning/agent panels), pass the panel's messages as the
   * scope. Forwarded to the scripted-card frames (inline + WCV) so the card's chat reads reflect these
   * messages instead of the real chat (chat-READ-only). The static HtmlFrame path ignores it (no runtime).
   */
  chatScope?: CardChatScope
}

// An HTML block is a ```html fence, a plain ``` fence whose payload is a full <html>/<body>
// frontend card, or a bare <html>/<body> block emitted without a code fence.
//
// The FIRST alternative closes a ```html fence at the document's `</html>` (not the first stray ```),
// so a full-document card whose body embeds a ``` fence stays whole. This is load-bearing for the
// plot-recall panel: the plot beautifier drops the turn input — which routinely carries a ```text
// fence — into a <textarea> inside a full ```html document. A lazy close ended the block at that
// inner ```, halving the card (the "full-screen black scene" bug — see messageContent.test.ts). A
// ```html FRAGMENT (no </html>) has no such anchor and falls through to the lazy second alternative.
const HTML_BLOCK =
  /```html\s*([\s\S]*?<\/html>)\s*```|```html\s*([\s\S]*?)```|```\s*((?:<!doctype\s+html[^>]*>\s*)?<(?:html|body)[\s\S]*?<\/(?:html|body)>)\s*```|(<(?:html|body)[\s\S]*?<\/(?:html|body)>)/gi

/**
 * Renders an AI message. SillyTavern-style beautification regex emits ```html
 * fenced documents (or bare <body>/<html> frontend cards); those segments are
 * rendered inside a sandboxed iframe — interactive (scripted) when they carry a
 * <script>, otherwise sanitized + script-free. Everything else renders as
 * GitHub-flavored markdown.
 */
export const MessageContent: React.FC<Props> = ({
  content,
  css,
  onContextMenu,
  streaming,
  chatScope
}) => {
  const t = useT()
  const parts = useMemo(() => splitHtml(content), [content])
  const globalMode =
    useSettingsStore((s) => s.settings?.cards?.renderMode) ?? DEFAULT_CARD_RENDER_MODE
  const globalSizing = useSettingsStore((s) => s.settings?.cards?.sizing) ?? DEFAULT_CARD_SIZING

  // Trust provenance = the chat's active character card. Scripted HTML executes only under that
  // card's persisted grants, NOT the render-mode setting alone (card-trust-boundary issue 01).
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? '')
  const cardId = useCharacterStore((s) => s.activeCharacter?.id ?? '')
  const trusted = useCardScriptsStore((s) => (cardId ? s.trustedByCard[cardId] : undefined))
  const decided = useCardScriptsStore((s) => (cardId ? s.decidedByCard[cardId] : undefined))

  // Cold fallback: a chat opened before any script host mounted has no grants in the store yet, so
  // `decided` is undefined and the router fails CLOSED (WCV). Read the persisted grants once and
  // seed the store so a trusted card resolves to inline (and a denied one to static). `decided`
  // being undefined for the active card is the "not yet resolved" signal.
  useEffect(() => {
    if (!profileId || !cardId) return
    if (useCardScriptsStore.getState().decidedByCard[cardId] !== undefined) return
    let alive = true
    window.api.pluginGetGrants(profileId, cardId).then((g) => {
      if (!alive) return
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      useCardScriptsStore.getState().seedTrust(cardId, g?.trusted === true)
      useCardScriptsStore.getState().seedDecided(cardId, g?.decided === true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

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
          // A scripted html block is the card's regex-injected "frontend card". Routing is
          // trust-gated: only a card the user TRUSTED runs same-origin (InlineCardFrame, reaches
          // window.parent.api). An undecided card is forced into the process-isolated WCV; a denied
          // card — or scripted HTML with no active card (bare model output) — renders static +
          // sanitized. Script-free html always stays the static inline frame. (issue 01)
          isInteractiveHtml(p.text) ? (
            // While streaming, hold a scripted card behind a placeholder: mounting the frame now would
            // run its <script> mid-stream, and FloorBlock re-runs it at settle → double execution with
            // side effects. It materializes once, when the settled floor renders (no `streaming` prop).
            streaming ? (
              <em key={i} className="generating-pulse streaming-card-pending">
                {t('chat.streamingCard')}
              </em>
            ) : (
              (() => {
                const route = resolveScriptedHtmlRoute({
                  hasCard: !!cardId,
                  trusted,
                  decided,
                  mode: p.mode,
                  globalMode
                })
                return route === 'inline' ? (
                  <InlineCardFrame
                    key={i}
                    html={p.text}
                    sizing={globalSizing}
                    trusted
                    chatScope={chatScope}
                    onContextMenu={onContextMenu}
                  />
                ) : route === 'isolated' ? (
                  <WcvMessageFrame key={i} html={p.text} sizing={globalSizing} chatScope={chatScope} />
                ) : (
                  <HtmlFrame key={i} html={p.text} css={css} onContextMenu={onContextMenu} />
                )
              })()
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

// Standard HTML/SVG/MathML element names. A tag whose name is NOT here is a custom "body-state"
// wrapper the card emitted but no display regex handled (e.g. <gametxt>, <scene_info>, <tp>). Since
// this markdown path carries no rehype-raw, react-markdown ESCAPES such a tag into visible text
// (`&lt;gametxt&gt;`); we instead drop the tag token and keep its children — mirroring how a browser
// (and SillyTavern's renderer) show an unknown element: invisibly, rendering only its contents.
// Known tags are left untouched (unchanged escaped-or-lifted behavior), so ONLY genuinely-unknown
// tags change. SVG/MathML names are included so bare graphics markup isn't mangled — leaving it as-is
// is no worse than today. (Card <script>/<style>-bearing frontend cards never reach here: they were
// lifted to a frame / inline-html region by HTML_BLOCK + splitBareHtml above.)
const KNOWN_HTML_TAGS = new Set<string>(
  `html head body base link meta style title
  address article aside footer header h1 h2 h3 h4 h5 h6 hgroup main nav section search
  blockquote dd div dl dt figcaption figure hr li menu ol p pre ul
  a abbr b bdi bdo br cite code data dfn em i kbd mark q rp rt rtc rb ruby s samp small span strong sub sup time u var wbr
  del ins area audio img map track video embed iframe object picture source param
  canvas noscript script caption col colgroup table tbody td tfoot th thead tr
  button datalist fieldset form input label legend meter optgroup option output progress select textarea details dialog summary slot template
  acronym big center dir font frame frameset image marquee menuitem nobr noembed noframes plaintext strike tt xmp
  svg path circle ellipse line rect polygon polyline g defs use symbol marker mask clippath lineargradient radialgradient stop text tspan textpath foreignobject filter pattern desc
  math mrow mi mn mo ms mtext mspace msup msub msubsup mfrac msqrt mroot mtable mtr mtd munder mover munderover`
    .split(/\s+/)
    .filter(Boolean)
)

// A well-formed HTML tag token: <name>, <name attrs…>, <name/>, </name>. The name must START with a
// letter — so `a < b`, `2 > 1`, `<3`, and autolinks like `<https://…>` / `<a@b.com>` never match — and
// the token must fully close with `>`, so an unterminated `<div …` (no `>`) stays literal text. `_`
// is allowed in the name: the custom RP tags this targets use it (<scene_info>, <action_options>).
const TAG_TOKEN = /<\/?([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^<>]*)?\/?>/g

// Code we must not touch: fenced blocks (``` / ~~~) and inline spans (`…`). Captured so String.split
// keeps them as verbatim odd-index chunks between the strippable prose chunks. (```html fences were
// already extracted by HTML_BLOCK; a plain / ```text fence can still sit in an md segment.)
const CODE_REGION = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`)/g

/**
 * Drop custom/unknown HTML tag tokens from a markdown segment, keeping their children, so a card's
 * unhandled wrapper tags (<gametxt>, <scene_info>, …) render invisibly instead of as escaped text.
 * Known HTML/SVG/MathML tags and anything inside code fences/spans are left exactly as-is — only
 * genuinely-unknown tags change. Runs on md segments AFTER splitBareHtml, so it never affects which
 * regions get lifted (that decision reads the raw text); the freed prose still gets full markdown.
 */
export const stripUnknownHtmlTags = (md: string): string =>
  md
    .split(CODE_REGION)
    .map((chunk, i) =>
      // String.split with one capture group interleaves matches at ODD indices — those are the
      // preserved code regions; even indices are prose we strip.
      i % 2 === 1
        ? chunk
        : chunk.replace(TAG_TOKEN, (whole, name: string) =>
            KNOWN_HTML_TAGS.has(name.toLowerCase()) ? whole : ''
          )
    )
    .join('')

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
      // Groups, in HTML_BLOCK order: 1 = full-document ```html (anchored at </html>), 2 = lazy ```html
      // fragment, 3 = bare ``` full document, 4 = bare <html>/<body>. Exactly one is defined per match.
      text:
        m[1] !== undefined
          ? m[1]
          : m[2] !== undefined
            ? m[2]
            : m[3] !== undefined
              ? m[3]
              : m[4],
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
  return segs
    .flatMap((s) => (s.type === 'md' ? splitBareHtml(s.text) : [s]))
    // Third pass: drop custom/unknown wrapper tags left in the markdown (e.g. a card's <gametxt>/
    // <scene_info> that no display regex stripped) so they render invisibly instead of as escaped
    // text. Only md segments — lifted inline-html/frame regions keep their markup.
    .map((s) => (s.type === 'md' ? { ...s, text: stripUnknownHtmlTags(s.text) } : s))
}

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
