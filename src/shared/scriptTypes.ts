/** Script-library types shared by the main script service and the renderer store/panel. */
import type { ArtifactScope } from './artifactScope'

export interface StoredScript {
  name: string
  code: string
}

export interface ScriptInfo extends StoredScript {
  file: string
  scope: ArtifactScope
  owner?: string
  disabled: boolean
  /** Remote hosts this script imports from (for the grant prompt + CSP). */
  remoteHosts: string[]
}
