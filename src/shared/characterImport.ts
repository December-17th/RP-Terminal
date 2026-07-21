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
  existing: { id: string; name: string }
}

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
