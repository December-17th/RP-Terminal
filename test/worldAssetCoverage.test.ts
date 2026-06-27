import { describe, it, expect } from 'vitest'
import { rosterFromStatData, computeCoverage } from '../src/shared/worldAssets/coverage'
import { AssetCategoryIndex } from '../src/shared/worldAssets/types'

describe('rosterFromStatData', () => {
  it('collects 关系列表 keys + the 主角 name', () => {
    const sd = { 主角: { 姓名: '旅人' }, 关系列表: { 爱莎: { 在场: true }, 凯尔: { 在场: false } } }
    expect(rosterFromStatData(sd).sort()).toEqual(['凯尔', '旅人', '爱莎'])
  })
  it('tolerates missing / malformed stat_data', () => {
    expect(rosterFromStatData(undefined)).toEqual([])
    expect(rosterFromStatData({})).toEqual([])
  })
  it('falls back to 主角.名称 when 姓名 is absent', () => {
    expect(rosterFromStatData({ 主角: { 名称: '游侠' }, 关系列表: { 爱莎: {} } }).sort()).toEqual(['游侠', '爱莎'].sort())
  })
})

describe('computeCoverage', () => {
  const index: AssetCategoryIndex = {
    爱莎: { 头像: { base: 'a.jpg', moods: { 愤怒: 'x.png', 微笑: 'y.png' } }, 立绘: { moods: {} } }
  }
  it('reports avatar/standee/mood-variant coverage and roster membership', () => {
    const rows = computeCoverage(index, ['爱莎', '旅人'])
    const aelia = rows.find((r) => r.name === '爱莎')!
    expect(aelia).toEqual({ name: '爱莎', hasAvatar: true, hasStandee: false, moodVariants: 2, inRoster: true })
    // A roster character with no art still appears, flagged as missing.
    const traveler = rows.find((r) => r.name === '旅人')!
    expect(traveler).toEqual({ name: '旅人', hasAvatar: false, hasStandee: false, moodVariants: 0, inRoster: true })
  })
  it('includes folder-only names (art present, not in roster)', () => {
    const rows = computeCoverage(index, [])
    expect(rows.find((r) => r.name === '爱莎')!.inRoster).toBe(false)
  })
})
