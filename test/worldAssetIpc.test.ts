import { describe, it, expect } from 'vitest'
import { assetUrlFor } from '../src/main/ipc/worldAssetIpc'

describe('assetUrlFor', () => {
  it('builds an rptasset:// URL with encoded CJK segments', () => {
    const url = assetUrlFor('p1', 'w1', 'character', '爱莎_头像_愤怒.png')
    expect(url).toBe(
      `rptasset://p1/w1/character/${encodeURIComponent('爱莎_头像_愤怒.png')}`
    )
  })
})
