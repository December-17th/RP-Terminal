import { describe, it, expect, vi } from 'vitest'
import {
  splitPipes,
  parseCommand,
  runScript,
  looksLikeStScript,
  StCtx
} from '../src/renderer/src/plugin/stscript'

const makeCtx = (
  vars: Record<string, unknown> = {},
  globals: Record<string, unknown> = {}
): StCtx & {
  fb: ReturnType<typeof vi.fn>
} => {
  const fb = vi.fn(async (cmd: { name: string }) => 'FB:' + cmd.name)
  return { vars, globals, setVar: () => {}, fallback: fb, rng: () => 0, fb }
}

describe('looksLikeStScript', () => {
  it('triggers on pipes or closures, not on a plain command', () => {
    expect(looksLikeStScript('/echo hi | /echo bye')).toBe(true)
    expect(looksLikeStScript('/if left=1 right=1 rule=eq {: /echo y :}')).toBe(true)
    expect(looksLikeStScript('/setvar key value')).toBe(false)
  })
})

describe('splitPipes', () => {
  it('splits on top-level pipes only', () => {
    expect(splitPipes('/a | /b | /c')).toEqual(['/a', '/b', '/c'])
  })
  it('ignores pipes inside quotes and closures', () => {
    expect(splitPipes('/echo "a | b" | /echo c')).toEqual(['/echo "a | b"', '/echo c'])
    expect(splitPipes('/if x {: /echo a | /echo b :} | /echo c')).toEqual([
      '/if x {: /echo a | /echo b :}',
      '/echo c'
    ])
  })
})

describe('parseCommand', () => {
  it('parses name + named args + trailing value', () => {
    expect(parseCommand('/setvar key=hp 100')).toEqual({
      name: 'setvar',
      named: { key: 'hp' },
      value: '100'
    })
  })
  it('parses quoted + closure named values', () => {
    expect(parseCommand('/setvar key=msg value="hello world"')).toEqual({
      name: 'setvar',
      named: { key: 'msg', value: 'hello world' },
      value: ''
    })
    expect(parseCommand('/if left=1 right=1 rule=eq {: /echo hi :}')).toEqual({
      name: 'if',
      named: { left: '1', right: '1', rule: 'eq' },
      value: '{: /echo hi :}'
    })
  })
})

describe('runScript', () => {
  it('threads {{pipe}} between commands', async () => {
    expect(await runScript('/echo hi | /echo {{pipe}}!', makeCtx())).toBe('hi!')
  })

  it('sets and reads variables', async () => {
    const ctx = makeCtx()
    expect(await runScript('/setvar key=hp 100 | /getvar key=hp', ctx)).toBe('100')
    expect(ctx.vars.hp).toBe(100)
  })

  it('adds to a numeric variable', async () => {
    const ctx = makeCtx({ hp: 100 })
    expect(await runScript('/addvar key=hp 5', ctx)).toBe('105')
  })

  it('interpolates {{getvar}} macros in args', async () => {
    expect(await runScript('/echo {{getvar::name}}', makeCtx({ name: 'Mira' }))).toBe('Mira')
  })

  it('runs the then/else closure of /if', async () => {
    expect(await runScript('/if left=1 right=1 rule=eq {: /echo yes :}', makeCtx())).toBe('yes')
    expect(
      await runScript('/if left=1 right=2 rule=eq else={: /echo no :} {: /echo yes :}', makeCtx())
    ).toBe('no')
  })

  it('aborts the pipe, keeping the value so far', async () => {
    expect(await runScript('/echo a | /abort | /echo b', makeCtx())).toBe('a')
  })

  it('delegates unknown commands to the fallback', async () => {
    const ctx = makeCtx()
    expect(await runScript('/gen hello there', ctx)).toBe('FB:gen')
    expect(ctx.fb).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gen', value: 'hello there' }),
      ''
    )
  })
})
