import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { ensureAvatarThumbAsync } from './characterService'
import { log } from './logService'

export const AVATAR_SCHEME = 'rptavatar'

/** Parse rptavatar://<characterId> — the character id rides in the URL hostname. */
export function parseAvatarUrl(rawUrl: string): { characterId: string } | null {
  try {
    const url = new URL(rawUrl)
    const characterId = url.hostname
    if (!characterId) return null
    return { characterId }
  } catch {
    return null
  }
}

/**
 * Resolve + stream an rptavatar request, or a 4xx/5xx Response. Read-only and fully async: the bounded
 * launcher thumbnail is generated lazily on first request (so pre-existing characters get one without
 * re-import) OFF the hot path, with existence/stat via `fs.promises`, the CPU-bound `nativeImage`
 * decode deferred, and concurrent requests for the same avatar de-duplicated (single-flight). On a
 * generation failure only a small original (≤512KB) is served; a large original 404s rather than
 * breaking the bounded contract. Path traversal is rejected in `ensureAvatarThumbAsync`'s shared
 * avatars-root guard. Mirrors {@link serveAssetRequest}.
 */
export async function serveAvatarRequest(req: { url: string }): Promise<Response> {
  try {
    const parsed = parseAvatarUrl(req.url)
    if (!parsed) return new Response('Bad Request', { status: 400 })
    const abs = await ensureAvatarThumbAsync(parsed.characterId)
    if (!abs) return new Response('Not Found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  } catch (e) {
    log('error', '[avatar] protocol error', e)
    return new Response('Error', { status: 500 })
  }
}

/** Serve rptavatar:// on the DEFAULT session (the launcher runs in the main renderer). Call after ready. */
export function registerAvatarProtocol(): void {
  protocol.handle(AVATAR_SCHEME, (req) => serveAvatarRequest(req))
}
