import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  protocol: { handle: vi.fn() }
}))
vi.mock('../src/main/services/worldAssetService', () => ({
  resolveProtocolPath: vi.fn(() => 'C:\\assets\\scene.mp4')
}))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

import { serveAssetRequest } from '../src/main/services/worldAssetProtocol'

describe('serveAssetRequest MP4 ranges', () => {
  beforeEach(() => fetchMock.mockReset())

  it('forwards method and Range headers to the file fetch', async () => {
    const response = new Response(null, { status: 206 })
    fetchMock.mockResolvedValue(response)
    const headers = new Headers({ Range: 'bytes=1024-' })

    const result = await serveAssetRequest({
      url: 'rptasset://p1/w1/location/scene.mp4',
      method: 'GET',
      headers
    })

    expect(result).toBe(response)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^file:/), {
      method: 'GET',
      headers
    })
  })
})
