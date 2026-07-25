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

export const MISC_REMOTE_ASSETS_VARIABLE = KIND_SPEC.misc.variable

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

/** Read the legacy Poem-of-Destiny character visual declarations from a persisted floor variable bag.
 * The legacy `url` has a composed background, so RPT classifies it as `立绘bg` rather than `立绘`. */
export function remoteAssetsFromVariables(variables: unknown): RemoteAssetDeclaration[] {
  return declarationsFromBag(variables, 'character')
}

export function remoteAssetFromVariables(
  variables: unknown,
  name: string
): RemoteAssetDeclaration | null {
  return remoteAssetForKind(variables, 'character', name)
}

/** Types allowed to fall back to a latest-floor remote declaration when no local file exists:
 * the legacy background-bearing character type and the general-purpose `misc` type. */
const REMOTE_FALLBACK_TYPES: string[] = [REMOTE_CHARACTER_ART_TYPE, REMOTE_MISC_ASSET_TYPE]

/** Shared transport rule: explicit local assets win; only the types above may fall back to the
 * latest-floor remote declaration. Explicit `立绘` and every other type stay strict. */
export async function localFirstRemoteAssetUrl(
  localUrl: string | null,
  type: string,
  resolveRemote: () => Promise<string | null> | string | null
): Promise<string | null> {
  if (localUrl || !REMOTE_FALLBACK_TYPES.includes(type)) return localUrl
  return resolveRemote()
}
