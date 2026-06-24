import postcss, { type AtRule } from 'postcss'

/**
 * Scope a message card's `<style>` so it renders INLINE in the chat (blending with the message)
 * without its rules leaking into the app UI. Clean-room reimplementation of the SillyTavern/RisuAI
 * message-style-scoping technique (prefix every selector with the card's container) — built on
 * postcss; no ST/RisuAI code is reused, and the general approach (selector-prefixing, like CSS
 * Modules / Vue `scoped`) is not specific to them.
 */

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi

/** Pull every `<style>` block out of an HTML string → the style-free html + the concatenated CSS. */
export const extractStyleBlocks = (html: string): { html: string; css: string } => {
  const css: string[] = []
  const stripped = String(html ?? '').replace(STYLE_BLOCK_RE, (_m, inner) => {
    css.push(inner)
    return ''
  })
  return { html: stripped, css: css.join('\n') }
}

/** A safe, unique CSS class for a card instance, derived from a React useId() value. */
export const scopeClassFor = (id: string): string =>
  'rpt-ih-' + (String(id ?? '').replace(/[^a-zA-Z0-9]/g, '') || '0')

const scopeSelector = (selector: string, scope: string): string => {
  const s = selector.trim()
  if (!s) return s
  // Document-root selectors map onto the card's container element itself.
  if (/^(?::root|html|body)$/i.test(s)) return `.${scope}`
  return `.${scope} ${s}`
}

/**
 * Prefix every selector in `css` with `.${scope}` so the rules only match inside that card's
 * container; drop `@import` (no external stylesheet fetches); leave `@keyframes` step selectors
 * (from/to/NN%) and `@font-face` untouched. Rules inside `@media`/`@supports` are scoped too.
 * Invalid CSS yields '' (the card just renders unstyled) rather than throwing.
 */
export const scopeCss = (css: string, scope: string): string => {
  let root: postcss.Root
  try {
    root = postcss.parse(String(css ?? ''))
  } catch {
    return ''
  }
  root.walkAtRules('import', (rule) => {
    rule.remove()
  })
  root.walkRules((rule) => {
    const parent = rule.parent
    // Keyframe steps (0%/from/to) are not selectors to scope.
    if (parent && parent.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) return
    rule.selectors = rule.selectors.map((sel) => scopeSelector(sel, scope))
  })
  return root.toString()
}
