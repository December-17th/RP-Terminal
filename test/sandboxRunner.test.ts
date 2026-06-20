import { describe, it, expect, beforeAll } from 'vitest'
import { getSandbox, runScript } from '../src/main/services/sandboxRunner'
import type { QuickJSWASMModule } from 'quickjs-emscripten'

let mod: QuickJSWASMModule
beforeAll(async () => {
  mod = await getSandbox()
})

describe('sandbox runScript', () => {
  it('runs a script against input and returns its JSON result', () => {
    const r = runScript(mod, { code: 'return input.a + input.b', input: { a: 2, b: 3 } })
    expect(r.ok).toBe(true)
    expect(r.result).toBe(5)
  })

  it('round-trips object/array results', () => {
    const r = runScript(mod, { code: 'return { items: [1, 2], ok: true }' })
    expect(r.result).toEqual({ items: [1, 2], ok: true })
  })

  it('is deterministic for a given seed (rng + Math.random)', () => {
    const code = 'return [rng(), Math.random(), rng()]'
    const a = runScript<number[]>(mod, { code, seed: 42 })
    const b = runScript<number[]>(mod, { code, seed: 42 })
    const c = runScript<number[]>(mod, { code, seed: 7 })
    expect(a.result).toEqual(b.result)
    expect(a.result).not.toEqual(c.result)
    expect(a.result!.every((n) => n >= 0 && n < 1)).toBe(true)
  })

  it('captures emit() events and log() lines in order', () => {
    const r = runScript(mod, {
      code: 'emit({ hp: 5 }); emit("hit"); log("dmg", 7); return null'
    })
    expect(r.events).toEqual([{ hp: 5 }, 'hit'])
    expect(r.logs).toEqual(['dmg 7'])
  })

  it('reports script errors without throwing', () => {
    const r = runScript(mod, { code: 'throw new Error("boom")' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom')
  })

  it('is isolated — no Node/DOM/network globals leak in', () => {
    const r = runScript<string>(mod, {
      code: 'return [typeof process, typeof require, typeof fetch, typeof globalThis.Worker].join(",")'
    })
    expect(r.result).toBe('undefined,undefined,undefined,undefined')
  })

  it('interrupts a runaway script via the wall-clock timeout', () => {
    const r = runScript(mod, { code: 'while (true) {}', timeoutMs: 50 })
    expect(r.ok).toBe(false)
  })
})
