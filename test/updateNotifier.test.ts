import { describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  createUpdateNotifier,
  parseStableTag,
  parseStrictVersion,
  UPDATE_CACHE_SCHEMA_VERSION,
  UPDATE_CACHE_TTL_MS,
  validateLatestRelease,
  type UpdateHttpResponse
} from '../src/main/services/updateNotifier'
import { GATED_CHANNELS } from '../src/main/ipc/ipcGuards'
import { setGuardMainWindow } from '../src/main/ipc/ipcGuards'
import { registerUpdateIpc } from '../src/main/ipc/updateIpc'
import { dismissUpdate, visibleUpdate } from '../src/renderer/src/components/updateNoticeModel'

const NOW = 2_000_000_000_000

function githubRelease(version: string): Record<string, unknown> {
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    html_url: `https://github.com/December-17th/RP-Terminal/releases/tag/v${version}`,
    body: '<script>remote content is never retained or rendered</script>'
  }
}

function cache(version: string, checkedAt: number, etag = '"old"'): string {
  return JSON.stringify({
    schemaVersion: UPDATE_CACHE_SCHEMA_VERSION,
    checkedAt,
    etag,
    release: {
      tag: `v${version}`,
      version,
      url: `https://github.com/December-17th/RP-Terminal/releases/tag/v${version}`
    }
  })
}

function harness(options?: {
  packaged?: boolean
  currentVersion?: string
  cached?: string | null
  response?: UpdateHttpResponse
  requestError?: Error
}) {
  let cached = options?.cached ?? null
  const request = vi.fn(async (): Promise<UpdateHttpResponse> => {
    if (options?.requestError) throw options.requestError
    return (
      options?.response ?? {
        status: 200,
        etag: '"new"',
        body: githubRelease('1.2.4')
      }
    )
  })
  const readText = vi.fn(async () => cached)
  const writeTextAtomic = vi.fn(async (_path: string, text: string) => {
    cached = text
  })
  const openExternal = vi.fn(async () => {})
  const warn = vi.fn()
  const isPackaged = vi.fn(() => options?.packaged ?? true)
  const getVersion = vi.fn(() => options?.currentVersion ?? '1.2.3')
  const dataDir = vi.fn(() => 'R:/app-data')
  const notifier = createUpdateNotifier({
    isPackaged,
    getVersion,
    dataDir,
    request,
    readText,
    writeTextAtomic,
    openExternal,
    now: () => NOW,
    warn
  })
  return {
    notifier,
    request,
    readText,
    writeTextAtomic,
    openExternal,
    warn,
    getVersion,
    dataDir,
    cached: () => cached
  }
}

describe('strict update versions and GitHub release validation', () => {
  it('accepts only strict stable versions and tags', () => {
    expect(parseStrictVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseStableTag('v1.2.3')).toEqual([1, 2, 3])
    for (const invalid of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-beta', '1.2.3+build', '1.2.3 ']) {
      expect(parseStrictVersion(invalid)).toBeNull()
    }
    for (const invalid of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-beta', 'vv1.2.3']) {
      expect(parseStableTag(invalid)).toBeNull()
    }
  })

  it('compares all three numeric components', () => {
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBe(1)
    expect(compareVersions([1, 3, 0], [1, 2, 99])).toBe(1)
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(compareVersions([1, 2, 2], [1, 2, 3])).toBe(-1)
  })

  it('accepts only a published stable release with the exact official URL', () => {
    expect(validateLatestRelease(githubRelease('1.2.4'))).toEqual({
      tag: 'v1.2.4',
      version: '1.2.4',
      url: 'https://github.com/December-17th/RP-Terminal/releases/tag/v1.2.4'
    })

    const invalid = [
      { ...githubRelease('1.2.4'), draft: true },
      { ...githubRelease('1.2.4'), prerelease: true },
      { ...githubRelease('1.2.4'), tag_name: 'v1.2.4-beta' },
      {
        ...githubRelease('1.2.4'),
        html_url: 'http://github.com/December-17th/RP-Terminal/releases/tag/v1.2.4'
      },
      {
        ...githubRelease('1.2.4'),
        html_url: 'https://github.com/December-17th/other/releases/tag/v1.2.4'
      },
      {
        ...githubRelease('1.2.4'),
        html_url: 'https://github.com/December-17th/RP-Terminal/releases/tag/v1.2.4?next=evil'
      }
    ]
    for (const value of invalid) expect(validateLatestRelease(value)).toBeNull()
  })
})

