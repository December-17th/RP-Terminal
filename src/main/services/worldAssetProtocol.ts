import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { resolveProtocolPath } from './worldAssetService'
import { log } from './logService'

export const ASSET_SCHEME = 'rptasset'

/** Parse rptasset://<profileId>/<lorebookId>/<category>/<file> (file may stay percent-encoded). */
export function parseAssetUrl(
  rawUrl: string
): { profileId: string; lorebookId: string; category: string; file: string } | null {
  try {
    const url = new URL(rawUrl)
    const profileId = url.hostname
    const segs = url.pathname.replace(/^\/+/, '').split('/')
    const [lorebookId, category, ...rest] = segs
    const file = rest.join('/')
    if (!profileId || !lorebookId || !category || !file) return null
    return { profileId, lorebookId, category, file }
  } catch {
    return null
  }
}

/** Resolve + stream an rptasset request, or a 4xx/5xx Response. Read-only; traversal rejected in
 *  resolveProtocolPath. Used by BOTH the default-session and WCV-session registrations. */
export function serveAssetRequest(req: {
  url: string
  method?: string
  headers?: Headers
}): Response | Promise<Response> {
  try {
    const parsed = parseAssetUrl(req.url)
    if (!parsed) return new Response('Bad Request', { status: 400 })
    const abs = resolveProtocolPath(
      parsed.profileId,
      parsed.lorebookId,
      parsed.category,
      parsed.file
    )
    if (!abs) return new Response('Not Found', { status: 404 })
    // Preserve Range for MP4 seeking/loop restart. Electron's file fetch produces the corresponding
    // 206/Content-Range response without buffering the whole asset in this handler.
    return net.fetch(pathToFileURL(abs).toString(), {
      method: req.method ?? 'GET',
      headers: req.headers
    })
  } catch (e) {
    log('error', '[world-assets] protocol error', e)
    return new Response('Error', { status: 500 })
  }
}

/** Serve rptasset:// on the DEFAULT session (Asset Manager + inline-iframe card surface). Call after ready. */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (req) => serveAssetRequest(req))
}
