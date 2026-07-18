import { promises as fs } from 'fs'
import path from 'path'

export const UPDATE_RELEASES_URL =
  'https://api.github.com/repos/December-17th/RP-Terminal/releases/latest'
export const UPDATE_CACHE_FILE = 'update-notifier.json'
export const UPDATE_CACHE_SCHEMA_VERSION = 1
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const RELEASE_BASE_URL = 'https://github.com/December-17th/RP-Terminal/releases/tag/'
const REQUEST_TIMEOUT_MS = 10_000
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

type Version = readonly [number, number, number]

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
}

export interface ValidatedRelease {
  tag: string
  version: string
  url: string
}

interface UpdateCache {
  schemaVersion: typeof UPDATE_CACHE_SCHEMA_VERSION
  checkedAt: number
  etag: string | null
  release: ValidatedRelease
}

export interface UpdateHttpResponse {
  status: number
  etag: string | null
  body?: unknown
}

export interface UpdateNotifierDependencies {
  isPackaged: () => boolean
  getVersion: () => string
  dataDir: () => string
  request?: (etag: string | null) => Promise<UpdateHttpResponse>
  readText?: (filePath: string) => Promise<string | null>
  writeTextAtomic?: (filePath: string, text: string) => Promise<void>
  openExternal: (url: string) => Promise<unknown>
  now?: () => number
  warn?: (message: string, error?: unknown) => void
}

export interface UpdateNotifier {
  check: () => Promise<UpdateInfo | null>
  openRelease: () => Promise<boolean>
}

/** Parse the app's strict MAJOR.MINOR.PATCH version. Pre-release/build suffixes are not accepted. */
export function parseStrictVersion(value: string): Version | null {
  const match = STRICT_VERSION.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return null
  return parts as unknown as Version
}

/** Parse the only release-tag shape the notifier trusts: vMAJOR.MINOR.PATCH. */
export function parseStableTag(value: string): Version | null {
  return value.startsWith('v') ? parseStrictVersion(value.slice(1)) : null
}

export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** Reduce an untrusted GitHub response to the three fields the app is allowed to retain. */
export function validateLatestRelease(value: unknown): ValidatedRelease | null {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) return null
  if (typeof value.tag_name !== 'string' || typeof value.html_url !== 'string') return null
  const version = parseStableTag(value.tag_name)
  if (!version) return null
  const canonicalUrl = `${RELEASE_BASE_URL}${value.tag_name}`
  if (value.html_url !== canonicalUrl) return null
  return {
    tag: value.tag_name,
    version: value.tag_name.slice(1),
    url: canonicalUrl
  }
}

