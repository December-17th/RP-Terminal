import { ElectronAPI } from '@electron-toolkit/preload'
import type { StoredRunRecord } from '../shared/workflow/trace'

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
      listWorkflows: (profileId: string) => Promise<
        {
          id: string
          name: string
          description?: string
          builtin?: boolean
          kind?: 'turn' | 'subgraph'
          invalid?: boolean
        }[]
      >
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
      createWorkflow: (
        profileId: string,
        kind?: 'turn' | 'subgraph'
      ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
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
      onWorkflowTrace: (cb: (trace: unknown) => void) => () => void
      onWorkflowPanel: (
        cb: (p: { chatId: string; nodeId: string; label?: string; delta: string }) => void
      ) => () => void
      onChatModeChanged: (cb: (p: { chatId: string; mode: string }) => void) => () => void
      // Agent-pack library (agent-packs plan WP1.4). `scope` = 'global' | { world: string } |
      // { chat: string } (agentPackStore OverrideScope). WP3.1 extended the list payload (read-only)
      // with each pack's `attachments` (badge structure) + derived `capabilities` (chip row) — both
      // derived main-side from the fragment (agentPackStore.packToSummary); the fragment blob itself
      // never crosses IPC. `AttachmentDecl` / `CapabilityId` are the shared-workflow shapes.
      listAgentPacks: (
        profileId: string,
        worldId?: string | null,
        chatId?: string | null
      ) => Promise<
        {
          id: string
          version: number
          upstreamId: string | null
          builtin: boolean
          manifest: {
            name: string
            description?: string
            creator?: string
            // Creator-exposed settings (agent-packs plan WP3.2). Mirrors agentPackStore.ExposedSetting
            // (crosses IPC as JSON) — inlined so preload types don't import main internals.
            exposedSettings?: {
              id: string
              label: string | Record<string, string>
              type: 'number' | 'string' | 'boolean' | 'enum'
              default: unknown
              min?: number
              max?: number
              options?: string[]
              target: { nodeId: string; path: string }
            }[]
          }
          attachments: import('../shared/workflow/attachments').AttachmentDecl[]
          capabilities: import('../shared/workflow/capabilities').CapabilityId[]
          // Resolved gate for the (worldId, chatId) passed in — undefined when no world context.
          gateOpen?: boolean
        }[]
      >
      setAgentPackGate: (
        packId: string,
        worldId: string,
        chatId: string | null,
        open: boolean
      ) => Promise<void>
      setAgentPackOverride: (
        packId: string,
        scope: 'global' | { world: string } | { chat: string },
        settingId: string,
        value: unknown
      ) => Promise<void>
      clearAgentPackOverride: (
        packId: string,
        scope: 'global' | { world: string } | { chat: string },
        settingId: string
      ) => Promise<boolean>
      resolveAgentPackOverrides: (
        packId: string,
        worldId: string | null,
        chatId: string | null
      ) => Promise<Record<string, unknown>>
      // The detail panel's settings model (agent-packs plan WP3.2): creator-exposed ('pack') + auto-
      // derived System trigger params ('system'), each with its resolved value + provenance (the chip).
      // Assembled main-side (never re-derived from the fragment blob). Null when the pack isn't installed.
      // PackSettingView per setting: schema + resolved state. `kind` = 'pack' (creator-exposed) |
      // 'system' (auto-derived trigger param). Inlined (crosses IPC as JSON; mirrors
      // agentPackService.PackSettingView) so preload types don't import main internals.
      getAgentPackSettings: (
        profileId: string,
        packId: string,
        worldId: string | null,
        chatId: string | null
      ) => Promise<{
        packId: string
        hasTriggers: boolean
        packSettings: {
          id: string
          kind: 'pack' | 'system'
          label?: string | Record<string, string>
          labelKind?: 'trigger-value' | 'trigger-cadence' | 'trigger-table'
          type: 'number' | 'string' | 'boolean' | 'enum'
          default: unknown
          min?: number
          max?: number
          options?: string[]
          resolved: {
            value: unknown
            provenance: 'default' | 'global' | 'world' | 'chat'
            globalValue?: unknown
            worldValue?: unknown
            chatValue?: unknown
          }
        }[]
        systemSettings: {
          id: string
          kind: 'pack' | 'system'
          label?: string | Record<string, string>
          labelKind?: 'trigger-value' | 'trigger-cadence' | 'trigger-table'
          type: 'number' | 'string' | 'boolean' | 'enum'
          default: unknown
          min?: number
          max?: number
          options?: string[]
          resolved: {
            value: unknown
            provenance: 'default' | 'global' | 'world' | 'chat'
            globalValue?: unknown
            worldValue?: unknown
            chatValue?: unknown
          }
        }[]
      } | null>
      // Persisted run history for the Runs timeline (agent-packs plan WP2.3). Newest-first; page
      // backward via `beforeSeq` (the smallest seq of the previous page).
      listAgentPackRuns: (
        profileId: string,
        chatId: string,
        beforeSeq?: number,
        limit?: number
      ) => Promise<StoredRunRecord[]>
      // Effective-graph projection for the Workflow view's Effective mode (agent-packs plan WP3.6a;
      // ADR 0010). The composed doc + composition warnings + per-pack grouping (name / spliced node
      // ids / triggerOnly). A live projection, never persisted (ADR 0001).
      getEffectiveGraph: (
        profileId: string,
        chatId: string
      ) => Promise<{
        doc: import('../shared/workflow/types').WorkflowDoc
        warnings: import('../shared/workflow/compose').ComposeWarning[]
        packs: {
          packId: string
          name: string
          gateOpen: boolean
          nodeIds: string[]
          triggerOnly: boolean
          fork?: { base: string; n: number }
          upstreamId?: string | null
        }[]
      }>
      // Copy-on-edit fork (ADR 0006). Returns the new pack summary; repoints only `worldId`'s
      // activation to the fork. WP3.6a exposes it; WP3.6b routes pack-node edits through it.
      forkAgentPack: (
        profileId: string,
        packId: string,
        worldId: string,
        editedFragment?: unknown
      ) => Promise<{
        ok: boolean
        pack?: {
          id: string
          version: number
          upstreamId: string | null
          builtin: boolean
          manifest: { name: string; description?: string; creator?: string; fork?: { base: string; n: number } }
          attachments: import('../shared/workflow/attachments').AttachmentDecl[]
          capabilities: import('../shared/workflow/capabilities').CapabilityId[]
        }
        error?: string
      }>
      // Fork write-through (ADR 0006; agent-packs plan WP3.6b): replace a non-builtin pack's
      // fragment doc (builtin → refused). Returns a structured result the renderer toasts on failure.
      updateAgentPackFragment: (
        profileId: string,
        packId: string,
        fragment: unknown
      ) => Promise<{
        ok: boolean
        pack?: {
          id: string
          version: number
          upstreamId: string | null
          builtin: boolean
          manifest: { name: string; description?: string; creator?: string; fork?: { base: string; n: number } }
          attachments: import('../shared/workflow/attachments').AttachmentDecl[]
          capabilities: import('../shared/workflow/capabilities').CapabilityId[]
        }
        code?: 'not-found' | 'builtin' | 'invalid'
        error?: string
      }>
      // Read a pack's source fragment doc (WP3.6b) — used to apply an edit to a copy before forking.
      getAgentPackFragment: (
        profileId: string,
        packId: string
      ) => Promise<import('../shared/workflow/types').WorkflowDoc | null>
      // Next-prompt injection preview (agent-packs plan WP3.4): the assembled prompt shaped into
      // per-source sections + an omitted list. A DRY RUN — zero state writes, zero LLM calls. Shape
      // inlined (not imported from main) so preload types don't cross the module boundary.
      previewNextPrompt: (
        profileId: string,
        chatId: string,
        userAction?: string
      ) => Promise<{
        sections: {
          id: string
          label: string
          source: { kind: 'narrator' | 'pack' | 'lorebook' | 'memory'; packId?: string; name?: string }
          tokens: number
          estimated: boolean
          text: string
        }[]
        omitted: {
          label: string
          reason: 'gate' | 'empty' | 'budget'
          source?: { kind: 'narrator' | 'pack' | 'lorebook' | 'memory'; packId?: string; name?: string }
        }[]
        error?: 'no-chat' | 'failed'
        generatedAt: number
      }>
      // SQL-table memory (issue 02)
      listTableTemplates: (
        profileId: string
      ) => Promise<Array<{ id: string; name: string; tableCount: number }>>
      getTableTemplate: (profileId: string, id: string) => Promise<unknown>
      deleteTableTemplate: (profileId: string, id: string) => Promise<void>
      importTableTemplateDialog: (profileId: string) => Promise<
        | { summary?: { id: string; name: string; tableCount: number }; error?: string }
        | null
      >
      getChatTableTemplate: (profileId: string, chatId: string) => Promise<string | null>
      setChatTableTemplate: (
        profileId: string,
        chatId: string,
        id: string | null
      ) => Promise<void>
      readChatTables: (
        profileId: string,
        chatId: string
      ) => Promise<
        Array<{
          sqlName: string
          displayName: string
          columns: string[]
          rows: unknown[][]
          rowids: number[]
        }>
      >
      // SQL-table memory (issue 06)
      editChatTable: (
        profileId: string,
        chatId: string,
        edit: {
          kind: 'cell' | 'insert' | 'delete' | 'reset'
          table: string
          rowid?: number
          columnIndex?: number
          value?: string
          values?: (string | null)[]
        }
      ) => Promise<{ ok: true; changes: number } | { error: string }>
      readChatTablesStatus: (
        profileId: string,
        chatId: string
      ) => Promise<
        Record<
          string,
          {
            lastFloor: number | null
            processed: number
            nextExpected: number
            unprocessed: number
          }
        >
      >
      exportTableTemplateDialog: (
        profileId: string,
        templateId: string,
        chatId?: string | null
      ) => Promise<boolean>
      // SQL-table memory (issue 07): manual backfill from history + progress events
      startTableBackfill: (
        profileId: string,
        chatId: string,
        opts: {
          lastFloors: number | 'all'
          batchSize: number
          apiPresetId?: string | null
          retries?: number
        }
      ) => Promise<{ ok: true } | { error: string }>
      cancelTableBackfill: (profileId: string, chatId: string) => Promise<void>
      getTableBackfillState: (
        profileId: string,
        chatId: string
      ) => Promise<{
        running: boolean
        batchIndex: number
        batchCount: number
        span: { from: number; to: number } | null
        failures: Array<{ span: { from: number; to: number }; reason: string }>
      } | null>
      onTableBackfillProgress: (
        cb: (p: {
          chatId: string
          batchIndex: number
          batchCount: number
          span: { from: number; to: number } | null
          status: 'running' | 'batch-ok' | 'batch-failed' | 'done' | 'cancelled' | 'error'
          message?: string
        }) => void
      ) => () => void
    }
  }
}
