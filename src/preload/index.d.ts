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
      setWorldWorkflow: (profileId: string, characterId: string, id: string | null) => Promise<void>
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
          // WP4.6: the source version a fork was copied from (null for a root install / legacy fork).
          upstreamVersion: number | null
          builtin: boolean
          manifest: {
            name: string
            description?: string
            creator?: string
            // WP4.6: the minimum RPT version the pack needs (round-trips through export/import).
            minRptVersion?: string
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
          // WP4.6 version coexistence: every installed version of THIS id, ascending (the lineage the
          // UI groups by). Same on every same-id summary; additive (existing consumers ignore it).
          versions: number[]
          // The version pinned to run in the (world, chat) — present only with a world + an open gate.
          activeVersion?: number
        }[]
      >
      // WP4.6: `version` pins which coexisting version this activation runs (written on open).
      setAgentPackGate: (
        packId: string,
        worldId: string,
        chatId: string | null,
        open: boolean,
        version?: number | null
      ) => Promise<void>
      // WP4.6: re-pin which installed version of a pack runs in a world (ADR 0008 — recipes pin
      // versions). Overrides + trigger state carry over. { ok } | { ok:false, code }.
      setAgentPackActiveVersion: (
        profileId: string,
        packId: string,
        version: number,
        worldId: string
      ) => Promise<{ ok: true } | { ok: false; code: 'not-installed' | 'not-activated' }>
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
      // Read-only "why isn't this pack running?" trigger explanation for the Agents "Why?" popover
      // (agent-packs plan WP3.5). Evaluates the pack's MATERIALIZED triggers against committed state
      // WITHOUT advancing baselines or firing (safe to call on popover open; never mutates). Returns []
      // when the pack is not gate-open for the chat (the popover answers from gate state then). Shape
      // inlined (not imported from main) so preload types don't cross the module boundary.
      explainAgentPackTriggers: (
        profileId: string,
        chatId: string,
        packId: string
      ) => Promise<
        {
          description: string
          kind: 'state' | 'cadence' | 'manual'
          met: boolean
          current?: number | string | boolean
          required?: number | string | boolean
          baseline?: number
          lastFireFloor?: number
          floorsUntilDue?: number
        }[]
      >
      // Live trigger badges for the one-canvas editor (one-canvas rebuild WP6.4a): the ENABLED
      // trigger.* NODES of the chat's RESOLVED active doc, explained read-only (never mutates the
      // trigger store). Shape inlined (not imported from main) per the preload convention.
      explainDocTriggers: (
        profileId: string,
        chatId: string
      ) => Promise<
        {
          nodeId: string
          description: string
          met: boolean
          current?: number | string | boolean
          required?: number | string | boolean
        }[]
      >
      // Fire ONE trigger.manual node's chain on explicit user action (RF-01). Guards live main-side
      // (active doc, node kind, disabled) — they log + no-op, never throw.
      runManualTrigger: (
        profileId: string,
        chatId: string,
        docId: string,
        triggerNodeId: string
      ) => Promise<void>
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
          manifest: {
            name: string
            description?: string
            creator?: string
            fork?: { base: string; n: number }
          }
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
          manifest: {
            name: string
            description?: string
            creator?: string
            fork?: { base: string; n: number }
          }
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
      // Is a pack's activation exclusively this world's? (WP4.4; ADR 0006.) True iff every activation
      // row names `worldId`; no activation rows → false (fork-again, the safe default). The
      // Effective-mode edit router consults it so config edits on your own fork survive a restart.
      isAgentPackActivationExclusive: (
        profileId: string,
        packId: string,
        worldId: string
      ) => Promise<boolean>
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
          source: {
            kind: 'narrator' | 'pack' | 'lorebook' | 'memory'
            packId?: string
            name?: string
          }
          tokens: number
          estimated: boolean
          text: string
        }[]
        omitted: {
          label: string
          reason: 'gate' | 'empty' | 'budget'
          source?: {
            kind: 'narrator' | 'pack' | 'lorebook' | 'memory'
            packId?: string
            name?: string
          }
        }[]
        error?: 'no-chat' | 'failed'
        generatedAt: number
      }>
      // Agent-pack SHARING: `.rptagent` export / import (agent-packs plan WP4.2). Shapes inlined (not
      // imported from main) per the established preload convention. `CapabilityId` is the shared shape.
      // Export refuses builtins; import is two-phase (inspect → confirm) for WP4.3's inspection screen.
      previewAgentPackExport: (
        profileId: string,
        packId: string
      ) => Promise<
        | {
            ok: true
            preview: {
              envelopeMeta: { name: string; version: number; creator?: string; sizeBytes: number }
              attachments: { entries: number; rejoins: number; triggers: number }
              capabilityReport: {
                capabilities: import('../shared/workflow/capabilities').CapabilityId[]
                unknownNodeTypes: string[]
                nodesByCapability: Partial<
                  Record<import('../shared/workflow/capabilities').CapabilityId, string[]>
                >
              }
              bundledTemplateNames: string[]
              noTemplatesBundled: boolean
              warnings: string[]
            }
          }
        | {
            ok: false
            error: { code: 'builtin-not-exportable' | 'not-installed'; message: string }
          }
      >
      exportAgentPackDialog: (
        profileId: string,
        packId: string
      ) => Promise<
        | { saved: string }
        | { canceled: true }
        | {
            ok: false
            error: { code: 'builtin-not-exportable' | 'not-installed'; message: string }
          }
      >
      importAgentPackDialog: (profileId: string) => Promise<null | {
        envelopeMeta?: {
          id: string
          name: string
          version: number
          creator?: string
          minRptVersion?: string
          fork?: { base: string; n: number }
        }
        capabilityReport?: {
          capabilities: import('../shared/workflow/capabilities').CapabilityId[]
          unknownNodeTypes: string[]
          nodesByCapability: Partial<
            Record<import('../shared/workflow/capabilities').CapabilityId, string[]>
          >
        }
        bundledTemplatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
        // WP4.6: 'new-version' = same id, a different version installed → installs ALONGSIDE.
        // version-conflict is no longer a blocker (kept in the union below for the dead recovery UI).
        dedupe?: 'new' | 'new-version' | 'already-installed'
        blockers: (
          | { code: 'unknown-node-types'; nodeTypes: string[] }
          | { code: 'version-too-old'; minRptVersion: string; appVersion: string }
          | { code: 'version-conflict'; installedVersion: number }
        )[]
        warnings: string[]
        parseError?: {
          code:
            | 'too-large'
            | 'invalid-json'
            | 'unsupported-version'
            | 'invalid-envelope'
            | 'not-a-fragment'
            | 'invalid-fragment'
          errors?: string[]
          foundVersion?: unknown
        }
        token?: string
      }>
      confirmAgentPackImport: (token: string) => Promise<
        | {
            ok: true
            installed: 'installed' | 'already-installed'
            pack: { id: string; version: number; name: string }
            installedTemplates: { name: string; id: string }[]
          }
        | { ok: false; code: 'expired' }
        | {
            ok: false
            code: 'blocked'
            blockers: (
              | { code: 'unknown-node-types'; nodeTypes: string[] }
              | { code: 'version-too-old'; minRptVersion: string; appVersion: string }
              | { code: 'version-conflict'; installedVersion: number }
            )[]
          }
      >
      cancelAgentPackImport: (token: string) => Promise<void>
      // Module SHARING: `.rptmodule` export / import (one-canvas rebuild WP6.5). Export a GROUP of the
      // (unsaved) doc; import one into the open doc. Shapes inlined (not imported from main) per the
      // established preload convention. Export is previewless; import is two-phase (inspect → confirm).
      exportModuleDialog: (
        profileId: string,
        doc: unknown,
        groupId: string,
        includeTemplate?: unknown
      ) => Promise<
        | { saved: string }
        | { canceled: true }
        | { ok: false; error: { code: 'group-not-found' } }
      >
      importModuleDialog: (profileId: string) => Promise<null | {
        meta?: { name: string; nodeCount: number; description?: string; creator?: string }
        capabilityReport?: {
          capabilities: import('../shared/workflow/capabilities').CapabilityId[]
          unknownNodeTypes: string[]
          nodesByCapability: Partial<
            Record<import('../shared/workflow/capabilities').CapabilityId, string[]>
          >
        }
        templatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
        blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[]
        warnings: string[]
        parseError?: {
          code:
            | 'too-large'
            | 'invalid-json'
            | 'unsupported-version'
            | 'invalid-envelope'
            | 'empty-module'
            | 'external-edge'
            | 'exposed-not-member'
          errors?: string[]
          foundVersion?: unknown
        }
        token?: string
      }>
      confirmModuleImport: (token: string) => Promise<
        | {
            ok: true
            module: {
              name: string
              description?: string
              creator?: string
              nodes: import('../shared/workflow/types').NodeInstance[]
              edges: import('../shared/workflow/types').Edge[]
              exposed?: import('../shared/workflow/types').ExposedGroupSetting[]
              // Agent & memory UX (WP-A): the group's author setup guidance, carried by the envelope.
              note?: string
            }
            installedTemplates: { name: string; id: string }[]
          }
        | { ok: false; code: 'expired' }
        | { ok: false; code: 'blocked'; blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[] }
      >
      cancelModuleImport: (token: string) => Promise<void>
      // Agent library (agent-memory-ux WP-G; spec §2): the palette's Agent-library section — built-in
      // module templates + the per-profile user library. get returns the SAME ModulePayload shape
      // confirmModuleImport does (the renderer feeds it to insertModule); save re-validates main-side.
      listModuleTemplates: (profileId: string) => Promise<
        {
          id: string
          name: string
          description?: string
          nodeCount: number
          source: 'builtin' | 'user'
        }[]
      >
      getModuleTemplate: (
        profileId: string,
        id: string
      ) => Promise<null | {
        name: string
        description?: string
        creator?: string
        nodes: import('../shared/workflow/types').NodeInstance[]
        edges: import('../shared/workflow/types').Edge[]
        exposed?: import('../shared/workflow/types').ExposedGroupSetting[]
        note?: string
      }>
      saveModuleToLibrary: (
        profileId: string,
        module: unknown
      ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
      // Agent & memory UX (WP-H; spec §7): per-world lorebook entry picks for agent.llm's custom lore
      // mode. Keyed (worldId = chat.character_id, docId, nodeId); identity = (book id, entry comment)
      // — our entries carry no uid (plan §0.4 comment fallback). Empty set on write = clear.
      getLorePicks: (
        profileId: string,
        worldId: string,
        docId: string,
        nodeId: string
      ) => Promise<{ book: string; comment: string }[]>
      setLorePicks: (
        profileId: string,
        worldId: string,
        docId: string,
        nodeId: string,
        picks: { book: string; comment: string }[]
      ) => Promise<void>
      // Recipe SHARING: `.rptrecipe` export / import (agent-packs plan WP5.2; ADR 0008) — "share this
      // world's setup". Shapes inlined (not imported from main) per the established preload convention.
      // Export assembles from the CURRENT world; `opts` = the wizard's name/description/creator/id.
      // Import is two-phase (inspect → confirm); the TARGET WORLD is chosen at confirm.
      previewRecipeExport: (
        profileId: string,
        worldId: string,
        opts: { name: string; description?: string; creator?: string; id?: string }
      ) => Promise<
        | {
            ok: true
            preview: {
              recipeMeta: {
                id: string
                name: string
                description?: string
                creator?: string
                sizeBytes: number
              }
              packs: { id: string; version: number; name: string; enabled: boolean }[]
              narratorKind: 'builtin' | 'embedded'
              bundledTemplateNames: string[]
              noTemplatesBundled: boolean
              warnings: string[]
            }
          }
        | { ok: false; error: { code: 'no-activated-packs'; message: string } }
      >
      exportRecipeDialog: (
        profileId: string,
        worldId: string,
        opts: { name: string; description?: string; creator?: string; id?: string }
      ) => Promise<
        | { saved: string }
        | { canceled: true }
        | { ok: false; error: { code: 'no-activated-packs'; message: string } }
      >
      importRecipeDialog: (profileId: string) => Promise<null | {
        recipeMeta?: { id: string; name: string; description?: string; creator?: string }
        packs: {
          id: string
          version: number
          name: string
          dedupe: 'new' | 'new-version' | 'already-installed'
          capabilityReport: {
            capabilities: import('../shared/workflow/capabilities').CapabilityId[]
            unknownNodeTypes: string[]
            nodesByCapability: Partial<
              Record<import('../shared/workflow/capabilities').CapabilityId, string[]>
            >
          }
          unknownNodeTypes: string[]
          warnings: string[]
        }[]
        narrator?: {
          kind: 'builtin' | 'embedded'
          nodeCount?: number
          unknownNodeTypes: string[]
          warnings: string[]
        }
        templatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
        blocked: boolean
        warnings: string[]
        parseError?: {
          code:
            | 'too-large'
            | 'invalid-json'
            | 'unsupported-version'
            | 'invalid-envelope'
            | 'not-a-fragment'
            | 'invalid-fragment'
            | 'invalid-narrator'
            | 'duplicate-pack'
            | 'activation-refers-unknown-pack'
            | 'activation-duplicate-pack'
          errors?: string[]
          foundVersion?: unknown
        }
        token?: string
      }>
      confirmRecipeImport: (
        token: string,
        targetWorldId: string
      ) => Promise<
        | {
            ok: true
            applied: {
              templates: { name: string; id: string }[]
              packs: { id: string; version: number; installed: boolean }[]
              narrator?: { kind: 'builtin' | 'embedded'; workflowId: string }
              activation: { packId: string; version: number; enabled: boolean }[]
            }
          }
        | { ok: false; code: 'expired' }
        | {
            ok: false
            code: 'blocked'
            packs: {
              id: string
              version: number
              name: string
              dedupe: 'new' | 'new-version' | 'already-installed'
              capabilityReport: {
                capabilities: import('../shared/workflow/capabilities').CapabilityId[]
                unknownNodeTypes: string[]
                nodesByCapability: Partial<
                  Record<import('../shared/workflow/capabilities').CapabilityId, string[]>
                >
              }
              unknownNodeTypes: string[]
              warnings: string[]
            }[]
            narrator?: {
              kind: 'builtin' | 'embedded'
              nodeCount?: number
              unknownNodeTypes: string[]
              warnings: string[]
            }
          }
        | {
            ok: false
            code: 'partial'
            applied: {
              templates: { name: string; id: string }[]
              packs: { id: string; version: number; installed: boolean }[]
              narrator?: { kind: 'builtin' | 'embedded'; workflowId: string }
              activation: { packId: string; version: number; enabled: boolean }[]
            }
            failedStep: string
            error: string
          }
      >
      cancelRecipeImport: (token: string) => Promise<void>
      // WP4.6: `version` uninstalls ONE version (omitted = highest installed; last version cascades).
      uninstallAgentPack: (
        profileId: string,
        packId: string,
        version?: number
      ) => Promise<{ ok: true } | { ok: false; code: 'builtin' | 'not-found' }>
      // SQL-table memory (issue 02)
      listTableTemplates: (
        profileId: string
      ) => Promise<Array<{ id: string; name: string; tableCount: number }>>
      getTableTemplate: (profileId: string, id: string) => Promise<unknown>
      updateTableTemplate: (profileId: string, id: string, patch: unknown) => Promise<unknown>
      deleteTableTemplate: (profileId: string, id: string) => Promise<void>
      importTableTemplateDialog: (profileId: string) => Promise<{
        summary?: { id: string; name: string; tableCount: number }
        error?: string
      } | null>
      getChatTableTemplate: (profileId: string, chatId: string) => Promise<string | null>
      setChatTableTemplate: (profileId: string, chatId: string, id: string | null) => Promise<void>
      previewMemoryMaintain: (
        profileId: string,
        chatId: string,
        config: unknown
      ) => Promise<{ messages?: { role: string; content: string }[]; error?: string }>
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
