// src/main/services/cardCodeProtocol.ts
import fs from 'fs'
import path from 'path'

/**
 * Pure request router for the `rpt-card://` scheme (WP0 / A2, serving side). Split out of
 * {@link wcvManager} so the routing, MIME, traversal-guard and trust decisions are unit-testable in
 * plain Node (no electron `session`/`net`/`Response`). `wcvManager` owns the electron glue: it
 * registers the handler, maintains the origin-token registry, injects the trust getter, and turns a
 * {@link CardServeResult} into an electron `Response` (`net.fetch` for file bodies so they stream).
 *
 * Two hosts, one scheme:
 *  - host **`card`** → the legacy shared-origin per-slot inline document (`rpt-card://card/<slotId>`),
 *    served **byte-for-byte unchanged** from the renderer-built slot HTML. NOT trust-gated (the renderer
 *    only builds a slot doc after its own consent gate; a pinned characterization test guards this path).
 *  - host = a **per-card origin token** (D3) → the card's extracted cartridge code, served from
 *    `<appDir>/profiles/<profileId>/card-code/<characterId>/` with a `resolveProtocolPath`-style
 *    traversal guard and the correct MIME (§5). **Main-side trust-gated:** served only when the card's
 *    grant is `decided ∧ trusted`; otherwise 403 (fail-closed — the renderer mount gate is
 *    defense-in-depth, not the boundary).
 */

/** The literal host reserved for the legacy shared-origin inline path (`rpt-card://card/<slotId>`). */
export const LEGACY_HOST = 'card'

/** Empty-slot fallback document — byte-identical to the pre-A2 handler's fallback. */
export const LEGACY_FALLBACK_DOC = '<!doctype html><meta charset="utf-8"><title>card</title>'

/**
 * Extension → Content-Type (WP0 spec §5). Default {@link DEFAULT_CARD_CODE_MIME}; an unknown extension
 * is NEVER served as `text/html` (that forcing is the pre-A2 bug — an ES module served as `text/html`
 * hard-fails the module load).
 */
export const CARD_CODE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

export const DEFAULT_CARD_CODE_MIME = 'application/octet-stream'

/** Content-Type for a request pathname (by extension). */
export const mimeForPath = (pathname: string): string =>
  CARD_CODE_MIME[path.extname(pathname).toLowerCase()] ?? DEFAULT_CARD_CODE_MIME

const isHtmlType = (contentType: string): boolean => /^text\/html/i.test(contentType)

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A card's resolved per-card origin (registry value; also the trust-getter's key). */
export interface CardOrigin {
  profileId: string
  characterId: string
  /** `<appDir>/profiles/<profileId>/card-code/<characterId>/` — the extracted code root. */
  codeDir: string
}

/**
 * Resolve a request pathname to a validated absolute path inside `codeDir`, or `null` when it escapes
 * the root or is not a regular file. Mirrors `worldAssetService.resolveProtocolPath`: decode → resolve
 * → reject anything outside `resolve(codeDir) + sep` → require `isFile()`. A `..`/absolute/`%2e%2e`
 * pathname resolves outside the root and is rejected here even though the URL layer already normalizes.
 */
export const resolveCardCodePath = (codeDir: string, pathname: string): string | null => {
  const decoded = safeDecode(pathname.replace(/^\/+/, ''))
  if (!decoded) return null
  const root = path.resolve(codeDir)
  const abs = path.resolve(root, decoded)
  const base = root + path.sep
  if (abs !== root && !abs.startsWith(base)) return null // escaped the code root
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}

export interface CardServeDeps {
  /** CSP applied to card HTML documents (both the legacy inline doc and per-card `.html` surfaces). */
  cardCsp: string
  /** Legacy per-slot inline doc for host `card` (the `wcvManager` slots map). */
  slotHtml: (slotId: string) => string | undefined
  /** Origin-token registry lookup: token → resolved card, or `null` when the token is unknown. */
  resolveOrigin: (token: string) => CardOrigin | null
  /** Main-side trust gate — `true` only when the card's grant is `decided ∧ trusted`. */
  isTrusted: (origin: CardOrigin) => boolean
}

export type CardServeResult =
  | { kind: 'inline'; html: string; contentType: string; csp: string }
  | { kind: 'file'; absPath: string; contentType: string; csp?: string }
  | { kind: 'error'; status: number; message: string }

