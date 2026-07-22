export const REMOTE_CHARACTER_ART_TYPE = '立绘bg' as const

export type RemoteAssetMediaKind = 'image' | 'video'

export interface RemoteAssetDeclaration {
  name: string
  type: typeof REMOTE_CHARACTER_ART_TYPE
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

/** Read the legacy Poem-of-Destiny character visual declarations from a persisted floor variable bag.
 * The legacy `url` has a composed background, so RPT classifies it as `立绘bg` rather than `立绘`.
 * This is deliberately a data read: lorebook JavaScript is never parsed or executed here. */
export function remoteAssetsFromVariables(variables: unknown): RemoteAssetDeclaration[] {
  if (!variables || typeof variables !== 'object') return []
  const visuals = (variables as Record<string, unknown>).char_info_visuals
  if (!visuals || typeof visuals !== 'object' || Array.isArray(visuals)) return []

  const declarations: RemoteAssetDeclaration[] = []
  for (const [rawName, value] of Object.entries(visuals as Record<string, unknown>)) {
    const name = rawName.trim()
    if (!name || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = asHttpsUrl((value as Record<string, unknown>).url)
    if (!source) continue
    declarations.push({
      name,
      type: REMOTE_CHARACTER_ART_TYPE,
      sourceUrl: source.toString(),
      hostname: source.hostname,
      mediaKind: /\.mp4$/i.test(source.pathname) ? 'video' : 'image'
    })
  }
  return declarations
}

export function remoteAssetFromVariables(
  variables: unknown,
  name: string
): RemoteAssetDeclaration | null {
  const wanted = String(name ?? '').trim()
  if (!wanted) return null
  return remoteAssetsFromVariables(variables).find((asset) => asset.name === wanted) ?? null
}

/** Shared transport rule: explicit local assets win; only the legacy background-bearing type may fall
 * back to the latest-floor remote declaration. Explicit `立绘` and every non-character type stay strict. */
export async function localFirstRemoteAssetUrl(
  localUrl: string | null,
  type: string,
  resolveRemote: () => Promise<string | null> | string | null
): Promise<string | null> {
  if (localUrl || type !== REMOTE_CHARACTER_ART_TYPE) return localUrl
  return resolveRemote()
}
