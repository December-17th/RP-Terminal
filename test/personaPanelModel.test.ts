import { describe, expect, it } from 'vitest'
import { duplicatePersona } from '../src/renderer/src/components/personaPanelModel'
import type { PersonaPreset } from '../src/renderer/src/stores/settingsStore'

describe('duplicatePersona', () => {
  it('clones the active persona under a fresh id, selects it, and refreshes the generation mirror', () => {
    const active: PersonaPreset = {
      id: 'persona-1',
      name: 'Lyra',
      description: 'A quiet cartographer',
      inject: false
    }
    const other: PersonaPreset = {
      id: 'persona-2',
      name: 'Mira',
      description: 'A sailor',
      inject: true
    }

    const result = duplicatePersona([active, other], active, 'persona-3')

    expect(result.personas).toEqual([active, other, { ...active, id: 'persona-3' }])
    expect(result.active_persona_id).toBe('persona-3')
    expect(result.persona).toEqual({
      name: 'Lyra',
      description: 'A quiet cartographer',
      inject: false
    })
    expect(result.personas[0]).toBe(active)
  })
})
