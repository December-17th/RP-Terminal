import { create } from 'zustand'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  type: string
  entry: string
  apiVersion: string
  permissions: string[]
  contributes: Record<string, any>
}

export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  enabled: boolean
  grants: string[]
  code: string
  error?: string
}

interface PluginsState {
  plugins: InstalledPlugin[]
  load: (profileId: string) => Promise<void>
  install: (profileId: string) => Promise<string | null>
  installZip: (profileId: string) => Promise<string | null>
  uninstall: (profileId: string, id: string) => Promise<void>
  setEnabled: (profileId: string, id: string, enabled: boolean, grants?: string[]) => Promise<void>
  scaffoldExample: (profileId: string) => Promise<void>
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  plugins: [],
  load: async (profileId) => {
    const plugins = await window.api.pluginsList(profileId)
    set({ plugins })
  },
  install: async (profileId) => {
    const id = await window.api.pluginsInstallDialog()
    if (id) await get().load(profileId)
    return id
  },
  installZip: async (profileId) => {
    const id = await window.api.pluginsInstallZipDialog()
    if (id) await get().load(profileId)
    return id
  },
  uninstall: async (profileId, id) => {
    await window.api.pluginsUninstall(profileId, id)
    await get().load(profileId)
  },
  setEnabled: async (profileId, id, enabled, grants) => {
    await window.api.pluginsSetEnabled(profileId, id, enabled, grants)
    await get().load(profileId)
  },
  scaffoldExample: async (profileId) => {
    await window.api.pluginsScaffoldExample()
    await get().load(profileId)
  }
}))
