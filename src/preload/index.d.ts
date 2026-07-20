import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: any & {
      checkForUpdate: () => Promise<{
        currentVersion: string
        latestVersion: string
      } | null>
      openUpdateRelease: () => Promise<boolean>
      importCharacterDialog: (
        profileId: string
      ) => Promise<import('../shared/characterImport').CharacterImportDialogResult | null>
      confirmCharacterImport: (
        token: string,
        agentRenames: Record<string, string>
      ) => Promise<import('../shared/characterImport').CharacterImportDialogResult>
      cancelCharacterImport: (token: string) => Promise<{ ok: boolean }>
      getRuntimeScripts: (
        profileId: string,
        cardId: string | null,
        chatId: string | null,
        isolatedRealm?: boolean
      ) => Promise<{
        scripts: import('../shared/scriptTypes').RuntimeScript[]
        remoteHosts: string[]
      }>
      wcvDestroyAwait: (id: string) => Promise<boolean>
      presetSetHighTrust: (profileId: string, presetId: string, on: boolean) => Promise<number>
      backfillUsageMetrics: (profileId: string, chatId: string) => Promise<unknown[]>
      setVnMode: (profileId: string, chatId: string, on: boolean) => Promise<void>
      // Feature 2 — save (session) export/import. export → { name } | { error } | null (cancel);
      // import → { chatId } | { error, worldName? } | null (cancel).
      exportSaveDialog: (
        profileId: string,
        chatId: string
      ) => Promise<{ name: string } | { error: string } | null>
      importSaveDialog: (
        profileId: string
      ) => Promise<{ chatId: string } | { error: string; worldName?: string } | null>
      listAgentRuns: (
        profileId: string,
        chatId: string
      ) => Promise<import('../shared/agentRuntime').AgentRunRecord[]>
      getAgentRun: (
        profileId: string,
        chatId: string,
        invocationId: string
      ) => Promise<import('../shared/agentRuntime').AgentRunRecord | null>
      cancelAgentRun: (
        profileId: string,
        chatId: string,
        invocationId: string
      ) => Promise<import('../shared/agentRuntime').AgentRunCancelResult>
      onAgentRunEvent: (
        cb: (event: import('../shared/agentRuntime').AgentRunEvent) => void
      ) => () => void
      // Agent library management (Agent Workspace). Gated main-side: cards never reach these.
      listAgentCatalog: (
        profileId: string
      ) => Promise<import('../shared/agentRuntime').AgentCatalogSummary[]>
      getAgentDefinition: (
        profileId: string,
        id: string
      ) => Promise<import('../shared/agentRuntime').AgentDefinition | null>
      syncAgentFolder: (
        profileId: string,
        conflicts?: import('../shared/agentRuntime').AgentUpgradeResolution
      ) => Promise<import('../shared/agentRuntime').AgentFolderSync>
      setAgentEnabled: (
        profileId: string,
        id: string,
        enabled: boolean
      ) => Promise<{ ok: boolean; error?: string }>
      deleteAgent: (profileId: string, id: string) => Promise<{ ok: boolean; error?: string }>
      bindAgentRole: (
        profileId: string,
        role: string,
        id: string
      ) => Promise<{ ok: boolean; error?: string }>
      getAgentRoleBindings: (
        profileId: string
      ) => Promise<Record<import('../shared/agentRuntime').AgentRole, string> | null>
      createAgent: (
        profileId: string,
        definition: unknown
      ) => Promise<import('../shared/agentRuntime').AgentMutationResult>
      editAgent: (
        profileId: string,
        id: string,
        definition: unknown
      ) => Promise<import('../shared/agentRuntime').AgentMutationResult>
      restoreAgent: (
        profileId: string,
        id: string
      ) => Promise<import('../shared/agentRuntime').AgentMutationResult>
      exportAgent: (profileId: string, id: string) => Promise<string | null>
      inspectAgentUpgrade: (
        profileId: string,
        id: string
      ) => Promise<import('../shared/agentRuntime').AgentUpgradePreview | null>
      upgradeAgent: (
        profileId: string,
        id: string,
        conflicts?: import('../shared/agentRuntime').AgentUpgradeResolution
      ) => Promise<import('../shared/agentRuntime').AgentMutationResult>
      runAgentManually: (
        profileId: string,
        chatId: string,
        agent: string,
        input?: unknown
      ) => Promise<import('../shared/agentRuntime').AgentManualRunResult>
      getAgentInvocationConfig: (
        profileId: string,
        id: string
      ) => Promise<import('../shared/agentRuntime').AgentInvocationConfig>
      setAgentInvocationConfig: (
        profileId: string,
        id: string,
        config: import('../shared/agentRuntime').AgentInvocationConfig
      ) => Promise<import('../shared/agentRuntime').AgentMutationResult>
      // SQL-table memory (issue 02)
      listTableTemplates: (
        profileId: string
      ) => Promise<Array<{ id: string; name: string; tableCount: number }>>
      getTableTemplate: (profileId: string, id: string) => Promise<unknown>
      updateTableTemplate: (profileId: string, id: string, patch: unknown) => Promise<unknown>
      // Structural template edit + bound-chat migration (Memory-Manager WP4a). `ops` is an ordered
      // list of add/rename/drop table|column ops (shape mirrors main-side `StructureOp`, inlined per
      // the preload convention). Rejects the whole batch on any invalid op WITHOUT applying anything.
      applyTableStructure: (
        profileId: string,
        templateId: string,
        ops: (
          | {
              kind: 'addTable'
              sqlName: string
              displayName?: string
              columns: { name: string; type?: string }[]
            }
          | { kind: 'dropTable'; uid: string }
          | { kind: 'renameTable'; uid: string; sqlName: string; displayName?: string }
          | { kind: 'addColumn'; uid: string; name: string; type?: string }
          | { kind: 'renameColumn'; uid: string; from: string; to: string }
          | { kind: 'dropColumn'; uid: string; name: string }
        )[]
      ) => Promise<
        | {
            ok: true
            tablesChanged: number
            columnsChanged: number
            chatsMigrated: number
            // Chats whose migration failed + rolled back — left on the PREVIOUS schema + old op-log
            // (recoverable; needs a re-sync/retry), NOT half-migrated.
            failedChats: { chatId: string; reason: string }[]
            warnings: string[]
          }
        | { ok: false; error: string }
      >
      // Fan-out preview for the Structure tab's apply confirm (WS6 Phase C): bound-chat count.
      boundChatsForTemplate: (profileId: string, templateId: string) => Promise<number>
      deleteTableTemplate: (
        profileId: string,
        id: string
      ) => Promise<{ ok: true } | { error: string }>
      importTableTemplateDialog: (profileId: string) => Promise<{
        summary?: { id: string; name: string; tableCount: number }
        error?: string
      } | null>
      getChatTableTemplate: (profileId: string, chatId: string) => Promise<string | null>
      setChatTableTemplate: (
        profileId: string,
        chatId: string,
        id: string | null
      ) => Promise<{ ok: true } | { error: string }>
      previewMemoryMaintain: (
        profileId: string,
        chatId: string,
        config: unknown
      ) => Promise<{ messages?: { role: string; content: string }[]; error?: string }>
      // Chunk-committed REFILL (table-refill WS2) — replaces the old append maintainTablesNow. Async +
      // resumable; validation returns `{ ok } | { error }` (a `tables.*` key) and the run streams via
      // onTableBackfillProgress (kind:'refill').
      startTableRefill: (
        profileId: string,
        chatId: string,
        opts: {
          tables?: string[]
          fromFloor?: number
          extraHint?: string
          apiPresetId?: string | null
          retries?: number
          batchSize?: number
        }
      ) => Promise<{ ok: true } | { error: string }>
      cancelTableRefill: (profileId: string, chatId: string) => Promise<void>
      // The effective (widened) refill cutpoint the confirm dialog previews — the engine widens a
      // requested cut DOWN onto a stored multi-floor batch boundary, so the dialog reads this to state
      // the true range. Mirrors the engine's `effectiveRefillFrom`; falls back to the clamped request.
      getTableRefillEffectiveFrom: (
        profileId: string,
        chatId: string,
        tables: string[],
        fromFloor: number | null
      ) => Promise<number>
      getTableRefillState: (
        profileId: string,
        chatId: string
      ) => Promise<{
        run: {
          running: boolean
          batchIndex: number
          batchCount: number
          span: { from: number; to: number } | null
          completedUntil: number
          droppedOutOfScope: number
          failures: Array<{ span: { from: number; to: number }; reason: string }>
        } | null
        persisted: {
          selected: string[]
          fromFloor: number
          completedUntil: number
          status: string
        } | null
      }>
      resumeTableRefill: (
        profileId: string,
        chatId: string,
        extra: {
          apiPresetId?: string | null
          retries?: number
          extraHint?: string
          batchSize?: number
        }
      ) => Promise<{ ok: true } | { error: string }>
      discardTableRefill: (
        profileId: string,
        chatId: string
      ) => Promise<{ ok: true } | { error: string }>
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
      // SQL-table memory history (Memory-Manager WP3): the op-log display projection (newest-first;
      // rewind target = `floor`) + a data-only rewind that drops ops at/after `fromFloor` and rebuilds
      // the sandbox. Shapes inlined per the preload convention.
      listChatTableOps: (
        profileId: string,
        chatId: string
      ) => Promise<
        {
          floor: number
          seq: number
          kind: 'insert' | 'update' | 'delete' | 'other'
          table: string | null
          createdAt: string | null
          // Write-path provenance (WS1 `table_ops.source`); null for legacy rows.
          source: 'maintain' | 'backfill' | 'edit' | 'baseline' | 'refill' | null
        }[]
      >
      rewindChatTables: (
        profileId: string,
        chatId: string,
        fromFloor: number
      ) => Promise<{ ok: true; dropped: number } | { error: string }>
      // Plot-recall notes memory (WP2): the per-chat markdown notes file. `notesGet` → '' when none;
      // `notesSet` with empty/whitespace-only content removes the file (idempotent).
      notesGet: (profileId: string, chatId: string) => Promise<string>
      notesSet: (profileId: string, chatId: string, notes: string) => Promise<void>
      // Plot-recall composed-prompt previews (mirror previewMemoryMaintain).
      previewRecallPlanner: (
        profileId: string,
        chatId: string,
        config: unknown
      ) => Promise<{ messages?: { role: string; content: string }[]; error?: string }>
      previewNotesMaintain: (
        profileId: string,
        chatId: string,
        config: unknown
      ) => Promise<{ messages?: { role: string; content: string }[]; error?: string }>
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
          // table-refill WS2: which manual-fill engine emitted this. Absent ⇒ 'backfill'.
          kind?: 'backfill' | 'refill'
          batchIndex: number
          batchCount: number
          span: { from: number; to: number } | null
          status: 'running' | 'batch-ok' | 'batch-failed' | 'done' | 'cancelled' | 'error'
          message?: string
          completedUntil?: number
        }) => void
      ) => () => void
    }
  }
}
