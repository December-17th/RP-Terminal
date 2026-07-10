import { describe, it, expect } from 'vitest'
import { splitHtml } from '../src/renderer/src/components/MessageContent'
import { isInteractiveHtml } from '../src/renderer/src/plugin/bridgeShim'
import { resolveScriptedHtmlRoute } from '../src/renderer/src/components/messageCardRouting'
import type { CardRenderMode } from '../src/shared/cardRenderMode'

/**
 * Card-trust-boundary issue 06 — adversarial pinning of the message-render trust boundary.
 *
 * The routing matrix the spec asks for is (grant-state × render-mode × CONTENT-SHAPE). Two halves
 * are already pinned in isolation:
 *   - grant × mode → route:  test/messageCardRouting.test.ts (the pure resolveScriptedHtmlRoute)
 *   - shape → segment class:  test/messageContent.test.ts + test/splitHtmlMode.test.ts (splitHtml)
 * This file pins the MISSING cell: the two composed — real content shapes flowing through
 * splitHtml → isInteractiveHtml → resolveScriptedHtmlRoute, exactly as MessageContent.tsx wires
 * them (lines 82-121). That composition is where "MessageContent lost the trust check" originally
 * (PRD §Problem): the shape classifier and the route resolver can each stay green while the wiring
 * between them regresses. Here it can't.
 *
 * Node-env, pure-module test (no React render): the app has no component-test harness
 * (vitest environment: 'node'), so the InlineCardFrame same-origin mount guard is pinned as a
 * routing invariant (§Bridge-guard invariant below) rather than by rendering the component. See
 * the issue Comments for the belt-and-braces note on the component-level guard.
 */

type Frame = 'inline' | 'isolated' | 'static' | 'inline-html' | 'md'

interface Grant {
  hasCard?: boolean
  trusted?: boolean | undefined
  decided?: boolean | undefined
  mode?: CardRenderMode
  globalMode?: CardRenderMode
}

/**
 * Faithful mirror of MessageContent's per-segment render decision (MessageContent.tsx:82-121):
 * take the first non-markdown segment splitHtml produced and decide its frame the same way the
 * component's JSX does — a scripted 'html' block is trust-routed via resolveScriptedHtmlRoute; a
 * script-free 'html' block renders the static HtmlFrame; a bare region renders inline-html
 * (sanitized, script stripped, NEVER a frame); anything else is markdown. This is the whole
 * shape→classification→route pipeline under one call.
 */
function renderFrameFor(content: string, g: Grant = {}): Frame {
  const seg = splitHtml(content).find((s) => s.type === 'html' || s.type === 'inline-html')
  if (!seg) return 'md'
  if (seg.type === 'inline-html') return 'inline-html'
  if (!isInteractiveHtml(seg.text)) return 'static' // script-free full-doc → HtmlFrame
  return resolveScriptedHtmlRoute({
    hasCard: g.hasCard ?? true,
    trusted: g.trusted,
    decided: g.decided,
    mode: g.mode ?? seg.mode,
    globalMode: g.globalMode ?? 'inline'
  })
}

// ── Content shapes ────────────────────────────────────────────────────────────────────────────
// Every scripted content shape the model / a card regex can emit that reaches the scripted-frame
// path (splitHtml type 'html' + a <script>). Each must land in the SAME trust router.
const INTERACTIVE_SHAPES: { name: string; content: string }[] = [
  {
    name: '```html fenced block with <script>',
    content: '```html\n<div id="c"><script>run()</script></div>\n```'
  },
  {
    name: 'plain ``` fence wrapping a full <!doctype html> doc with <script>',
    content: '```\n<!DOCTYPE html>\n<html><body><script>run()</script></body></html>\n```'
  },
  {
    name: 'bare <body> frontend-card block (no fence) with <script>',
    content: 'narration text\n<body><script>run()</script></body>'
  },
  {
    name: 'bare <html> document block with <script>',
    content: '<html><body><script>run()</script></body></html>'
  }
]

