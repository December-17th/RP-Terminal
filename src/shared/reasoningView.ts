/**
 * Reasoning-panel helpers: derive a short title + a time/place/weather (`<tp>`) line from a
 * response, and fill a card-authored HTML template's `{{slots}}`.
 *
 * A card can theme the reasoning UI by setting `data.extensions.rp_terminal.reasoning_template`
 * to an HTML shell with `{{reasoning}}` / `{{title}}` / `{{tp}}` / `{{state}}` (and the split
 * `{{time}}` / `{{location}}` / `{{weather}}`) slots. The app fills it live while the model is
 * still thinking AND on the settled floor, so the streaming and final looks match.
 *
 * Pure + shared (renderer ReasoningPanel + tests). The title/tp extraction is adapted from the
 * user's own card script (the 命定之诗 CoT styler) — not from js-slash-runner.
 */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g

const normalizeHeaderText = (s: string): string =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .replace(ZERO_WIDTH, '')
    .trim()

const normalizeTpText = (s: string): string =>
  String(s || '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const ALL_PUNCT = /^[`~!@#$%^&*()_+\-=[\]{};:'",.<>/?|\\]+$/

/**
 * The most salient heading in the reasoning text, by priority: a `#`/`##` heading wins over a
 * lone `**bold**` line, which wins over a `-`/`•` bullet; ties break to the latest occurrence.
 * Returns '' when nothing heading-like is present.
 */
export const extractReasoningTitle = (text: string): string => {
  const src = String(text || '')
  if (!src) return ''
  const cands: { priority: number; index: number; title: string }[] = []
  const add = (priority: number, index: number, raw: string): void => {
    const title = normalizeHeaderText(raw)
    if (title && !ALL_PUNCT.test(title)) cands.push({ priority, index, title })
  }
  let m: RegExpExecArray | null
  const h = /^(#{1,2})\s+(.+)$/gm
  while ((m = h.exec(src)) !== null) add(3, m.index, m[2])
  const b = /(?:^|\n)\s*\*\*([^*\n][^*\n]*?)\*\*\s*(?=\n|$)/g
  while ((m = b.exec(src)) !== null) add(2, m.index, m[1])
  const li = /^\s*(?:-|•)\s+(.+)$/gm
  while ((m = li.exec(src)) !== null) add(1, m.index, m[1])
  if (!cands.length) return ''
  // Highest priority wins; latest occurrence breaks ties → last after an ascending sort.
  cands.sort((x, y) => x.priority - y.priority || x.index - y.index)
  return cands[cands.length - 1].title
}

export interface TpInfo {
  time: string
  location: string
  weather: string
}

/**
 * Parse a `<tp>time @ location | weather</tp>` tag (each field optional). Returns null when there's
 * no `<tp>` tag or it carries no fields.
 */
export const extractTpInfo = (text: string): TpInfo | null => {
  const src = String(text || '')
  if (!src.includes('<tp')) return null
  // Match ONLY the closed form, with a single non-`<` inner capture (no nested lazy quantifiers), then
  // split the fields in JS. The earlier `\s*(…?)\s*(?:@…)?(?:\|…)?` pattern backtracked catastrophically
  // on an UNCLOSED `<tp>` followed by whitespace — and this runs on every streamed token (ReasoningPanel),
  // so an unclosed tag mid-stream froze the renderer. Requiring `</tp>` is also the right UX (nothing to
  // show until it closes).
  const m = src.match(/<tp\b[^>]*>([^<]*)<\/tp>/i)
  if (!m) return null
  const [timeLoc, weatherPart = ''] = m[1].split('|')
  const [timePart = '', locationPart = ''] = timeLoc.split('@')
  const time = normalizeTpText(timePart)
  const location = normalizeTpText(locationPart)
  const weather = normalizeTpText(weatherPart)
  if (!time && !location && !weather) return null
  return { time, location, weather }
}

/** A single-line "time · place · weather" summary (omitting empty fields). '' when no info. */
export const formatTp = (tp: TpInfo | null): string =>
  tp ? [tp.time, tp.location, tp.weather].filter(Boolean).join(' · ') : ''

export const escapeHtml = (s: string): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Content slots whose values stream in (updated in place by ReasoningPanel, never reparsed). */
export const REASONING_CONTENT_SLOTS = [
  'reasoning',
  'title',
  'tp',
  'time',
  'location',
  'weather'
] as const

export type ReasoningSlots = {
  reasoning?: string
  title?: string
  tp?: string
  time?: string
  location?: string
  weather?: string
  state?: string
}

const CONTENT_SLOT_RE = new RegExp(
  `\\{\\{\\s*(${REASONING_CONTENT_SLOTS.join('|')})\\s*\\}\\}`,
  'g'
)
const STATE_SLOT_RE = /\{\{\s*state\s*\}\}/g

/**
 * Turn a card template into a re-paintable skeleton: each CONTENT slot becomes an empty
 * `<span data-rpt-slot="…">` that the panel fills via textContent as tokens arrive (so streaming
 * never re-parses HTML), while `{{state}}` is substituted inline (it's a fixed enum, used in
 * attributes/classes like `data-state="{{state}}"`).
 */
export const reasoningSkeleton = (template: string, state: string): string =>
  String(template || '')
    .replace(CONTENT_SLOT_RE, (_m, k) => `<span data-rpt-slot="${k}"></span>`)
    .replace(STATE_SLOT_RE, escapeHtml(state))

/** Static, fully-escaped fill of every slot (for non-streaming use + tests). */
export const fillReasoningTemplate = (template: string, slots: ReasoningSlots): string =>
  String(template || '')
    .replace(CONTENT_SLOT_RE, (_m, k) => escapeHtml(slots[k as keyof ReasoningSlots] ?? ''))
    .replace(STATE_SLOT_RE, escapeHtml(slots.state ?? ''))
