import { FloorFile } from '../types/chat'
import { buildFloorMetrics } from './promptCacheMetrics'
import { ChatMessage } from './promptBuilder'
import { CumulativeMetric } from '../../shared/usageTypes'
import { getAllFloors, saveFloor } from './floorService'
import { log } from './logService'

/**
 * Pure: recompute the deterministic proxy + cumulative for a floor chain from each floor's
 * stored `request`. Real provider usage is unavailable retroactively, so `usage` stays null
 * (the proxy is still meaningful). Floors that never captured a `request` are left untouched.
 */
export const recomputeMetricsForFloors = (floors: FloorFile[]): FloorFile[] => {
  let prevMessages: ChatMessage[] | null = null
  let prevCumulative: CumulativeMetric | null = null
  return floors.map((f) => {
    if (!f.request) return f
    const metrics = buildFloorMetrics({
      messages: f.request as ChatMessage[],
      prevMessages,
      usage: null,
      provider: f.response.provider || '',
      model: f.response.model || '',
      cacheLevel: f.metrics?.turn.cacheLevel ?? 0,
      l1Mode: f.metrics?.turn.l1Mode ?? 'partition',
      ts: f.timestamp,
      responseText: f.response.content,
      prevCumulative
    })
    prevMessages = f.request as ChatMessage[]
    prevCumulative = metrics.cumulative
    return { ...f, metrics }
  })
}

/**
 * Forward-only backfill: recompute the deterministic proxy metrics for any floor missing them
 * and persist. Real usage isn't recoverable, so backfilled turns show the estimate (proxy) only.
 */
export const backfillUsageMetrics = (profileId: string, chatId: string): FloorFile[] => {
  const floors = getAllFloors(profileId, chatId)
  const recomputed = recomputeMetricsForFloors(floors)
  for (const f of recomputed) if (f.request) saveFloor(profileId, chatId, f)
  log('info', `cache meter — backfilled proxy metrics for ${recomputed.length} floor(s)`)
  return recomputed
}
