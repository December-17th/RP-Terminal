import { describe, it, expect } from 'vitest'
import { rosterFromStatData, computeCoverage, nameRows } from '../src/shared/worldAssets/coverage'
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
    expect(rosterFromStatData({ 主角: { 名称: '游侠' }, 关系列表: { 爱莎: {} } }).sort()).toEqual(
      ['游侠', '爱莎'].sort()
    )
  })
})

describe('computeCoverage', () => {
  const index: AssetCategoryIndex = {
    爱莎: {
      头像: { base: 'a.jpg', moods: { 愤怒: 'x.png', 微笑: 'y.png' } },
      立绘: { moods: {} },
      立绘bg: { base: 'bg.mp4', moods: { 战斗: 'battle.mp4' } },
      相册: { base: 'cover.png', moods: { '01': 's1.png', '02': 's2.png' } }
    }
  }
  it('reports avatar/standee/mood-variant/gallery coverage and roster membership', () => {
    const rows = computeCoverage(index, ['爱莎', '旅人'])
    const aelia = rows.find((r) => r.name === '爱莎')!
    expect(aelia).toEqual({
      name: '爱莎',
      hasAvatar: true,
      hasStandee: false,
      hasStandeeBg: true,
      hasGallery: true,
      galleryCount: 3, // cover base + 2 slots
      moodVariants: 3, // 头像 + 立绘 + 立绘bg; 相册 slots don't count as moods
      inRoster: true
    })
    // A roster character with no art still appears, flagged as missing.
    const traveler = rows.find((r) => r.name === '旅人')!
    expect(traveler).toEqual({
      name: '旅人',
      hasAvatar: false,
      hasStandee: false,
      hasStandeeBg: false,
      hasGallery: false,
      galleryCount: 0,
      moodVariants: 0,
      inRoster: true
    })
  })
  it('counts slot-only galleries (no cover base) and reports hasGallery', () => {
    const idx: AssetCategoryIndex = { 薇拉: { 相册: { moods: { '01': 'a.png' } } } }
    const row = computeCoverage(idx, [])[0]
    expect(row.hasGallery).toBe(true)
    expect(row.galleryCount).toBe(1)
  })
  it('includes folder-only names (art present, not in roster)', () => {
    const rows = computeCoverage(index, [])
    expect(rows.find((r) => r.name === '爱莎')!.inRoster).toBe(false)
  })
})

describe('nameRows', () => {
  it('rolls a location index into name-sorted per-type rows (no roster concept)', () => {
    const loc: AssetCategoryIndex = {
      王城: { 背景: { base: 'k.png', moods: {} }, 全景: { moods: { 夜: 'n.png' } } },
      雾港: { 全景: { base: 'p.png', moods: {} } }
    }
    expect(nameRows(loc)).toEqual([
      {
        name: '王城',
        types: {
          背景: { hasBase: true, variants: 0 },
          全景: { hasBase: false, variants: 1 }
        }
      },
      { name: '雾港', types: { 全景: { hasBase: true, variants: 0 } } }
    ])
  })
  it('rolls a cg index (scene-keyed, variant stacks)', () => {
    const cg: AssetCategoryIndex = {
      初遇: { CG: { base: '初遇_CG.png', moods: { 雨夜: '初遇_CG_雨夜.png' } } }
    }
    expect(nameRows(cg)).toEqual([
      { name: '初遇', types: { CG: { hasBase: true, variants: 1 } } }
    ])
  })
  it('returns [] for an undefined index', () => {
    expect(nameRows(undefined)).toEqual([])
  })
})