// Full-document HTML with NO <script>: still an 'html' segment, but must render static (script-free
// HtmlFrame) for EVERY grant state — a script-free card is inert and never needs a privileged frame.
const SCRIPTFREE_SHAPES: { name: string; content: string }[] = [
  { name: '```html fence, no <script>', content: '```html\n<div class="panel">hi</div>\n```' },
  { name: 'full <html> doc, no <script>', content: '<html><body><p>hi</p></body></html>' }
]

// ── Grant states (threat-model table, PRD "Trust levels") ───────────────────────────────────────
const TRUSTED: Grant = { trusted: true, decided: true }
const UNDECIDED: Grant = { trusted: false, decided: false }
const LOADING: Grant = { trusted: undefined, decided: undefined } // grants not yet read from disk
const DENIED: Grant = { trusted: false, decided: true }

describe('shape classification reaches the scripted-HTML router (issue 06 §1 composition)', () => {
  for (const s of INTERACTIVE_SHAPES) {
    it(`${s.name} → 'html' segment, detected interactive, trust-routed`, () => {
      const seg = splitHtml(s.content).find((x) => x.type === 'html')
      expect(seg, 'shape must classify as a full/fenced html block, not inline-html').toBeTruthy()
      expect(isInteractiveHtml(seg!.text)).toBe(true)
      // A trusted card with inline default lands on the same-origin frame — proof it reached the
      // router as an interactive block rather than being sanitized away.
      expect(renderFrameFor(s.content, TRUSTED)).toBe('inline')
    })
  }
})

// The core matrix: hardcoded expectations (NOT re-derived from the router, so it is a real pin) for
// every grant × global render-mode, asserted across every interactive content shape.
const MATRIX: { grant: Grant; grantName: string; globalMode: CardRenderMode; frame: Frame }[] = [
  { grant: TRUSTED, grantName: 'trusted', globalMode: 'inline', frame: 'inline' },
  { grant: TRUSTED, grantName: 'trusted', globalMode: 'isolated', frame: 'isolated' },
  { grant: TRUSTED, grantName: 'trusted', globalMode: 'panel', frame: 'inline' },
  { grant: UNDECIDED, grantName: 'undecided', globalMode: 'inline', frame: 'isolated' },
  { grant: UNDECIDED, grantName: 'undecided', globalMode: 'isolated', frame: 'isolated' },
  { grant: UNDECIDED, grantName: 'undecided', globalMode: 'panel', frame: 'isolated' },
  { grant: LOADING, grantName: 'grants-loading', globalMode: 'inline', frame: 'isolated' },
  { grant: LOADING, grantName: 'grants-loading', globalMode: 'isolated', frame: 'isolated' },
  { grant: DENIED, grantName: 'decided-denied', globalMode: 'inline', frame: 'static' },
  { grant: DENIED, grantName: 'decided-denied', globalMode: 'isolated', frame: 'static' },
  { grant: DENIED, grantName: 'decided-denied', globalMode: 'panel', frame: 'static' }
]

describe('routing matrix: content-shape × grant × render-mode (issue 06 §1)', () => {
  for (const shape of INTERACTIVE_SHAPES) {
    for (const c of MATRIX) {
      it(`[${shape.name}] ${c.grantName} @ ${c.globalMode} → ${c.frame}`, () => {
        expect(renderFrameFor(shape.content, { ...c.grant, globalMode: c.globalMode })).toBe(
          c.frame
        )
      })
    }
  }

  it('per-card isolated override beats a trusted card on an inline global default', () => {
    for (const s of INTERACTIVE_SHAPES) {
      expect(renderFrameFor(s.content, { ...TRUSTED, mode: 'isolated', globalMode: 'inline' })).toBe(
        'isolated'
      )
    }
  })

  it('a per-card inline override can NOT lift an undecided card into the same-origin frame', () => {
    for (const s of INTERACTIVE_SHAPES) {
      expect(
        renderFrameFor(s.content, { ...UNDECIDED, mode: 'inline', globalMode: 'inline' })
      ).toBe('isolated')
    }
  })
})

