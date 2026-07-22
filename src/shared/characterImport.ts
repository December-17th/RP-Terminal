export interface CharacterImportSummary {
  name: string
  isWorldCard: boolean
  regexScripts: number
  loreEntries: number
  scripts: number
  cardCodeSurfaces: number
  requiresTrust: boolean
  uiWidgets: number
  presets: number
  lorebooks: number
  tableTemplates: number
  pluginsSkipped: number
  assetsImported: number
  cartridgeError?: string
}

export interface CharacterAgentCollision {
  incomingName: string
  /** `builtin` is true when the existing agent is a built-in — the UI disables Replace for it. */
  existing: { id: string; name: string; builtin: boolean }
}

/**
 * Per-collision resolution the user picks in the rename modal:
 *  - `rename`  — install the incoming agent under `newName` (must be unique).
 *  - `skip`    — import the card but do NOT install this agent; the existing agent is untouched.
 *  - `replace` — the incoming agent overwrites the existing colliding agent in place (same id), and
 *                the old agent's run history is deleted (chat history is kept). Not allowed for builtins.
 */
export type CharacterAgentCollisionResolution =
  | { action: 'rename'; newName: string }
  | { action: 'skip' }
  | { action: 'replace' }

/** Resolutions keyed by the colliding incoming agent name. */
export type CharacterAgentResolutions = Record<string, CharacterAgentCollisionResolution>

export type CharacterImportErrorCode =
  | 'INVALID_RENAMES'
  | 'IMPORT_FAILED'
  | 'PARSE_FAILED'
  | 'REQUEST_EXPIRED'

export type CharacterImportDialogResult =
  | { status: 'imported'; id: string; summary: CharacterImportSummary }
  | {
      status: 'agent-collisions'
      token: string
      incomingAgents: string[]
      conflicts: CharacterAgentCollision[]
      requiredRenames: string[]
    }
  | { status: 'invalid-renames'; errorCode: 'INVALID_RENAMES' }
  | { status: 'failed'; errorCode: Exclude<CharacterImportErrorCode, 'INVALID_RENAMES'> }
