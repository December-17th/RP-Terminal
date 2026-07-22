import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  protocol: { handle: vi.fn() }
}))
vi.mock('../src/main/services/remoteAssetService', () => ({
  REMOTE_ASSET_SCHEME: 'rptremoteasset',
  resolveRemoteAssetSource: mocks.resolve
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import {
  parseRemoteAssetUrl,
  serveRemoteAssetRequest
} from '../src/main/services/remoteAssetProtocol'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReturnValue('https://cdn.example.test/asset.mp4')
})

describe('rptremoteasset URL parsing', () => {
  it('round-trips encoded profile/chat/name without carrying the source URL', () => {
    const raw = `rptremoteasset://asset/${encodeURIComponent('profile one')}/${encodeURIComponent('chat/1')}/${encodeURIComponent('傲 雪')}`
    expect(parseRemoteAssetUrl(raw)).toEqual({
      profileId: 'profile one',
      chatId: 'chat/1',
      name: '傲 雪'
    })
    expect(raw).not.toContain('cdn.example')
  })

  it('rejects another host or a missing scope segment', () => {
    expect(parseRemoteAssetUrl('rptremoteasset://other/p/c/n')).toBeNull()
    expect(parseRemoteAssetUrl('rptremoteasset://asset/p/c')).toBeNull()
  })
})

describe('remote asset streaming', () => {
  it('forwards only a valid byte range and preserves MP4 range response headers', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '3',
          'content-range': 'bytes 4-6/10',
          'accept-ranges': 'bytes'
        }
      })
    )
    const headers = new Headers({ range: 'bytes=4-6', authorization: 'secret' })
    const response = await serveRemoteAssetRequest({
      url: 'rptremoteasset://asset/p/c/name',
      headers
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 4-6/10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    const request = mocks.fetch.mock.calls[0][1]
    expect(request.headers.get('range')).toBe('bytes=4-6')
    expect(request.headers.get('authorization')).toBeNull()
  })

  it('applies the video limit to the total represented by a partial response', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '1',
          'content-range': `bytes 0-0/${256 * 1024 * 1024 + 1}`
        }
      })
    )

    const response = await serveRemoteAssetRequest({
      url: 'rptremoteasset://asset/p/c/name',
      headers: new Headers({ range: 'bytes=0-0' })
    })
    expect(response.status).toBe(413)
  })

  it('permits GIF and rejects non-media responses', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/gif' } })
    )
    await expect(
      serveRemoteAssetRequest({ url: 'rptremoteasset://asset/p/c/name' })
    ).resolves.toMatchObject({ status: 200 })

    mocks.fetch.mockResolvedValueOnce(
      new Response('html', { headers: { 'content-type': 'text/html' } })
    )
    await expect(
      serveRemoteAssetRequest({ url: 'rptremoteasset://asset/p/c/name' })
    ).resolves.toMatchObject({ status: 415 })
  })

  it('rejects malformed ranges before contacting the remote host', async () => {
    const response = await serveRemoteAssetRequest({
      url: 'rptremoteasset://asset/p/c/name',
      headers: new Headers({ range: 'bytes=0-1,4-5' })
    })
    expect(response.status).toBe(416)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('passes an abort signal and maps an upstream timeout to 504', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    mocks.fetch.mockRejectedValueOnce(timeout)

    const response = await serveRemoteAssetRequest({
      url: 'rptremoteasset://asset/p/c/name'
    })
    expect(response.status).toBe(504)
    const call = mocks.fetch.mock.calls[0]
    expect(call[1].signal).toBeInstanceOf(AbortSignal)
  })
})
