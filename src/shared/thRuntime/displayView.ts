// src/shared/thRuntime/displayView.ts
//
// The wire shapes the DisplayHost facet (ADR 0023) hands a trusted WCV card panel: the app's own
// BEAUTIFIED view of a committed floor (`RenderedFloorView`) and of the in-flight streaming body
// (`DisplayStreamFrame`). These are the render-broker's response payload + the `display_stream_frame`
// event payload — a card that owns the chat rect rebuilds the transcript from them instead of
// reimplementing the renderer-only display pipeline (see docs/display-host-design.md §3.3).
//
// Boundary: pure type declarations under `shared/` — no electron / main / renderer imports.

/** Category of a `display_invalidated` event — why the card should drop its render cache. */
export type DisplayInvalidateReason = 'regex' | 'settings' | 'character' | 'persona'

/**
 * One committed floor, run through the app display pipeline. `floorIndex` is the floor's position in
 * the panel's `floors()` view (chatScope-consistent — the SAME index the card would use to read the
 * raw floor), and `revision` is the `displayRevision()` at render time so a card can cache by
 * `(floorIndex, swipeId, revision)`.
 */
export interface RenderedFloorView {
  floorIndex: number
  /** displayRevision at render time — the card's cache key + invalidation stamp. */
  revision: number
  /** Raw `user_message.content` — parity with the native view, which shows it untransformed. */
  userText: string
  /** Response body after the full display transform (EJS → markers → macros → display regex). */
  html: string
  /** Reasoning text after the placement-6 reasoning regex; '' when the floor has none. */
  thinking: string
  hasReasoning: boolean
  /** The active character card's `reasoning_template` slot (so the card can rebuild the panel), or null. */
  reasoningTemplate: string | null
  /** `plot_block` after the placement-1⊕2 plot regex (PlotPanel's own pass); '' when none. */
  plotHtml: string
  swipeId: number
  swipeCount: number
}

/**
 * The transformed prefix of the in-flight (streaming) body, emitted at the native `rateChars`
 * checkpoint cadence. `html` is the beautified head; `body.slice(atLen)` is the still-raw tail the
 * card renders plainly for a typing effect between checkpoints (`rawTail` carries it verbatim).
 */
export interface DisplayStreamFrame {
  chatId: string
  revision: number
  /** buildStreamingHead output (transformed prefix); '' before the first checkpoint. */
  html: string
  /** Length of the body folded into `html`; the raw tail is `body.slice(atLen)`. */
  atLen: number
  rawTail: string
  reasoning: { text: string; state: 'none' | 'thinking' | 'done' }
}
