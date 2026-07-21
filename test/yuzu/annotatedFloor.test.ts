import { describe, expect, it } from 'vitest'
import { parseAnnotatedFloor, stripYuzuDirectives } from '../../src/shared/yuzu/annotatedFloor'

describe('restricted Yuzu annotated floors', () => {
  it('parses ordered blocks and their boundary commands', () => {
    expect(
      parseAnnotatedFloor(
        '<| block |>\n<| bg rooftop |>\n<| 柚子 smile left |>\n第一段。\n<| block |>\n<| 柚子 exit |>\n第二段。\n<| end |>'
      )
    ).toEqual([
      {
        commands: [
          { type: 'bg', location: 'rooftop' },
          { type: 'actor', actor: '柚子', expression: 'smile', position: 'left' }
        ],
        content: '第一段。'
      },
      { commands: [{ type: 'exit', actor: '柚子' }], content: '第二段。' }
    ])
  })

  it('keeps multiline HTML and custom tags opaque inside a block', () => {
    const html = '<gametxt>\n<section data-kind="poem">\n  <b>命定之诗</b>\n</section>\n</gametxt>'
    const parsed = parseAnnotatedFloor(`<| block |>\n${html}\n<| end |>`)
    expect(parsed?.[0].content).toBe(html)
  })

  it('requires a leading block, non-empty content, and a final end', () => {
    expect(parseAnnotatedFloor('prose\n<| block |>\ntext\n<| end |>')).toBeNull()
    expect(parseAnnotatedFloor('<| block |>\n<| bg room |>\n<| end |>')).toBeNull()
    expect(parseAnnotatedFloor('<| block |>\ntext')).toBeNull()
  })

  it.each(['music theme', 'music left', 'cg opening', 'choice Yes :: yes', "effect _.set('hp', 1, 2)"])(
    'rejects unsupported command %s',
    (command) => {
      expect(parseAnnotatedFloor(`<| block |>\ntext\n<| ${command} |>\n<| end |>`)).toBeNull()
    }
  )

  it('strips recognized directives while retaining prose and unsupported lookalikes', () => {
    const text =
      '<| block |>\n<| bg room |>\nBody.\n<| actor smile center |>\n<| music theme |>\n<| end |>'
    expect(stripYuzuDirectives(text)).toBe('Body.\n<| music theme |>')
  })
})
