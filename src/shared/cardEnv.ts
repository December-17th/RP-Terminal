// src/shared/cardEnv.ts
//
// The card rendering ENVIRONMENT — the <head> a SillyTavern/JS-Slash-Runner card is authored against,
// built ONCE here so both transports (inline iframe + WCV) inject the same thing (the SP2 anti-drift
// discipline, extended from the API surface to the document surface). Pure: imports nothing realm-specific
// (no DOM/electron/Zustand), so it resolves in both the renderer and preload builds.
//
// Clean-room: the JSR `createSrcContent` / `adjust_viewport.js` behavior is the compat TARGET; the code
// below is our own. The per-realm bits that genuinely differ (resolved lib URLs, avatar URLs, the live
// viewport height) are passed in via EnvHeadOpts so this module stays URL-agnostic and pure.

/** Card sizing mode. `fit` = content-fit (embedded, default); `fill` = fill the frame (vh-driven). */
export type CardSizing = 'fit' | 'fill'

export interface EnvHeadOpts {
  /** Pre-rendered <script>/<link> tags for the assumed libs, resolved per realm (inline vs WCV). */
  libTags: string
  /** Avatar URLs; an empty/undefined URL omits that rule entirely. */
  userAvatarUrl?: string
  charAvatarUrl?: string
  sizing: CardSizing
  /** Initial `--TH-viewport-height` (px). When omitted/<=0, the bootstrap falls back to window.innerHeight. */
  viewportHeightPx?: number
}

/**
 * The base CSS reset cards assume. Mirrors SillyTavern/Tavern-Helper's `createSrcContent` (≈ Tailwind
 * preflight): without it our iframe defaults to content-box + an 8px body margin, so a `width:100%`+padding
 * element overflows. Placed at head start so the card's own styles still override it.
 */
export const BASE_RESET_CSS =
  '*,*::before,*::after{box-sizing:border-box}' +
  'html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important}'

/** Escape a URL for safe embedding inside a CSS `url('...')` (defensive — avatar paths are app-controlled). */
function escCssUrl(url: string): string {
  return String(url).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** The `.user_avatar`/`.char_avatar` background rules JSR injects; a rule is omitted when its URL is empty. */
function avatarCss(userAvatarUrl?: string, charAvatarUrl?: string): string {
  let css = ''
  if (userAvatarUrl)
    css += `.user_avatar,.user-avatar{background-image:url('${escCssUrl(userAvatarUrl)}')}`
  if (charAvatarUrl)
    css += `.char_avatar,.char-avatar{background-image:url('${escCssUrl(charAvatarUrl)}')}`
  return css
}

/**
 * Inline <script> that sets `--TH-viewport-height` on <html> and re-sets it when the host posts
 * `{type:'TH_UPDATE_VIEWPORT_HEIGHT', height}` (faithful to JSR `adjust_viewport.js`). Cards read the
 * variable to fill the window; `replaceVhInContent` rewrites their `min-height:NNvh` onto it.
 */
function viewportBootstrap(viewportHeightPx?: number): string {
  const px = typeof viewportHeightPx === 'number' && viewportHeightPx > 0 ? viewportHeightPx : 0
  const init = px > 0 ? String(px) : 'window.innerHeight'
  return (
    '<script>(function(){try{' +
    `var h=${init};` +
    "function set(v){try{document.documentElement.style.setProperty('--TH-viewport-height',v+'px');}catch(e){}}" +
    'set(h);' +
    "window.addEventListener('message',function(e){try{if(e&&e.data&&e.data.type==='TH_UPDATE_VIEWPORT_HEIGHT'){set(typeof e.data.height==='number'?e.data.height:h);}}catch(_){}});" +
    '}catch(e){}})();</script>'
  )
}

/**
 * Build the rendering-env <head> fragment: base reset + avatar CSS, then the assumed-lib tags, then the
 * `--TH-viewport-height` bootstrap. Composed by each transport AFTER its own preamble (the inline bridge
 * bootstrap, or the WCV CSP meta) into `buildCardDoc`'s `headInject`.
 */
export function buildEnvHead(opts: EnvHeadOpts): string {
  const styleBody = BASE_RESET_CSS + avatarCss(opts.userAvatarUrl, opts.charAvatarUrl)
  return `<style>${styleBody}</style>` + opts.libTags + viewportBootstrap(opts.viewportHeightPx)
}

/** Convert the vh values inside one declaration value to the viewport variable. */
function convVh(value: string): string {
  return value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, num: string) => {
    const n = parseFloat(num)
    if (!isFinite(n)) return match
    if (n === 100) return 'var(--TH-viewport-height)'
    return `calc(var(--TH-viewport-height) * ${n / 100})`
  })
}

/**
 * Rewrite a card's `min-height:NNvh` to `var(--TH-viewport-height)` (NN===100) or
 * `calc(var(--TH-viewport-height) * NN/100)`, so a card sized to the viewport FILLS the frame instead of
 * the literal device vh (used by `fill` mode). Faithful to JSR's `replaceVhInContent`: ONLY `min-height`
 * (a bare `height:100vh` is left alone), across four sites — CSS declarations, inline `style="…"`, and the
 * two JS forms (`.style.minHeight=` and `.style.setProperty('min-height',…)`). No-op when there is no vh.
 */
export function replaceVhInContent(html: string): string {
  // Fast no-op when there is no vh at all. (Guard on vh, NOT on `min-height`: the JS forms use camelCase
  // `minHeight`, which a hyphenated `min-height` check would wrongly skip.)
  if (!/\d+(?:\.\d+)?vh/i.test(html)) return html
  let out = html
  // 1) CSS declaration block: `min-height: …vh` terminated by `;` or `}`.
  out = out.replace(
    /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
    (_m, prefix: string, value: string) => `${prefix}${convVh(value)}`
  )
  // 2) Inline `style="…"` (the value never reaches a `;`/`}` terminator, so #1 misses it).
  out = out.replace(/style\s*=\s*("|')([\s\S]*?)\1/gi, (match, quote: string, body: string) => {
    if (!/min-height\s*:\s*[^;]*vh/i.test(body)) return match
    const replaced = body.replace(
      /(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi,
      (_m, prefix: string, value: string) => `${prefix}${convVh(value)}`
    )
    return `style=${quote}${replaced}${quote}`
  })
  // 3) JS `element.style.minHeight = "…vh"`.
  out = out.replace(
    /(\.style\.minHeight\s*=\s*("|'))([\s\S]*?)(\2)/gi,
    (match, prefix: string, _q: string, value: string, suffix: string) => {
      if (!/\d+(?:\.\d+)?vh/i.test(value)) return match
      return `${prefix}${convVh(value)}${suffix}`
    }
  )
  // 4) JS `element.style.setProperty('min-height', "…vh")`.
  out = out.replace(
    /(setProperty\s*\(\s*("|')min-height\2\s*,\s*("|'))([\s\S]*?)(\3\s*\))/gi,
    (match, prefix: string, _q1: string, _q2: string, value: string, suffix: string) => {
      if (!/\d+(?:\.\d+)?vh/i.test(value)) return match
      return `${prefix}${convVh(value)}${suffix}`
    }
  )
  return out
}
