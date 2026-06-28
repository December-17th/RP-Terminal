import { describe, it, expect } from 'vitest'
import { parseAssetUrl } from '../src/main/services/worldAssetProtocol'

describe('parseAssetUrl', () => {
  it('parses host=profileId + lorebookId/category/file', () => {
    expect(parseAssetUrl('rptasset://p1/w1/character/' + encodeURIComponent('爱莎_头像.jpg'))).toEqual({
      profileId: 'p1', lorebookId: 'w1', category: 'character', file: encodeURIComponent('爱莎_头像.jpg')
    })
  })
  it('returns null on a missing segment', () => {
    expect(parseAssetUrl('rptasset://p1/w1')).toBeNull()
  })
  it('returns null on an unparseable url', () => {
    expect(parseAssetUrl('not a url')).toBeNull()
  })
})
