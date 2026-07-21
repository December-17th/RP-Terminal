import { expandMacros } from '../../../shared/macros'
import { stripRptEvents, stripThinking, extractThinking } from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'
import { buildStreamingHead, type StreamingHead } from '../components/streamingDisplay'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCharacterStore } from '../stores/characterStore'
import type { RenderedFloor } from '../components/FloorBlock'

/**
 * Headless view-time display pipeline — the app's own beautified-floor transform, lifted out of
 * `ChatView.currentFloor` and `StreamingView` so it can run without those components mounted (a card
 * that claims the chat slot never mounts them; see docs/display-host-design.md §3.1). Step 1 is a
 * PURE refactor: `renderFloorView`/`renderStreamingFrame` produce byte-identical output to the memos
 * they replace, and the native views keep the same store-driven memo invalidation.
 *
 * The transform is renderer-only: `regexStore`, `settingsStore` flags, `characterStore`, the persona
 * name and the quickjs EJS engine all live here. Store reads are captured in a `DisplayCtx` snapshot
 * so the transform functions stay pure/injectable (tests pass fakes; the broker will pass a real
 * snapshot). `renderTemplate` is SYNCHRONOUS (quickjs eval runs sync; it strips tags until the WASM
 * engine loads), so these are sync too — no Promise despite the design sketch.
 */

/** Just the macro-substitution identity names the regex + macro passes need. */
export interface MacroNameCtx {
  user: string
  char: string
}

/** ST-PT [RENDER:*] marker templates active for the session (evaluated per-floor). */
export interface RenderMarkers {
  before: string[]
  after: string[]
}

/** Minimal shape of a stored floor the transform reads (structural — decoupled from the store type). */
export interface FloorLike {
  floor: number
  response: { content: string }
  user_message: { content: string }
  variables: Record<string, unknown>
  plot_block?: string
  swipe_id?: number
  swipes?: unknown[]
}

/**
 * A snapshot of the store-derived inputs the transform reads, plus the injected transform functions.
 * `applyRegex`/`applyReasoning`/`applyPlot`/`renderTemplate` close over the live stores (same
 * `getState()` reads the memos do today) — capturing them as ctx keeps `renderFloorView`/
 * `renderStreamingFrame` pure and unit-testable with fakes.
 */
export interface DisplayCtx {
  user: string
  char: string
  templatesOn: boolean
  renderEnabled: boolean
  finalPassOn: boolean
  liveOn: boolean
  rateChars: number
  /** Display-regex applier (placement 2). */
  applyRegex: (text: string, m: MacroNameCtx) => string
  /** Reasoning display regex (placement 6) for the ReasoningPanel. */
  applyReasoning: (text: string, m: MacroNameCtx) => string
  /** Plot-block display regex (placement 1 ⊕ 2) — PlotPanel's own pass; unused by the native floor
   *  view (which passes plot_block verbatim) but carried for the DisplayHost broker (step 2). */
  applyPlot: (text: string, m: MacroNameCtx) => string
  /** EJS template eval (Phase C final / live), synchronous. */
  renderTemplate: (text: string, vars: Record<string, unknown>, mode: 'final' | 'live') => string
  renderMarkers: RenderMarkers
}

/**
 * Build a `DisplayCtx` from the current zustand stores — the SAME reads the ChatView/StreamingView
 * memos perform. `renderMarkers` are ChatView-local session state (fetched via `getRenderMarkers`),
 * not store-derived, so the caller supplies them (default = none, for the streaming/broker paths that
 * don't wrap markers).
 */
export function currentDisplayCtx(
  renderMarkers: RenderMarkers = { before: [], after: [] }
): DisplayCtx {
  const settings = useSettingsStore.getState().settings
  const templates = settings?.templates
  const templatesOn = templates?.enabled !== false
  const renderEnabled = templates?.render?.enabled !== false
  const finalPassOn = templates?.render?.final_pass !== false
  const liveOn = templatesOn && renderEnabled && templates?.render?.live !== false
  const rateChars = Math.max(1, (templates?.render?.rate_tokens || 500) * 4) // ~4 chars per token
  const user = settings?.persona?.name || 'User'
  const char = useCharacterStore.getState().activeCharacter?.card.data.name || 'Character'
  return {
    user,
    char,
    templatesOn,
    renderEnabled,
    finalPassOn,
    liveOn,
    rateChars,
    applyRegex: (text, m) => useRegexStore.getState().apply(text, m),
    applyReasoning: (text, m) => useRegexStore.getState().applyReasoning(text, m),
    applyPlot: (text, m) => useRegexStore.getState().applyPlot(text, m),
    renderTemplate,
    renderMarkers
  }
}

