/**
 * Source rewrites applied to a frontend card's fetched scripts before they run in the
 * process-isolated (opaque) frame — redirecting cross-origin runtime reaches to the
 * frame-local shim.
 *
 * `window.top` / `window.parent` are non-configurable readonly (can't be shadowed) and throw
 * cross-origin in an opaque frame, so a card's `window.top?.SillyTavern…` would die. We rewrite
 * those *qualified* member accesses to plain `window`, where ST_RUNTIME_SHIM injects
 * SillyTavern/Mvu. Only `window.top`/`window.parent` are touched — bare `top`/`parent` are too
 * risky (they collide with ordinary identifiers), and `window.parentNode`/`window.parentElement`
 * are preserved by the `\b` after `parent`.
 *
 * Kept here as a shared constant so the in-frame loader (shims/jquery.ts) and the unit tests use
 * the exact same pattern.
 */
export const STRIP_PARENT_RE = /\bwindow\s*\.\s*(?:top|parent)\b/

export const stripParentRefs = (src: string): string =>
  String(src == null ? '' : src).replace(new RegExp(STRIP_PARENT_RE.source, 'g'), 'window')
