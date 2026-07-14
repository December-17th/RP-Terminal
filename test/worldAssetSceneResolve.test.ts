import { describe, expect, it } from 'vitest'
import { normalizeSceneLocation, resolveSceneAsset } from '../src/shared/worldAssets/sceneResolve'
import type { AssetIndex } from '../src/shared/worldAssets/types'

const locationIndex = (entries: AssetIndex['location']): AssetIndex => ({ location: entries })

describe('normalizeSceneLocation', () => {
  it('normalizes separators, whitespace, Unicode width, case, and trailing punctuation', () => {
    expect(normalizeSceneLocation(' 艾瑟嘉德／宏伟皇宫 — 内廷 > 皇家迎宾偏厅。 ').value).toBe(
      '艾瑟嘉德-宏伟皇宫-内廷-皇家迎宾偏厅'
    )
  })
})

describe('resolveSceneAsset', () => {
  const full = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫-内廷-皇家迎宾偏厅'
  const file = `皇家迎宾偏厅_背景_${full}.png`
  const index = locationIndex({
    皇家迎宾偏厅: { 背景: { moods: { [full]: file } } }
  })

  it('matches the simple final-location filename convention', () => {
    const simpleFile = '皇家迎宾偏厅_背景.png'
    const simple = locationIndex({
      皇家迎宾偏厅: { 背景: { base: simpleFile, moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [simple], location: full, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: simpleFile,
      match: 'leaf',
      matchedSegments: 1
    })
  })

  it('matches selectively included ancestor levels as an ordered hierarchy', () => {
    const selectedName = '奥古斯提姆帝国-宏伟皇宫-皇家迎宾偏厅'
    const selectedFile = `${selectedName}_背景.png`
    const selected = locationIndex({
      [selectedName]: { 背景: { base: selectedFile, moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [selected], location: full, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: selectedFile,
      match: 'hierarchy',
      matchedSegments: 3
    })
  })

  it('prefers the matching filename with more selected hierarchy levels', () => {
    const shortName = '皇家迎宾偏厅'
    const specificName = '艾瑟嘉德-皇家迎宾偏厅'
    const choices = locationIndex({
      [shortName]: { 背景: { base: `${shortName}_背景.png`, moods: {} } },
      [specificName]: { 背景: { base: `${specificName}_背景.png`, moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [choices], location: full, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: `${specificName}_背景.png`,
      matchedSegments: 2
    })
  })

  it('falls back to an authored ancestor when no asset reaches the current location', () => {
    const palaceName = '奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫'
    const palaceFile = `${palaceName}_背景.png`
    const palace = locationIndex({
      [palaceName]: { 背景: { base: palaceFile, moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [palace], location: full, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: palaceFile,
      match: 'hierarchy',
      matchedSegments: 3
    })
  })

  it('prefers the closest ancestor before a broader but longer hierarchy key', () => {
    const broadName = '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-宏伟皇宫'
    const closeName = '内廷'
    const choices = locationIndex({
      [broadName]: { 背景: { base: `${broadName}_背景.png`, moods: {} } },
      [closeName]: { 背景: { base: `${closeName}_背景.png`, moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [choices], location: full, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: `${closeName}_背景.png`
    })
  })

  it('rejects selected hierarchy levels that are out of order or absent from the location', () => {
    const invalid = locationIndex({
      '宏伟皇宫-艾瑟嘉德-皇家迎宾偏厅': {
        背景: { base: 'wrong-order_背景.png', moods: {} }
      },
      '艾瑟嘉德-地下城': { 背景: { base: 'absent_背景.png', moods: {} } }
    })
    expect(resolveSceneAsset({ indexes: [invalid], location: full, type: '背景' })).toEqual({
      status: 'miss'
    })
  })

  it('matches an exact hierarchical alias', () => {
    expect(resolveSceneAsset({ indexes: [index], location: full, type: '背景' })).toEqual({
      status: 'hit',
      indexPos: 0,
      filename: file,
      usedVariant: full,
      match: 'exact-alias',
      matchedSegments: 6
    })
  })

  it('matches a missing-prefix location by its longest suffix', () => {
    const location = '宏伟皇宫-内廷-皇家迎宾偏厅。'
    expect(resolveSceneAsset({ indexes: [index], location, type: '背景' })).toMatchObject({
      status: 'hit',
      filename: file,
      match: 'suffix',
      matchedSegments: 3
    })
  })

  it('accepts a unique final-segment match when an intermediate segment is wrong', () => {
    const location = '艾瑟嘉德-宫殿-皇家迎宾偏厅'
    expect(resolveSceneAsset({ indexes: [index], location, type: '背景' })).toMatchObject({
      status: 'hit',
      match: 'leaf',
      matchedSegments: 1
    })
  })

  it('fails closed when the best leaf match is ambiguous across worlds', () => {
    const other = '西大陆-共和国-王都-皇家迎宾偏厅'
    const otherFile = `皇家迎宾偏厅_背景_${other}.png`
    const otherIndex = locationIndex({
      皇家迎宾偏厅: { 背景: { moods: { [other]: otherFile } } }
    })
    expect(
      resolveSceneAsset({
        indexes: [index, otherIndex],
        location: '未知帝国-皇家迎宾偏厅',
        type: '背景'
      })
    ).toEqual({
      status: 'ambiguous',
      candidates: [file, otherFile],
      matchedSegments: 1
    })
  })

  it('does not treat an ordinary mood variant as a location alias', () => {
    const moodOnly = locationIndex({
      皇家迎宾偏厅: { 背景: { moods: { 夜晚: '皇家迎宾偏厅_背景_夜晚.png' } } }
    })
    expect(
      resolveSceneAsset({ indexes: [moodOnly], location: '内廷-皇家迎宾偏厅', type: '背景' })
    ).toEqual({ status: 'miss' })
  })

  it('does not cross scene types or guess a misspelled final segment', () => {
    expect(resolveSceneAsset({ indexes: [index], location: full, type: '全景' })).toEqual({ status: 'miss' })
    expect(
      resolveSceneAsset({ indexes: [index], location: '内廷-皇家迎宾厅', type: '背景' })
    ).toEqual({ status: 'miss' })
  })
})
