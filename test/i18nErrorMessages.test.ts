import { describe, expect, it } from 'vitest'

import { translate } from '../src/renderer/src/i18n'
import {
  agentErrorMessage,
  agentImportErrorMessage,
  characterImportErrorMessage
} from '../src/renderer/src/i18n/errorMessages'

const inLocale = (locale: 'en' | 'zh') =>
  (key: string, vars?: Record<string, string | number>): string => translate(locale, key, vars)

describe('localized IPC error messages', () => {
  it('translates character-import error codes at the renderer boundary', () => {
    expect(characterImportErrorMessage(inLocale('en'), 'REQUEST_EXPIRED')).toBe(
      'This import request has expired. Start the import again.'
    )
    expect(characterImportErrorMessage(inLocale('zh'), 'REQUEST_EXPIRED')).toBe(
      '此导入请求已过期，请重新开始导入。'
    )
  })

  it('translates Agent mutation and folder-import codes with a localized fallback', () => {
    expect(agentErrorMessage(inLocale('zh'), 'NO_COMMITTED_FLOOR')).toBe(
      '请先打开包含已提交楼层的会话，再运行智能体。'
    )
    expect(agentImportErrorMessage(inLocale('zh'), 'MISSING_RENAME')).toBe(
      '请为每个冲突的智能体选择唯一名称。'
    )
    expect(agentErrorMessage(inLocale('zh'), 'UNRECOGNIZED_ERROR')).toBe('该操作未能完成。')
  })
})