describe('script-free full-document HTML always renders static (issue 06 §1)', () => {
  for (const s of SCRIPTFREE_SHAPES) {
    for (const [name, grant] of [
      ['trusted', TRUSTED],
      ['undecided', UNDECIDED],
      ['decided-denied', DENIED]
    ] as const) {
      it(`${s.name} + ${name} → static (no <script>, no privileged frame)`, () => {
        expect(renderFrameFor(s.content, { ...grant, globalMode: 'inline' })).toBe('static')
      })
    }
  }
})

describe('bare model HTML never auto-runs (issue 06 §1 — content-shape edge)', () => {
  it('a bare <div> carrying a <script> classifies as inline-html (script stripped), never a frame', () => {
    // Unfenced model output must never reach the scripted frame. Even a TRUSTED card can not make a
    // bare region execute — authored cards opt into scripts via a ```html fence / <body> wrapper.
    for (const g of [TRUSTED, UNDECIDED, DENIED]) {
      expect(renderFrameFor('<div><script>alert(1)</script></div>', g)).toBe('inline-html')
    }
  })

  it('scripted HTML with NO active card renders static (bare model output, no provenance)', () => {
    for (const s of INTERACTIVE_SHAPES) {
      // hasCard:false — even with a (spurious) trusted flag + inline mode, no provenance ⇒ static.
      expect(renderFrameFor(s.content, { hasCard: false, trusted: true, globalMode: 'inline' })).toBe(
        'static'
      )
    }
  })
})

/**
 * Bridge-guard invariant (issue 06 §4). InlineCardFrame is the ONLY same-origin, window.parent.api-
 * reachable frame; its mount is defended twice — the router below, and a belt-and-braces
 * `if (!trusted) return <HtmlFrame>` inside the component (InlineCardFrame.tsx:192-196). The
 * component-level guard is reviewed by construction (this repo has no React render harness — see
 * issue Comments); here we pin the FIRST line of defence exhaustively: across the whole
 * shape × grant × mode space, 'inline' is reachable ONLY with an explicit trusted:true on a present
 * card. If any untrusted/undecided/denied/no-card/loading input ever routes 'inline', that is the
 * exact bypass this suite exists to catch.
 */
describe('same-origin inline frame is trusted-only (issue 06 §4 invariant)', () => {
  const ALL_MODES: CardRenderMode[] = ['inline', 'isolated', 'panel']
  const UNTRUSTED_GRANTS: { name: string; grant: Grant }[] = [
    { name: 'undecided', grant: UNDECIDED },
    { name: 'grants-loading', grant: LOADING },
    { name: 'decided-denied', grant: DENIED },
    { name: 'trusted-but-no-card', grant: { ...TRUSTED, hasCard: false } }
  ]

  it('no untrusted grant state routes any content shape to the inline (same-origin) frame', () => {
    for (const shape of INTERACTIVE_SHAPES) {
      for (const u of UNTRUSTED_GRANTS) {
        for (const globalMode of ALL_MODES) {
          for (const mode of [undefined, 'inline', 'isolated'] as (CardRenderMode | undefined)[]) {
            const frame = renderFrameFor(shape.content, { ...u.grant, globalMode, mode })
            expect(
              frame,
              `${shape.name} / ${u.name} / global=${globalMode} / card=${mode}`
            ).not.toBe('inline')
          }
        }
      }
    }
  })

  it('inline is reached ONLY by an explicit trusted:true on a present card', () => {
    // Positive complement: with everything else identical, only trusted:true (+ non-isolated mode)
    // yields inline. Flips the guarantee around so a regression that makes inline the DEFAULT fails.
    for (const shape of INTERACTIVE_SHAPES) {
      expect(renderFrameFor(shape.content, { trusted: true, decided: true, globalMode: 'inline' })).toBe(
        'inline'
      )
      expect(
        renderFrameFor(shape.content, { trusted: false, decided: false, globalMode: 'inline' })
      ).not.toBe('inline')
    }
  })
})
