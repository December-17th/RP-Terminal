import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssetStore, type RemoteAssetEntry } from '../src/renderer/src/stores/assetStore'

// A manually-resolvable promise so each test drives the fetch timing itself.
interface Deferred {
  promise: Promise<RemoteAssetEntry[]>
  resolve: (value: RemoteAssetEntry[]) => void
  reject: (reason?: unknown) => void
}

function makeDeferred(): Deferred {
  let resolve!: (value: RemoteAssetEntry[]) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<RemoteAssetEntry[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const asset = (name: string): RemoteAssetEntry => ({
  name,
  type: '立绘bg',
  sourceUrl: `https://cdn.test/${name}.png`,
  hostname: 'cdn.test',
  mediaKind: 'image',
  url: `rptremoteasset://p/chat/${name}`
})

// Queue of pending fetches: each loadRemote call pulls the next deferred so the test controls it.
let deferreds: Deferred[] = []
const remoteAssetList = vi.fn(() => {
  const d = makeDeferred()
  deferreds.push(d)
  return d.promise
})

// The store singleton keeps closure state (chat key / load seq) across tests, so every case
// establishes its own starting chat with an explicit first call rather than assuming a fresh key.
beforeEach(() => {
  deferreds = []
  remoteAssetList.mockClear()
  vi.stubGlobal('window', { api: { remoteAssetList } })
  useAssetStore.setState({ remoteAssets: [], remoteLoading: false, remoteError: false })
})

const flush = () => new Promise((r) => setTimeout(r, 0))
const loadRemote = (chatId: string | null): Promise<void> =>
  useAssetStore.getState().loadRemote('p', chatId)

describe('assetStore.loadRemote', () => {
  it('(a) populates the list once the first load resolves', async () => {
    const done = loadRemote('chatA')
    expect(useAssetStore.getState().remoteLoading).toBe(true)
    deferreds[0].resolve([asset('Vera')])
    await done
    const s = useAssetStore.getState()
    expect(s.remoteAssets.map((a) => a.name)).toEqual(['Vera'])
    expect(s.remoteLoading).toBe(false)
    expect(s.remoteError).toBe(false)
  })

  it('(b) keeps the previous entries visible while a same-chat refresh is pending', async () => {
    const first = loadRemote('chatB')
    deferreds[0].resolve([asset('Vera'), asset('Mira')])
    await first
    expect(useAssetStore.getState().remoteAssets).toHaveLength(2)

    // Refresh the same chat: the pending fetch must not blank the list.
    const refresh = loadRemote('chatB')
    await flush()
    const mid = useAssetStore.getState()
    expect(mid.remoteAssets.map((a) => a.name)).toEqual(['Vera', 'Mira'])
    expect(mid.remoteLoading).toBe(true)

    deferreds[1].resolve([asset('Vera')])
    await refresh
    expect(useAssetStore.getState().remoteAssets.map((a) => a.name)).toEqual(['Vera'])
  })

  it('(c) clears the list immediately when switching to a different chat', async () => {
    const first = loadRemote('chatC1')
    deferreds[0].resolve([asset('Vera')])
    await first
    expect(useAssetStore.getState().remoteAssets).toHaveLength(1)

    // Switching chats: the list should blank before the new fetch resolves.
    loadRemote('chatC2')
    await flush()
    const mid = useAssetStore.getState()
    expect(mid.remoteAssets).toEqual([])
    expect(mid.remoteLoading).toBe(true)
  })

  it('(d) keeps the previous list and flags an error when a same-chat refresh rejects', async () => {
    const first = loadRemote('chatD')
    deferreds[0].resolve([asset('Vera')])
    await first
    expect(useAssetStore.getState().remoteAssets).toHaveLength(1)

    const refresh = loadRemote('chatD')
    deferreds[1].reject(new Error('network'))
    await refresh
    const s = useAssetStore.getState()
    expect(s.remoteAssets.map((a) => a.name)).toEqual(['Vera'])
    expect(s.remoteError).toBe(true)
    expect(s.remoteLoading).toBe(false)
  })

  it('(e) ignores a stale late response: B wins when A resolves after B', async () => {
    const loadA = loadRemote('chatE')
    const loadB = loadRemote('chatE')
    // B resolves first, then A resolves late — the stale guard must drop A.
    deferreds[1].resolve([asset('Bravo')])
    await loadB
    deferreds[0].resolve([asset('Alpha')])
    await loadA
    expect(useAssetStore.getState().remoteAssets.map((a) => a.name)).toEqual(['Bravo'])
  })
})
