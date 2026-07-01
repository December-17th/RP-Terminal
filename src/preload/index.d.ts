import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: any & {
      backfillUsageMetrics: (profileId: string, chatId: string) => Promise<unknown[]>
      listNodeTypes: () => Promise<
        Array<{
          type: string
          title: string
          inputs: { name: string; type: string }[]
          outputs: { name: string; type: string }[]
          isMainOutputCapable?: boolean
          configSchema?: Record<string, unknown>
        }>
      >
      listWorkflows: (
        profileId: string
      ) => Promise<{ id: string; name: string; description?: string; builtin?: boolean }[]>
      getWorkflow: (profileId: string, id: string) => Promise<unknown>
      saveWorkflow: (
        profileId: string,
        id: string,
        doc: unknown
      ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
      cloneWorkflow: (
        profileId: string,
        sourceId: string
      ) => Promise<{ id: string; name: string; description?: string; builtin?: boolean } | null>
      deleteWorkflow: (profileId: string, id: string) => Promise<boolean>
      getWorkflowSelection: (
        profileId: string
      ) => Promise<{ global: string | null; worlds: Record<string, string> }>
      setGlobalWorkflow: (profileId: string, id: string | null) => Promise<void>
      setWorldWorkflow: (
        profileId: string,
        characterId: string,
        id: string | null
      ) => Promise<void>
      getChatWorkflow: (profileId: string, chatId: string) => Promise<string | null>
      setChatWorkflow: (profileId: string, chatId: string, id: string | null) => Promise<void>
      resolveWorkflowId: (profileId: string, chatId: string) => Promise<string>
      importWorkflowDialog: (
        profileId: string
      ) => Promise<{ ok: true; id: string } | { ok: false; error: string } | null>
      exportWorkflowDialog: (profileId: string, id: string, name: string) => Promise<boolean>
    }
  }
}
