import { create } from 'zustand'
import type { ArtifactScope, ScopeContext } from './regexStore'

export type { ArtifactScope, ScopeContext }

export interface ScriptInfo {
  file: string
  name: string
  code: string
  scope: ArtifactScope
  owner?: string
  disabled: boolean
  remoteHosts: string[]
}

interface ScriptsState {
  scripts: ScriptInfo[]
  load: (profileId: string) => Promise<void>
  add: (
    profileId: string,
    script: { name: string; code: string },
    scope: ArtifactScope,
    owner?: string
  ) => Promise<string>
  update: (profileId: string, file: string, patch: { name?: string; code?: string }) => Promise<void>
  setScope: (
    profileId: string,
    file: string,
    scope: ArtifactScope,
    owner?: string
  ) => Promise<void>
  setDisabled: (profileId: string, file: string, disabled: boolean) => Promise<void>
  remove: (profileId: string, file: string) => Promise<void>
}

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  scripts: [],

  load: async (profileId) => {
    const scripts = await window.api.listScripts(profileId)
    set({ scripts: scripts || [] })
  },

  add: async (profileId, script, scope, owner) => {
    const file = await window.api.saveScript(profileId, script, scope, owner)
    await get().load(profileId)
    return file
  },

  update: async (profileId, file, patch) => {
    await window.api.updateScript(profileId, file, patch)
    await get().load(profileId)
  },

  setScope: async (profileId, file, scope, owner) => {
    await window.api.setScriptScope(profileId, file, scope, owner)
    await get().load(profileId)
  },

  setDisabled: async (profileId, file, disabled) => {
    await window.api.setScriptDisabled(profileId, file, disabled)
    await get().load(profileId)
  },

  remove: async (profileId, file) => {
    await window.api.deleteScript(profileId, file)
    await get().load(profileId)
  }
}))
