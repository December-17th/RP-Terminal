import { describe, expect, it } from 'vitest'
import { getCharacterImportText } from '../src/main/ipc/characterImportText'

const details = {
  installedName: 'World',
  installedCreator: 'Ada',
  installedVersion: '1.0',
  incomingName: 'World',
  incomingCreator: 'Ada',
  incomingVersion: '2.0',
  matchCount: 2
}

describe('character import native-dialog text', () => {
  it('localizes destructive replacement messaging for Chinese UI settings', () => {
    const english = getCharacterImportText('en')
    const chinese = getCharacterImportText('zh-CN')

    expect(chinese.duplicateButtons).not.toEqual(english.duplicateButtons)
    expect(chinese.duplicateDetail(details)).toContain('先完整导入新世界')
    expect(chinese.duplicateDetail(details)).toContain('删除')
    expect(english.duplicateDetail(details)).toContain('import the new world first')
    expect(english.bundleItem(1, 'cardCodeSurfaces')).toContain('card-code UI')
    expect(chinese.bundleItem(1, 'cardCodeSurfaces')).toContain('卡片代码界面')
  })

  it('falls back to English for unknown locales', () => {
    expect(getCharacterImportText('fr').install).toBe('Install')
  })
})
