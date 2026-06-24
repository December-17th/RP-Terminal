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

// Whether any raw <think>/<thinking> OPEN tag remains — e.g. the card's display regex didn't fold it.
// Used to decide between the card's inline beautification and our own dedicated reasoning section.
export const hasThinking = (text: string): boolean =>
  /<think(?:ing)?\b[^>]*>/i.test(String(text ?? ''))

// The reasoning text itself — the inner content of each <think> block plus any dangling unclosed
// trailing one — for rendering in a dedicated expandable section when no card regex beautifies it.
export const extractThinking = (text: string): string => {
  const s = String(text ?? '')
  const closed = [...s.matchAll(/<think(?:ing)?\b[^>]*>([\s\S]*?)<\/think(?:ing)?>/gi)].map(
    (m) => m[1]
  )
  const dangling = /<think(?:ing)?\b[^>]*>([\s\S]*)$/i.exec(s.replace(THINK_RE, ''))
  return [...closed, ...(dangling ? [dangling[1]] : [])]
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n')
}

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