/**
 * Render-time transform of ONE floor: EJS final pass (with this floor's vars) → [RENDER:*] marker
 * wrapping → macros (TH-5) → display regex (beautification). The model's raw output stays stored;
 * this is display-only. Byte-identical to the old `ChatView.currentFloor` memo body.
 */
export function renderFloorView(floor: FloorLike, ctx: DisplayCtx): RenderedFloor {
  const f = floor
  // Stored content is the FULL raw response. Strip our own state tags; the <thinking> block is
  // kept here only so renderTemplate/macros see the same text — it's removed before the display
  // regex (below) and routed to the ReasoningPanel, so a card regex can NEVER rewrite reasoning
  // into inline UI. The regex still folds the card's <UpdateVariable> blocks in the body, and
  // nothing is ever truncated in storage.
  const evaled = ctx.renderTemplate(stripRptEvents(f.response.content), f.variables, 'final')
  // [RENDER:*]: wrap with the active render-marker templates (each evaled with this floor's vars).
  const wrap = (tmpls: string[]): string =>
    ctx.templatesOn && ctx.renderEnabled
      ? tmpls
          .map((t) => ctx.renderTemplate(t, f.variables, 'final'))
          .filter(Boolean)
          .join('\n\n')
      : ''
  const body = [wrap(ctx.renderMarkers.before), evaled, wrap(ctx.renderMarkers.after)]
    .filter(Boolean)
    .join('\n\n')
  const withMacros = expandMacros(body, {
    user: ctx.user,
    char: ctx.char,
    vars: f.variables
  })
  // The display regex applies to the BODY ONLY — reasoning (<thinking>) is owned by the
  // ReasoningPanel and must never be rewritten into inline UI by a card regex. So strip the
  // reasoning out before the regex runs and route it to the panel via `thinking`.
  const applyRegex = (t: string): string => ctx.applyRegex(t, { user: ctx.user, char: ctx.char })
  return {
    floor: f.floor,
    user: f.user_message.content,
    rawResponse: f.response.content,
    html: applyRegex(stripThinking(withMacros)),
    // Reasoning display regex (ST placement 6) transforms the <think> text for the ReasoningPanel.
    thinking: ctx.applyReasoning(extractThinking(f.response.content), {
      user: ctx.user,
      char: ctx.char
    }),
    // Plot-recall: pass the STORED plot_block through verbatim (display-only; PlotPanel applies the
    // placement-1 beautification regex + routes the html itself). Not derived from response.content.
    plotBlock: f.plot_block,
    swipeId: f.swipe_id ?? 0,
    swipeCount: f.swipes?.length ?? 1
  }
}

/**
 * Render-time transform of the IN-FLIGHT (streaming) body — a thin wrapper over `buildStreamingHead`
 * that maps a `DisplayCtx` onto its (opts, deps). Semantics are unchanged: EJS live eval only when
 * `liveOn` and the body contains `<%`, `{{…}}` macros over a shallow-copied `vars`, then display
 * regex; below the first `rateChars` checkpoint the head is empty (early stream flows raw).
 */
export function renderStreamingFrame(
  body: string,
  vars: Record<string, unknown>,
  ctx: DisplayCtx
): StreamingHead {
  return buildStreamingHead(
    body,
    { rateChars: ctx.rateChars, liveOn: ctx.liveOn, vars, user: ctx.user, char: ctx.char },
    {
      renderLive: (text, v) => ctx.renderTemplate(text, v, 'live'),
      applyRegex: ctx.applyRegex
    }
  )
}

// Re-export so the streaming-head pure primitive + its types remain importable from the display
// module too (buildStreamingHead's own unit test keeps importing from ./components/streamingDisplay).
export { buildStreamingHead } from '../components/streamingDisplay'
export type { StreamingHead, StreamingHeadDeps, StreamingHeadOpts } from '../components/streamingDisplay'
