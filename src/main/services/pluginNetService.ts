import { getNetAllow } from './pluginHostService'
import { log } from './logService'

/**
 * Opt-in, host-mediated network access (P5, `rpt.net.fetch`). The sandbox itself
 * stays network-closed (CSP `connect-src 'none'`); a plugin's fetch is performed
 * here in main, but ONLY to hostnames in its manifest's `net` allow-list (re-read
 * from disk, never trusted from the renderer), https-only, no redirects, no
 * ambient credentials, with a timeout and a response-size cap. `net` is a
 * sensitive permission the user approves on enable.
 */

const MAX_BYTES = 1_000_000
const TIMEOUT_MS = 15000

export interface NetResult {
  ok: boolean
  status: number
  headers?: Record<string, string>
  body?: string
  error?: string
}

const sanitizeHeaders = (h: any): Record<string, string> => {
  const out: Record<string, string> = {}
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'string' && k.toLowerCase() !== 'host') out[k] = v
    }
  }
  return out
}

export const netFetch = async (pluginId: string, url: string, opts: any): Promise<NetResult> => {
  let u: URL
  try {
    u = new URL(String(url))
  } catch {
    return { ok: false, status: 0, error: 'invalid url' }
  }
  if (u.protocol !== 'https:') return { ok: false, status: 0, error: 'only https:// is allowed' }

  const allow = getNetAllow(pluginId)
  if (!allow.includes(u.hostname)) {
    return { ok: false, status: 0, error: `host not allow-listed: ${u.hostname}` }
  }

  const method = String(opts?.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return { ok: false, status: 0, error: 'only GET/POST are allowed' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(u.toString(), {
      method,
      headers: sanitizeHeaders(opts?.headers),
      body:
        method === 'POST'
          ? typeof opts?.body === 'string'
            ? opts.body
            : JSON.stringify(opts?.body ?? '')
          : undefined,
      redirect: 'manual', // don't auto-follow off the allow-list
      credentials: 'omit',
      signal: controller.signal
    })
    const buf = await res.arrayBuffer()
    const body = new TextDecoder().decode(buf.slice(0, MAX_BYTES))
    log('info', `🌐 plugin ${pluginId} fetched ${u.hostname} → ${res.status}`)
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body
    }
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) }
  } finally {
    clearTimeout(timer)
  }
}
