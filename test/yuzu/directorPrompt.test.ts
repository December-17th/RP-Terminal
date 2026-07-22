import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('../../src/main/services/worldAssetService', () => ({
  getIndex: (_profileId: string, lorebookId: string) => {
    if (lorebookId === 'broken') throw new Error('missing')
    if (lorebookId === 'second') {
      return {
        character: {
          无表情角色: { 立绘: { base: 'plain.png', moods: {} } },
          柚子: { 立绘: { moods: { 微笑: 'smile-2.png', 担忧: 'worried.png' } } }
        },
        location: { 天台: { 背景: { moods: {} } } }
      }
    }
    return {
      character: {
        柚子: { 立绘: { moods: { 微笑: 'smile.png' } } },
        枫: { 头像: { moods: { 惊讶: 'surprised.png' } } }
      },
      location: {
        教室: { 背景: { moods: {} } },
        天台: { 全景: { moods: {} } }
      }
    }
  }
}))

import { buildDirectorPrompt } from '../../src/main/services/yuzu/directorPrompt'

describe('Yuzu scene-director prompt', () => {
  // The frozen prompt lives in a tracked fixture, NOT in the implementation plan under
  // docs/superpowers/plans/. All of /docs/** is gitignored (.gitignore:34), so reading the plan
  // here passed locally and failed in CI with ENOENT. Keep the expected text in test/fixtures/.
  it('matches the complete prompt frozen in the implementation plan', () => {
    const frozen = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'yuzu-director-prompt.txt'),
      'utf8'
    )
    expect(buildDirectorPrompt('p', ['first'], '原始回复。')).toBe(
      frozen
        .replace('{{AVAILABLE_LOCATIONS}}', '- 天台\n- 教室')
        .replace('{{ACTORS_AND_EXPRESSIONS}}', '- 枫\n  - 惊讶\n- 柚子\n  - 微笑')
        .replace('{{RAW_NARRATOR_RESPONSE}}', '原始回复。')
    )
  })

  it('is self-contained Chinese guidance with explicit unsupported-command prohibitions', () => {
    const prompt = buildDirectorPrompt('p', ['first'], '原始回复。')
    expect(prompt).toContain('你是 RP Terminal 的 Yuzu 场景导演')
    expect(prompt).toContain('你必须完整保留原始回复')
    expect(prompt).toContain(
      '当前版本禁止使用：`mood`、`music`、`ambience`、`sfx`、`cg`、`choice`、`effect`'
    )
    expect(prompt).toContain('`enter`、`move`')
    expect(prompt).toContain('【原始回复开始】\n原始回复。\n【原始回复结束】')
    expect(prompt).not.toContain('{{')
  })

  it('lists every location and groups sorted, deduplicated expressions under their actor', () => {
    const prompt = buildDirectorPrompt('p', ['second', 'broken', 'first', 'first'], '正文')
    const locations = prompt.match(/【全部可用地点开始】\n([\s\S]*?)\n【全部可用地点结束】/)?.[1]
    const actors = prompt.match(
      /【全部可用角色与表情开始】\n([\s\S]*?)\n【全部可用角色与表情结束】/
    )?.[1]
    expect(locations).toBe('- 天台\n- 教室')
    expect(actors).toBe('- 无表情角色\n- 枫\n  - 惊讶\n- 柚子\n  - 微笑\n  - 担忧')
    expect(actors).not.toContain('neutral')
  })

  it('lists relationship actors without portrait assets as expressionless choices', () => {
    const prompt = buildDirectorPrompt('p', ['first'], '正文', [' 无立绘角色 ', '无立绘角色'])
    expect(prompt).toContain('- 无立绘角色')
    expect(prompt).not.toContain('无立绘角色\n  -')
  })

  it('keeps a lorebook actor’s expressions when the same name also arrives as a generic actor', () => {
    const prompt = buildDirectorPrompt('p', ['first'], '正文', ['柚子', '无立绘角色'])
    const actors = prompt.match(
      /【全部可用角色与表情开始】\n([\s\S]*?)\n【全部可用角色与表情结束】/
    )?.[1]
    expect(actors).toBe('- 无立绘角色\n- 枫\n  - 惊讶\n- 柚子\n  - 微笑')
  })
})
