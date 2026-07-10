import { expandMacros } from '../../../shared/macros'

/**
 * The display transform for the IN-FLIGHT (streaming) body, extracted as a pure function so its
 * ordering and rate-limit gating unit-test without a renderer or the quickjs/WASM template engine.
 *
 * It composes the SAME tail of the chain the settled floor runs (see ChatView `currentFloor`):
 * EJS `<%…%>` live eval → `{{…}}` macros → display regex (beautification). `stripThinking` is not
 * needed because the streaming caller feeds the reasoning-free `body` from `splitReasoning`.
 *
 * Rate limiting: below the first checkpoint (`body.length < rateChars`) it returns an empty head so
 * the early stream flows as raw plain text; the caller renders `body.slice(atLen)` raw and only
 * re-invokes this at rate-limit boundaries (per-token macro+regex+WASM eval would tank streaming).
 */

export interface StreamingHeadDeps {
  /** EJS live-template eval; invoked only when `liveOn` and the body contains a `<%` tag. */
  renderLive: (text: string, vars: Record<string, unknown>) => string
  /** Display-regex applier (renderer: `useRegexStore.getState().apply`). */
  applyRegex: (text: string, ctx: { user: string; char: string }) => string
}

export interface StreamingHeadOpts {
  /** Rate-limit boundary in characters; below it the head is empty and the whole body flows raw. */
  rateChars: number
  /** Whether render-time EJS live eval is enabled (master + render + live toggles). */
  liveOn: boolean
  /** Latest committed floor's variables — the in-flight floor isn't committed yet. */
  vars: Record<string, unknown>
  user: string
  char: string
}

export interface StreamingHead {
  /** Beautified head HTML; empty before the first rate checkpoint. */
  html: string
  /** Length of `body` folded into `html`; the caller renders `body.slice(atLen)` as the raw tail. */
  atLen: number
}

export const buildStreamingHead = (
  body: string,
  opts: StreamingHeadOpts,
  deps: StreamingHeadDeps
): StreamingHead => {
  if (body.length < opts.rateChars) return { html: '', atLen: 0 }
  const evaled = opts.liveOn && body.includes('<%') ? deps.renderLive(body, opts.vars) : body
  const withMacros = expandMacros(evaled, { user: opts.user, char: opts.char, vars: opts.vars })
  const html = deps.applyRegex(withMacros, { user: opts.user, char: opts.char })
  return { html, atLen: body.length }
}
