import { describe, it, expect } from 'vitest'
import { resolveCardScriptGate } from '../src/renderer/src/components/cardScriptGate'
import {
  resolveRuntimeScriptAuthorization,
  type RuntimeScript,
  type RuntimeScriptAuthorization
} from '../src/shared/scriptTypes'

const s = (name: string, authorization: RuntimeScriptAuthorization): RuntimeScript => ({
  name,
  code: `/* ${name} */`,
  authorization
})
const names = (arr: { name: string }[]): string[] => arr.map((x) => x.name)

describe('resolveCardScriptGate - explicit source authorization', () => {
  it('maps ordinary preset, high-trust preset, and world sources explicitly', () => {
    expect(resolveRuntimeScriptAuthorization('preset')).toBe('import-trust')
    expect(resolveRuntimeScriptAuthorization('preset', true)).toBe('preset-high-trust')
    expect(resolveRuntimeScriptAuthorization('world')).toBe('card-trust')
    expect(resolveRuntimeScriptAuthorization('global')).toBe('import-trust')
    expect(resolveRuntimeScriptAuthorization('session')).toBe('import-trust')
  })

  it('runs ordinary and high-trust preset scripts on an untrusted card', () => {
    const ordinary = s('ordinary-preset', 'import-trust')
    const remote = s('remote-preset', 'preset-high-trust')
    const result = resolveCardScriptGate({
      scripts: [ordinary, remote],
      cardTrusted: false,
      cardDecided: false
    })

    expect(names(result.runScripts)).toEqual(['ordinary-preset', 'remote-preset'])
    expect(result.needsConsent).toBe(false)
  })

  it('withholds only card/world-owned scripts while both preset classes run', () => {
    const result = resolveCardScriptGate({
      scripts: [
        s('card-embedded', 'card-trust'),
        s('ordinary-preset', 'import-trust'),
        s('remote-preset', 'preset-high-trust'),
        s('world-owned', 'card-trust')
      ],
      cardTrusted: false,
      cardDecided: false
    })

    expect(names(result.runScripts)).toEqual(['ordinary-preset', 'remote-preset'])
    expect(result.needsConsent).toBe(true)
  })

  it('runs all source classes once the card is trusted', () => {
    const scripts = [
      s('card-embedded', 'card-trust'),
      s('ordinary-preset', 'import-trust'),
      s('remote-preset', 'preset-high-trust')
    ]
    const result = resolveCardScriptGate({
      scripts,
      cardTrusted: true,
      cardDecided: true
    })

    expect(result.runScripts).toEqual(scripts)
    expect(result.needsConsent).toBe(false)
  })

  it('keeps card code off silently after denial without suppressing preset code', () => {
    const result = resolveCardScriptGate({
      scripts: [
        s('card-embedded', 'card-trust'),
        s('ordinary-preset', 'import-trust'),
        s('remote-preset', 'preset-high-trust')
      ],
      cardTrusted: false,
      cardDecided: true
    })

    expect(names(result.runScripts)).toEqual(['ordinary-preset', 'remote-preset'])
    expect(result.needsConsent).toBe(false)
  })
})