export function createUpdateNotifier(deps: UpdateNotifierDependencies): UpdateNotifier {
  const request = deps.request ?? requestLatestRelease
  const readText = deps.readText ?? readTextFile
  const writeTextAtomic = deps.writeTextAtomic ?? writeTextFileAtomic
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? (() => {})
  let inFlight: Promise<UpdateInfo | null> | null = null
  let availableRelease: ValidatedRelease | null = null

  const cachePath = (): string => path.join(deps.dataDir(), UPDATE_CACHE_FILE)

  const readCache = async (): Promise<UpdateCache | null> => {
    let raw: string | null
    try {
      raw = await readText(cachePath())
    } catch (error) {
      warn('Update notifier cache could not be read', error)
      return null
    }
    if (raw === null) return null
    try {
      return validateCache(JSON.parse(raw))
    } catch (error) {
      warn('Update notifier cache is corrupt and was ignored', error)
      return null
    }
  }

  const writeCache = async (cache: UpdateCache): Promise<void> => {
    try {
      await writeTextAtomic(cachePath(), JSON.stringify(cache, null, 2))
    } catch (error) {
      warn('Update notifier cache could not be written', error)
    }
  }

  const resultFor = (release: ValidatedRelease, currentVersion: string): UpdateInfo | null => {
    const current = parseStrictVersion(currentVersion)
    const latest = parseStrictVersion(release.version)
    if (!current || !latest || compareVersions(latest, current) <= 0) {
      availableRelease = null
      return null
    }
    availableRelease = release
    return { currentVersion, latestVersion: release.version }
  }

  const checkOnce = async (): Promise<UpdateInfo | null> => {
    availableRelease = null
    if (!deps.isPackaged()) return null

    const currentVersion = deps.getVersion()
    if (!parseStrictVersion(currentVersion)) {
      warn(`Update notifier ignored invalid app version: ${currentVersion}`)
      return null
    }

    const cache = await readCache()
    const checkedAge = cache ? now() - cache.checkedAt : Number.POSITIVE_INFINITY
    if (cache && checkedAge >= 0 && checkedAge < UPDATE_CACHE_TTL_MS) {
      return resultFor(cache.release, currentVersion)
    }

    try {
      const response = await request(cache?.etag ?? null)
      if (response.status === 304) {
        if (!cache) {
          warn('Update notifier received 304 without a usable cache')
          return null
        }
        const refreshed: UpdateCache = {
          ...cache,
          checkedAt: now(),
          etag: normalizeEtag(response.etag) ?? cache.etag
        }
        await writeCache(refreshed)
        return resultFor(refreshed.release, currentVersion)
      }
      if (response.status !== 200) {
        throw new Error(`GitHub latest-release request returned HTTP ${response.status}`)
      }
      const release = validateLatestRelease(response.body)
      if (!release) throw new Error('GitHub latest-release response failed validation')
      const nextCache: UpdateCache = {
        schemaVersion: UPDATE_CACHE_SCHEMA_VERSION,
        checkedAt: now(),
        etag: normalizeEtag(response.etag),
        release
      }
      await writeCache(nextCache)
      return resultFor(release, currentVersion)
    } catch (error) {
      warn('Update notifier check failed', error)
      return cache ? resultFor(cache.release, currentVersion) : null
    }
  }

  const check = (): Promise<UpdateInfo | null> => {
    if (inFlight) return inFlight
    inFlight = checkOnce().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const openRelease = async (): Promise<boolean> => {
    const release = availableRelease
    if (!deps.isPackaged() || !release) return false
    const current = parseStrictVersion(deps.getVersion())
    const latest = parseStableTag(release.tag)
    if (
      !current ||
      !latest ||
      compareVersions(latest, current) <= 0 ||
      release.url !== `${RELEASE_BASE_URL}${release.tag}`
    ) {
      return false
    }
    try {
      await deps.openExternal(release.url)
      return true
    } catch (error) {
      warn('Update notifier could not open the release page', error)
      return false
    }
  }

  return { check, openRelease }
}

function validateCache(value: unknown): UpdateCache {
  if (
    !isRecord(value) ||
    value.schemaVersion !== UPDATE_CACHE_SCHEMA_VERSION ||
    typeof value.checkedAt !== 'number' ||
    !Number.isFinite(value.checkedAt) ||
    value.checkedAt < 0 ||
    !(value.etag === null || typeof value.etag === 'string') ||
    !isRecord(value.release)
  ) {
    throw new Error('invalid update-cache schema')
  }
  const release = validateLatestRelease({
    draft: false,
    prerelease: false,
    tag_name: value.release.tag,
    html_url: value.release.url
  })
  if (!release || release.version !== value.release.version) {
    throw new Error('invalid cached release')
  }
  return {
    schemaVersion: UPDATE_CACHE_SCHEMA_VERSION,
    checkedAt: value.checkedAt,
    etag: normalizeEtag(value.etag),
    release
  }
}

function normalizeEtag(value: string | null): string | null {
  if (typeof value !== 'string') return null
  const etag = value.trim()
  return etag && etag.length <= 1024 ? etag : null
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestLatestRelease(etag: string | null): Promise<UpdateHttpResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'RP-Terminal',
      'X-GitHub-Api-Version': '2026-03-10'
    }
    if (etag) headers['If-None-Match'] = etag
    const response = await fetch(UPDATE_RELEASES_URL, {
      method: 'GET',
      headers,
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal
    })
    return {
      status: response.status,
      etag: response.headers.get('etag'),
      body: response.status === 200 ? await response.json() : undefined
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeTextFileAtomic(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporaryPath, text, 'utf8')
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {})
    throw error
  }
}
