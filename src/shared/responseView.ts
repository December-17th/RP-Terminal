/**
 * View-time response transforms.
 *
 * The model's FULL raw response is what gets STORED (lossless) — these strip
 * machine/reasoning content only when ASSEMBLING A VIEW: the rendered message
 * (`cleanForDisplay`) or the history sent back to the model (`cleanForHistory`). Pure + shared
 * (main + renderer) so storage stays full and "disabling the card's regex shows the original".
 */

// Reasoning blocks (closed, plus a dangling unclosed trailing one from truncated output).
const THINK_RE = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi
const THINK_DANGLING_RE = /<think(?:ing)?\b[^>]*>[\s\S]*$/i
// Our own self-closing state tag.
const RPT_EVENT_RE = /<rpt-event\s+[^>]*?\/?>/gi
// MVU <UpdateVariable> blocks — tempered so a STRAY unclosed mention can't over-match (keep in
// sync with mvuParser's blockRe).
const MVU_BLOCK_RE =
  /<(UpdateVariable|update|updatevariable)>(?:(?!<(?:UpdateVariable|update|updatevariable)>)[\s\S])*?<\/\1>/gi

export const stripThinking = (text: string): string =>
  String(text ?? '')
    .replace(THINK_RE, '')
    .replace(THINK_DANGLING_RE, '')
    .trim()

export const stripRptEvents = (text: string): string => String(text ?? '').replace(RPT_EVENT_RE, '')

export const stripMvuBlocks = (text: string): string => String(text ?? '').replace(MVU_BLOCK_RE, '')

/**
 * For the rendered message: hide reasoning + our own state tags. MVU `<UpdateVariable>` blocks
 * are left in place for the card's own display regex to fold — so disabling that regex reveals
 * the original block.
 */
export const cleanForDisplay = (text: string): string => stripRptEvents(stripThinking(text)).trim()

/**
 * For history sent back to the model: also drop the MVU blocks (matches the pre-lossless
 * behavior — the model never re-reads its own reasoning or raw state ops).
 */
export const cleanForHistory = (text: string): string =>
  stripMvuBlocks(stripRptEvents(stripThinking(text))).trim()
