import type { AssetType } from '../../../../shared/worldAssets/types'
import type { RemoteAssetEntry } from '../../stores/assetStore'

export function mediaKindForUrl(url: string): 'image' | 'video' {
  const path = decodeURIComponent(url).split(/[?#]/, 1)[0].toLowerCase()
  return path.endsWith('.mp4') ? 'video' : 'image'
}

export async function resolveCharacterPreview(
  resolveLocal: (type: AssetType) => Promise<string | null>,
  remote?: Pick<RemoteAssetEntry, 'url' | 'mediaKind'> | null
): Promise<{ url: string; mediaKind: 'image' | 'video' } | null> {
  for (const type of ['立绘', '立绘bg'] as const) {
    const url = await resolveLocal(type)
    if (url) return { url, mediaKind: mediaKindForUrl(url) }
  }
  if (remote?.url) return { url: remote.url, mediaKind: remote.mediaKind }
  const avatar = await resolveLocal('头像')
  return avatar ? { url: avatar, mediaKind: mediaKindForUrl(avatar) } : null
}
