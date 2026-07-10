// Pure routing model for scripted-HTML message blocks — trust-gated (card-trust-boundary issue 01).
// NO React/DOM/store imports (vitest-pure, like tableGridModel). MessageContent renders from
// resolveScriptedHtmlRoute; the matrix is unit-tested in test/messageCardRouting.test.ts.

import { resolveCardMode } from '../../../shared/cardRenderMode'
import type { CardRenderMode } from '../../../shared/cardRenderMode'

/**
 * Where a scripted (interactive) HTML block may render, keyed off the owning card's persisted
 * trust grant:
 * - 'inline':   same-origin InlineCardFrame (can reach window.parent.api) — trusted cards ONLY.
 * - 'isolated': out-of-process WcvMessageFrame — the untrusted/undecided default (fail-closed).
 * - 'static':   sanitized, script-free HtmlFrame — denied cards + bare model HTML (no card).
 */
export type ScriptedRoute = 'inline' | 'isolated' | 'static'

export interface ScriptedRouteInput {
  /** There is an active world/character card owning this message (its grants gate execution). */
  hasCard: boolean
  /** `CardGrants.trusted` for the owning card — `undefined` until the grant read resolves. */
  trusted: boolean | undefined
  /** `CardGrants.decided` — the user made an explicit trust decision — `undefined` until resolved. */
  decided: boolean | undefined
  /** Per-card render-mode override emitted by the regex applier (may be `undefined`). */
  mode: CardRenderMode | undefined
  /** Global render-mode default (settings.cards.renderMode). */
  globalMode: CardRenderMode
}

/**
 * Trust-gated routing for a scripted HTML block. Fails CLOSED: anything but an explicit
 * `trusted: true` on a present card is denied same-origin (inline) execution.
 *
 * | grant state                     | route                                |
 * | ------------------------------- | ------------------------------------ |
 * | no active card                  | static (sanitized, scripts stripped) |
 * | trusted: true                   | resolveCardMode → inline or isolated |
 * | not trusted, decided: true      | static (denial keeps scripts off)    |
 * | not trusted, undecided/unknown  | isolated (forced WCV, never inline)  |
 *
 * `trusted`/`decided` are tri-state: while grants are still loading both are `undefined`, which
 * lands in the undecided/unknown row (isolated) — never inline. A KNOWN `trusted: true` routes by
 * render-mode immediately, so a trusted card opened cold does not flash through the WCV path.
 */
export const resolveScriptedHtmlRoute = (input: ScriptedRouteInput): ScriptedRoute => {
  if (!input.hasCard) return 'static'
  if (input.trusted === true) {
    return resolveCardMode(input.mode, input.globalMode) === 'isolated' ? 'isolated' : 'inline'
  }
  if (input.decided === true) return 'static'
  return 'isolated'
}
