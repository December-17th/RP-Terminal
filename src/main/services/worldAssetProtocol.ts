import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { resolveProtocolPath } from './worldAssetService'
import { log } from './logService'

export const ASSET_SCHEME = 'rptasset'

/** Serve rptasset://<profileId>/<lorebookId>/<category>/<file> from the validated on-disk path.
 *  Read-only; path traversal is rejected by resolveProtocolPath. Call after app `ready`. */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (req) => {
    try {
      const url = new URL(req.url)
      const profileId = url.hostname
      const segs = url.pathname.replace(/^\/+/, '').split('/')
      const [lorebookId, category, ...rest] = segs
      const file = rest.join('/')
      if (!profileId || !lorebookId || !category || !file)
        return new Response('Bad Request', { status: 400 })
      const abs = resolveProtocolPath(profileId, lorebookId, category, file)
      if (!abs) return new Response('Not Found', { status: 404 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch (e) {
      log('error', '[world-assets] protocol error', e)
      return new Response('Error', { status: 500 })
    }
  })
}
