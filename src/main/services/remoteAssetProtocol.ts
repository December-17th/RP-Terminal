import { net, protocol } from 'electron'
import { log } from './logService'
import {
  REMOTE_ASSET_SCHEME,
  resolveRemoteAssetSource
} from './remoteAssetService'

export { REMOTE_ASSET_SCHEME } from './remoteAssetService'

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])
const VIDEO_MIME_TYPES = new Set(['video/mp4'])
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_VIDEO_BYTES = 256 * 1024 * 1024
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000

export interface RemoteAssetAddress {
  profileId: string
  chatId: string
  name: string
}

/** Parse rptremoteasset://asset/<profileId>/<chatId>/<name>. The source URL is never present here. */
export function parseRemoteAssetUrl(rawUrl: string): RemoteAssetAddress | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== `${REMOTE_ASSET_SCHEME}:` || url.hostname !== 'asset') return null
    const encoded = url.pathname.replace(/^\/+/, '').split('/')
    if (encoded.length !== 3 || encoded.some((segment) => !segment)) return null
    const [profileId, chatId, name] = encoded.map(decodeURIComponent)
    if (!profileId || !chatId || !name) return null
    return { profileId, chatId, name }
  } catch {
    return null
  }
}

const limitedBody = (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): ReadableStream<Uint8Array> | null => {
  if (!body) return null
  let received = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maxBytes) {
          controller.error(new Error('Remote asset exceeds the response size limit'))
          return
        }
        controller.enqueue(chunk)
      }
    })
  )
}

const copyResponseHeaders = (response: Response): Headers => {
  const headers = new Headers()
  for (const key of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ]) {
    const value = response.headers.get(key)
    if (value) headers.set(key, value)
  }
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  return headers
}

/** Resolve the latest-floor declaration and stream it on demand. Only HTTPS images/GIF/MP4 are
 * accepted. Range is the sole caller header forwarded, enabling MP4 seek/replay without exposing
 * cookies, authorization, referrers, or arbitrary request headers to the remote host. */
export async function serveRemoteAssetRequest(req: {
  url: string
  method?: string
  headers?: Headers
}): Promise<Response> {
  try {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 })
    const address = parseRemoteAssetUrl(req.url)
    if (!address) return new Response('Bad Request', { status: 400 })
    const sourceUrl = resolveRemoteAssetSource(address.profileId, address.chatId, address.name)
    if (!sourceUrl) return new Response('Not Found', { status: 404 })

    const headers = new Headers()
    const range = req.headers?.get('range')
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range)) return new Response('Invalid Range', { status: 416 })
      headers.set('range', range)
    }
    const upstream = await net.fetch(sourceUrl, {
      method,
      headers,
      redirect: 'follow',
      credentials: 'omit',
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS)
    })
    if (upstream.url && new URL(upstream.url).protocol !== 'https:') {
      return new Response('Bad Gateway', { status: 502 })
    }
    if (upstream.status === 416) {
      return new Response(null, { status: 416, headers: copyResponseHeaders(upstream) })
    }
    if (!upstream.ok) return new Response('Bad Gateway', { status: 502 })

    const mime = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    const maxBytes = IMAGE_MIME_TYPES.has(mime)
      ? MAX_IMAGE_BYTES
      : VIDEO_MIME_TYPES.has(mime)
        ? MAX_VIDEO_BYTES
        : 0
    if (!maxBytes) return new Response('Unsupported Media Type', { status: 415 })
    const declaredLength = Number(upstream.headers.get('content-length'))
    const contentRange = upstream.headers.get('content-range')
    const rangedTotal = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i)?.[1]
    const totalLength = rangedTotal ? Number(rangedTotal) : declaredLength
    if (Number.isFinite(totalLength) && totalLength > maxBytes) {
      upstream.body?.cancel().catch(() => {})
      return new Response('Content Too Large', { status: 413 })
    }

    return new Response(method === 'HEAD' ? null : limitedBody(upstream.body, maxBytes), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream)
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new Response('Gateway Timeout', { status: 504 })
    }
    log('error', '[remote-assets] protocol error', error)
    return new Response('Bad Gateway', { status: 502 })
  }
}

export function registerRemoteAssetProtocol(): void {
  protocol.handle(REMOTE_ASSET_SCHEME, (req) => serveRemoteAssetRequest(req))
}
