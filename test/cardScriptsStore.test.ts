import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCardScriptsStore } from '../src/renderer/src/stores/cardScriptsStore'

const pluginSetGrants = vi.fn()

beforeEach(() => {
  pluginSetGrants.mockReset()
  pluginSetGrants.mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { pluginSetGrants } })
  useCardScriptsStore.setState({
    enabledByCard: {},
    trustedByCard: {},
    decidedByCard: {}
  })
})

describe('cardScriptsStore.setTrusted', () => {
  it('persists and locally records an explicit trust grant', async () => {
    await useCardScriptsStore.getState().setTrusted('p1', 'c1', true)

    expect(pluginSetGrants).toHaveBeenCalledWith('p1', 'c1', {
      trusted: true,
      remoteScripts: true,
      decided: true
    })
    expect(useCardScriptsStore.getState().trustedByCard.c1).toBe(true)
    expect(useCardScriptsStore.getState().decidedByCard.c1).toBe(true)
  })

  it('persists and locally records an explicit trust revocation', async () => {
    useCardScriptsStore.setState({ trustedByCard: { c1: true }, decidedByCard: { c1: false } })

    await useCardScriptsStore.getState().setTrusted('p1', 'c1', false)

    expect(pluginSetGrants).toHaveBeenCalledWith('p1', 'c1', {
      trusted: false,
      remoteScripts: false,
      decided: true
    })
    expect(useCardScriptsStore.getState().trustedByCard.c1).toBe(false)
    expect(useCardScriptsStore.getState().decidedByCard.c1).toBe(true)
  })
})