describe('update check cache and network behavior', () => {
  it.each([
    ['newer', '1.2.4', { currentVersion: '1.2.3', latestVersion: '1.2.4' }],
    ['equal', '1.2.3', null],
    ['older', '1.2.2', null]
  ])('returns an update only when the release is %s', async (_case, latest, expected) => {
    const h = harness({
      response: { status: 200, etag: '"tag"', body: githubRelease(latest) }
    })
    await expect(h.notifier.check()).resolves.toEqual(expected)
  })

  it('uses a fresh cache for the full 24-hour TTL without network I/O', async () => {
    const h = harness({ cached: cache('1.2.4', NOW - UPDATE_CACHE_TTL_MS + 1) })
    await expect(h.notifier.check()).resolves.toEqual({
      currentVersion: '1.2.3',
      latestVersion: '1.2.4'
    })
    expect(h.request).not.toHaveBeenCalled()
  })

  it('sends the cached ETag and refreshes the cache timestamp on 304', async () => {
    const h = harness({
      cached: cache('1.2.4', NOW - UPDATE_CACHE_TTL_MS, '"old"'),
      response: { status: 304, etag: '"new"' }
    })
    await expect(h.notifier.check()).resolves.toEqual({
      currentVersion: '1.2.3',
      latestVersion: '1.2.4'
    })
    expect(h.request).toHaveBeenCalledWith('"old"')
    expect(JSON.parse(h.cached()!)).toMatchObject({ checkedAt: NOW, etag: '"new"' })
  })

  it('reuses a stale cached newer release while offline', async () => {
    const h = harness({
      cached: cache('1.2.4', NOW - UPDATE_CACHE_TTL_MS - 1),
      requestError: new Error('offline')
    })
    await expect(h.notifier.check()).resolves.toEqual({
      currentVersion: '1.2.3',
      latestVersion: '1.2.4'
    })
    expect(h.warn).toHaveBeenCalledWith('Update notifier check failed', expect.any(Error))
  })

  it('fails soft while offline with no cache', async () => {
    const h = harness({ requestError: new Error('offline') })
    await expect(h.notifier.check()).resolves.toBeNull()
  })

  it('warns, ignores a corrupt cache, and fails soft', async () => {
    const h = harness({ cached: '{"schemaVersion":', requestError: new Error('offline') })
    await expect(h.notifier.check()).resolves.toBeNull()
    expect(h.warn).toHaveBeenCalledWith(
      'Update notifier cache is corrupt and was ignored',
      expect.any(Error)
    )
  })

  it('coalesces concurrent checks into one network request', async () => {
    let resolveRequest!: (response: UpdateHttpResponse) => void
    const request = vi.fn(
      () =>
        new Promise<UpdateHttpResponse>((resolve) => {
          resolveRequest = resolve
        })
    )
    const notifier = createUpdateNotifier({
      isPackaged: () => true,
      getVersion: () => '1.2.3',
      dataDir: () => 'R:/app-data',
      request,
      readText: async () => null,
      writeTextAtomic: async () => {},
      openExternal: async () => {},
      now: () => NOW
    })

    const first = notifier.check()
    const second = notifier.check()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    resolveRequest({ status: 200, etag: null, body: githubRelease('1.2.4') })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { currentVersion: '1.2.3', latestVersion: '1.2.4' },
      { currentVersion: '1.2.3', latestVersion: '1.2.4' }
    ])
  })

  it('does no version, cache, or network work in development', async () => {
    const h = harness({ packaged: false })
    await expect(h.notifier.check()).resolves.toBeNull()
    expect(h.getVersion).not.toHaveBeenCalled()
    expect(h.dataDir).not.toHaveBeenCalled()
    expect(h.readText).not.toHaveBeenCalled()
    expect(h.request).not.toHaveBeenCalled()
  })
})

describe('guarded IPC and release opening safety', () => {
  it('lists both notifier channels in the central sender gate', () => {
    expect(GATED_CHANNELS).toContain('check-for-update')
    expect(GATED_CHANNELS).toContain('open-update-release')
  })

  it('registers gated handlers and never forwards a renderer URL', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = {
      handle: (channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler)
      }
    }
    const notifier = {
      check: vi.fn(async () => null),
      openRelease: vi.fn(async () => true)
    }
    registerUpdateIpc(ipcMain as never, notifier)

    const mainFrame = {}
    const sender = { mainFrame }
    setGuardMainWindow({ webContents: sender, on: () => {} } as never)
    const topFrameEvent = { sender, senderFrame: mainFrame }
    await handlers.get('open-update-release')!(
      topFrameEvent,
      'https://example.com/renderer-controlled'
    )
    expect(notifier.openRelease).toHaveBeenCalledWith()

    await expect(
      handlers.get('check-for-update')!({ sender, senderFrame: {} })
    ).rejects.toMatchObject({ code: 'IPC_SENDER_REJECTED' })
    expect(notifier.check).not.toHaveBeenCalled()
  })

  it('opens only the main-held canonical URL after a validated newer result', async () => {
    const h = harness()
    await h.notifier.check()
    await expect(h.notifier.openRelease()).resolves.toBe(true)
    expect(h.openExternal).toHaveBeenCalledWith(
      'https://github.com/December-17th/RP-Terminal/releases/tag/v1.2.4'
    )
  })

  it('does not open a URL from an invalid response or when no update is newer', async () => {
    const unsafe = harness({
      response: {
        status: 200,
        etag: null,
        body: {
          ...githubRelease('1.2.4'),
          html_url: 'https://example.com/fake-release'
        }
      }
    })
    await unsafe.notifier.check()
    await expect(unsafe.notifier.openRelease()).resolves.toBe(false)
    expect(unsafe.openExternal).not.toHaveBeenCalled()

    const equal = harness({
      response: { status: 200, etag: null, body: githubRelease('1.2.3') }
    })
    await equal.notifier.check()
    await expect(equal.notifier.openRelease()).resolves.toBe(false)
    expect(equal.openExternal).not.toHaveBeenCalled()
  })
})

describe('update banner visibility and dismissal', () => {
  const update = { currentVersion: '1.2.3', latestVersion: '1.2.4' }

  it('shows only an available version not dismissed in this renderer session', () => {
    expect(visibleUpdate(update, null)).toEqual(update)
    expect(visibleUpdate(update, '1.2.3')).toEqual(update)
    expect(visibleUpdate(update, '1.2.4')).toBeNull()
    expect(visibleUpdate(null, null)).toBeNull()
  })

  it('dismisses exactly the displayed latest version', () => {
    expect(dismissUpdate(update)).toBe('1.2.4')
    expect(dismissUpdate(null)).toBeNull()
  })
})
