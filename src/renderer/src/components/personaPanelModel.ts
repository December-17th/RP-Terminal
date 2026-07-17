import type { PersonaPreset, Settings } from '../stores/settingsStore'

export interface DuplicatePersonaResult {
  personas: PersonaPreset[]
  active_persona_id: string
  persona: Settings['persona']
}

/** Clone a persona into the settings shape the panel persists. The caller supplies the fresh id so this
 * stays deterministic and testable outside the browser. */
export function duplicatePersona(
  personas: PersonaPreset[],
  active: PersonaPreset,
  id: string
): DuplicatePersonaResult {
  const created: PersonaPreset = { ...active, id }
  return {
    personas: [...personas, created],
    active_persona_id: created.id,
    persona: {
      name: created.name,
      description: created.description,
      inject: created.inject
    }
  }
}
