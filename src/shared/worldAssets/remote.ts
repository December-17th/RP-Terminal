export const REMOTE_CHARACTER_ART_TYPE = '立绘bg' as const
/** General-purpose card art (duel card faces, item icons, skill art) — NOT a character visual. */
export const REMOTE_MISC_ASSET_TYPE = 'misc' as const

/** Which variables bag a remote declaration was read from. Carried in the protocol URL host segment so
 *  the same NAME may exist in both bags without one shadowing the other. */
export type RemoteAssetKind = 'character' | 'misc'
export const REMOTE_ASSET_KINDS: RemoteAssetKind[] = ['character', 'misc']

export type RemoteAssetType = typeof REMOTE_CHARACTER_ART_TYPE | typeof REMOTE_MISC_ASSET_TYPE

/** The floor-variable bag and the asset type each kind maps to. */
const KIND_SPEC: Record<RemoteAssetKind, { variable: string; type: RemoteAssetType }> = {
  character: { variable: 'char_info_visuals', type: REMOTE_CHARACTER_ART_TYPE },
  misc: { variable: 'rpt_misc_assets', type: REMOTE_MISC_ASSET_TYPE }
}

/** The `rptremoteasset://<host>/…` host segment for each kind. `asset` is the pre-existing character
 *  host and must stay byte-identical; `misc` is the second, independent namespace. Single source of
 *  truth for both the minting side (remoteAssetService) and the parsing side (remoteAssetProtocol). */
export const REMOTE_ASSET_URL_HOSTS: Record<RemoteAssetKind, string> = {
  character: 'asset',
  misc: 'misc'
}

export const remoteAssetKindForUrlHost = (hostname: string): RemoteAssetKind | null =>
  REMOTE_ASSET_KINDS.find((kind) => REMOTE_ASSET_URL_HOSTS[kind] === hostname) ?? null

export type RemoteAssetMediaKind = 'image' | 'video'

export interface RemoteAssetDeclaration {
  name: string
  type: RemoteAssetType
  sourceUrl: string
  hostname: string
  mediaKind: RemoteAssetMediaKind
}

export interface RemoteAssetListItem extends RemoteAssetDeclaration {
  url: string
}

const asHttpsUrl = (value: unknown): URL | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/** Read one `{ "<name>": { url } }` declaration bag off a persisted floor variable object.
 * This is deliberately a data read: lorebook JavaScript is never parsed or executed here. */
function declarationsFromBag(
  variables: unknown,
  kind: RemoteAssetKind
): RemoteAssetDeclaration[] {
  if (!variables || typeof variables !== 'object') return []
  const spec = KIND_SPEC[kind]
  const bag = (variables as Record<string, unknown>)[spec.variable]
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return []

  const declarations: RemoteAssetDeclaration[] = []
  for (const [rawName, value] of Object.entries(bag as Record<string, unknown>)) {
    const name = rawName.trim()
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = asHttpsUrl((value as Record<string, unknown>).url)
    if (!source) continue
    declarations.push({
      name,
      type: spec.type,
      sourceUrl: source.toString(),
      hostname: source.hostname,
      mediaKind: /\.mp4$/i.test(source.pathname) ? 'video' : 'image'
    })
  }
  return declarations
}

/** All declarations of one kind, in bag order. */
export function remoteAssetsForKind(
  variables: unknown,
  kind: RemoteAssetKind
): RemoteAssetDeclaration[] {
  return declarationsFromBag(variables, kind)
}

/** One exact name within one kind's bag. */
export function remoteAssetForKind(
  variables: unknown,
  kind: RemoteAssetKind,
  name: string
): RemoteAssetDeclaration | null {
  const wanted = String(name ?? '').trim()
  if (!wanted) return null
  return declarationsFromBag(variables, kind).find((asset) => asset.name === wanted) ?? null
}

/** Which types may fall back to a latest-floor remote declaration when no local file exists, and —
 * critically — WHICH bag each one falls back to. `立绘bg` is the legacy Poem-of-Destiny character
 * visual (`char_info_visuals`, background-bearing, hence `立绘bg` rather than `立绘`); `misc` is the
 * general-purpose card-art namespace (`rpt_misc_assets`). Explicit `立绘` and every other type stay
 * strict. */
const REMOTE_FALLBACK_KIND_BY_TYPE: Record<string, RemoteAssetKind> = {
  [REMOTE_CHARACTER_ART_TYPE]: 'character',
  [REMOTE_MISC_ASSET_TYPE]: 'misc'
}

/** The bag a typed `assetUrl` lookup may fall back into, or null if the type is strict-local. */
export const remoteFallbackKindForType = (type: string): RemoteAssetKind | null =>
  REMOTE_FALLBACK_KIND_BY_TYPE[type] ?? null

/** Shared transport rule: explicit local assets win; only the types above may fall back to the
 * latest-floor remote declaration.
 *
 * `resolveRemote` is HANDED the kind rather than choosing one: every remote resolver defaults to
 * `character` when no kind is passed, so a caller that forgets would silently serve a
 * `char_info_visuals` portrait for a `misc` lookup — the exact cross-namespace shadowing the kind
 * exists to prevent. Taking it as a parameter makes that a type error instead. */
export async function localFirstRemoteAssetUrl(
  localUrl: string | null,
  type: string,
  resolveRemote: (kind: RemoteAssetKind) => Promise<string | null> | string | null
): Promise<string | null> {
  if (localUrl) return localUrl
  const kind = remoteFallbackKindForType(type)
  return kind ? resolveRemote(kind) : null
}