/**
 * 404 body when the card's code root is missing or empty — i.e. the cartridge never installed (the
 * import-side extraction failed, or the PNG lost its appended archive in transfer). The error body IS
 * what the WCV panel renders, so it must self-diagnose instead of a bare "Not Found".
 */
export const CODE_NOT_INSTALLED_MESSAGE =
  'Card code not installed — re-import this world from its original full card PNG'

/** 404 body when installed code exists but its filesystem state cannot be inspected safely. */
export const CODE_UNAVAILABLE_MESSAGE =
  'Card code is unavailable — check access to the installed files and try again'

type CodeRootState = 'present' | 'missing' | 'empty' | 'unavailable'

/** Distinguish an absent/empty installation from filesystem failures that need a different remedy. */
const codeRootState = (codeDir: string): CodeRootState => {
  try {
    return fs.readdirSync(codeDir).length === 0 ? 'empty' : 'present'
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unavailable'
  }
}

/**
 * Route a raw `rpt-card://` request URL to a {@link CardServeResult}. Pure: all side-effecting
 * capabilities (slot HTML, the origin registry, the trust getter) arrive via {@link CardServeDeps}.
 */
export const serveCardCode = (rawUrl: string, deps: CardServeDeps): CardServeResult => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'error', status: 400, message: 'Bad Request' }
  }
  const host = url.hostname

  // Legacy shared-origin inline path — unchanged (no trust gate; renderer builds the doc post-consent).
  if (host === LEGACY_HOST) {
    const id = safeDecode(url.pathname.replace(/^\/+/, ''))
    const html = deps.slotHtml(id) ?? LEGACY_FALLBACK_DOC
    return { kind: 'inline', html, contentType: 'text/html; charset=utf-8', csp: deps.cardCsp }
  }

  // Per-card origin: trust-gated, traversal-guarded file serving from the card's extracted code dir.
  const origin = deps.resolveOrigin(host)
  if (!origin) return { kind: 'error', status: 404, message: 'Not Found' }
  // Fail-closed: undecided or untrusted card code is never served (main-side boundary).
  if (!deps.isTrusted(origin)) return { kind: 'error', status: 403, message: 'Forbidden' }
  const abs = resolveCardCodePath(origin.codeDir, url.pathname)
  if (!abs) {
    // Distinguish "no cartridge was ever installed" (the import-side extraction failed / the PNG lost
    // its appended archive) from a merely-missing file in an installed tree, so the panel shows an
    // actionable message. Same 404 status either way; no extra information is exposed (the card's own
    // code is the only requester on this origin).
    const rootState = codeRootState(origin.codeDir)
    const message =
      rootState === 'missing' || rootState === 'empty'
        ? CODE_NOT_INSTALLED_MESSAGE
        : rootState === 'unavailable'
          ? CODE_UNAVAILABLE_MESSAGE
          : 'Not Found'
    return { kind: 'error', status: 404, message }
  }
  const contentType = mimeForPath(abs)
  // HTML documents keep the card CSP; sub-resources are served with their true MIME (no forced html).
  return {
    kind: 'file',
    absPath: abs,
    contentType,
    csp: isHtmlType(contentType) ? deps.cardCsp : undefined
  }
}

const DNS_SAFE = /^[a-z0-9-]{1,255}$/

/**
 * A DNS-safe, stable origin-token derived from a characterId (D3). A URL host on a *standard* scheme is
 * charset-restricted (lowercased, no `_`); RPT mints characterIds via `crypto.randomUUID()` (already
 * DNS-safe) but this must NOT be assumed. A lowercase id matching {@link DNS_SAFE} (and not the reserved
 * legacy host) is used verbatim; anything else maps to a stable `c-<sha1hex>` token. Stable per card so
 * its surfaces share one origin (⇒ shared localStorage / BroadcastChannel — the settings recipe).
 *
 * `sha1` of the id is injected (kept out of this pure module so it stays fs/path-only + fully testable).
 */
export const originTokenFor = (characterId: string, sha1Hex: (s: string) => string): string => {
  const lc = String(characterId).toLowerCase()
  if (lc !== LEGACY_HOST && DNS_SAFE.test(lc) && !lc.startsWith('-') && !lc.endsWith('-')) return lc
  return 'c-' + sha1Hex(characterId)
}
