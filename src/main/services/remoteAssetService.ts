import { getDb } from './db'
import { createHash } from 'crypto'
import * as floorService from './floorService'
import {
  remoteAssetFromVariables,
  remoteAssetsFromVariables,
  type RemoteAssetListItem
} from '../../shared/worldAssets/remote'

export const REMOTE_ASSET_SCHEME = 'rptremoteasset'

export const remoteAssetUrl = (
  profileId: string,
  chatId: string,
  name: string,
  sourceUrl: string
): string => {
  const revision = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 12)
  return `${REMOTE_ASSET_SCHEME}://asset/${encodeURIComponent(profileId)}/${encodeURIComponent(chatId)}/${encodeURIComponent(name)}?v=${revision}`
}

const latestVariables = (profileId: string, chatId: string): Record<string, unknown> | null => {
  // Besides preventing cross-profile reads, this check avoids opening an unrelated per-chat DB when a
  // hand-authored protocol URL carries a stale or invalid scope.
  const chat = getDb()
    .prepare('SELECT 1 AS present FROM chats WHERE id = ? AND profile_id = ?')
    .get(chatId, profileId) as { present: number } | undefined
  if (!chat) return null
  const count = floorService.getFloorCount(profileId, chatId)
  return count ? floorService.getFloor(profileId, chatId, count - 1)?.variables ?? null : null
}

export function listRemoteAssets(profileId: string, chatId: string): RemoteAssetListItem[] {
  const variables = latestVariables(profileId, chatId)
  if (!variables) return []
  return remoteAssetsFromVariables(variables).map((asset) => ({
    ...asset,
    url: remoteAssetUrl(profileId, chatId, asset.name, asset.sourceUrl)
  }))
}

const SOURCE_CACHE_TTL_MS = 3000
const SOURCE_CACHE_MAX_ENTRIES = 128
const sourceCache = new Map<string, { url: string | null; at: number }>()

/** Clear the resolveRemoteAssetSource TTL micro-cache. Test-only seam. */
export function clearRemoteAssetSourceCache(): void {
  sourceCache.clear()
}

export function resolveRemoteAssetSource(
  profileId: string,
  chatId: string,
  name: string
): string | null {
  // A single MP4 playback issues many byte-range protocol requests; this micro-cache spares SQLite the
  // repeated chat-row + latest-floor reads. A staleness window of up to SOURCE_CACHE_TTL_MS against the
  // newest floor is accepted.
  const key = `${profileId} ${chatId} ${name}`
  const now = Date.now()
  const cached = sourceCache.get(key)
  if (cached && now - cached.at < SOURCE_CACHE_TTL_MS) return cached.url

  const variables = latestVariables(profileId, chatId)
  const url = variables ? remoteAssetFromVariables(variables, name)?.sourceUrl ?? null : null

  sourceCache.delete(key)
  sourceCache.set(key, { url, at: now })
  while (sourceCache.size > SOURCE_CACHE_MAX_ENTRIES) {
    const oldest = sourceCache.keys().next().value
    if (oldest === undefined) break
    sourceCache.delete(oldest)
  }
  return url
}

export function resolveRemoteAssetUrl(
  profileId: string,
  chatId: string,
  name: string
): string | null {
  const sourceUrl = resolveRemoteAssetSource(profileId, chatId, name)
  return sourceUrl
    ? remoteAssetUrl(profileId, chatId, String(name ?? '').trim(), sourceUrl)
    : null
}
