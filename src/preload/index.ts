import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { VarsOrigin } from '../shared/thRuntime/types'

// Custom APIs for renderer
const api = {
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  createProfile: (name: string) => ipcRenderer.invoke('create-profile', name),
  wipeProfile: (profileId: string) => ipcRenderer.invoke('wipe-profile', profileId),
  getSettings: (profileId: string) => ipcRenderer.invoke('get-settings', profileId),
  saveSettings: (profileId: string, settings: any) =>
    ipcRenderer.invoke('save-settings', profileId, settings),
  listModels: (api: unknown, profileId: string) =>
    ipcRenderer.invoke('list-models', api, profileId),
  getCharacters: (profileId: string) => ipcRenderer.invoke('get-characters', profileId),
  getCharacterAvatar: (characterId: string) =>
    ipcRenderer.invoke('get-character-avatar', characterId),
  setTitlebarOverlay: (overlay: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke('set-titlebar-overlay', overlay),
  saveCharacter: (profileId: string, charId: string, card: any) =>
    ipcRenderer.invoke('save-character', profileId, charId, card),
  importCharacterDialog: (profileId: string) =>
    ipcRenderer.invoke('import-character-dialog', profileId),
  exportCharacterDialog: (profileId: string, characterId: string) =>
    ipcRenderer.invoke('export-character-dialog', profileId, characterId),
  getChats: (profileId: string) => ipcRenderer.invoke('get-chats', profileId),
  createChat: (profileId: string, charId: string) =>
    ipcRenderer.invoke('create-chat', profileId, charId),
  getFloors: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-floors', profileId, chatId),
  backfillUsageMetrics: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('backfill-usage-metrics', profileId, chatId),
  reevaluateVariables: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('reevaluate-variables', profileId, chatId),
  applyVariableOps: (profileId: string, chatId: string, floor: number, ops: unknown[]) =>
    ipcRenderer.invoke('apply-variable-ops', profileId, chatId, floor, ops),
  setFloorStatData: (profileId: string, chatId: string, floor: number, statData: unknown) =>
    ipcRenderer.invoke('variables-set-stat-data', profileId, chatId, floor, statData),
  // WebContentsView card-UI panels (spike): position/lifecycle, fire-and-forget.
  wcvEnsure: (id: string, bounds: unknown, url: string, ctx: unknown) =>
    ipcRenderer.send('wcv-ensure', id, bounds, url, ctx),
  wcvSetBounds: (id: string, bounds: unknown) => ipcRenderer.send('wcv-set-bounds', id, bounds),
  wcvSetVisible: (id: string, visible: boolean) => ipcRenderer.send('wcv-set-visible', id, visible),
  // Hide/show every card WCV (native views paint above the DOM — full-screen overlays need this).
  wcvSetAllVisible: (visible: boolean) => ipcRenderer.send('wcv-set-all-visible', visible),
  // Freeze-frame under a DOM overlay (PM-A4): while WCVs are ducked, main pushes a per-slot bitmap
  // (data URL) to paint into the slot's DOM placeholder so the panels stay visually in place; a
  // clear signal drops them on restore. `onWcvFreeze` returns an unsubscribe function.
  onWcvFreeze: (
    cb: (p: { show: Record<string, string> } | { clear: true }) => void
  ) => {
    const onShow = (_e: unknown, frames: Record<string, string>): void => cb({ show: frames })
    const onClear = (): void => cb({ clear: true })
    ipcRenderer.on('wcv-freeze-show', onShow)
    ipcRenderer.on('wcv-freeze-clear', onClear)
    return () => {
      ipcRenderer.removeListener('wcv-freeze-show', onShow)
      ipcRenderer.removeListener('wcv-freeze-clear', onClear)
    }
  },
  wcvDestroy: (id: string) => ipcRenderer.send('wcv-destroy', id),
  // Full-play-area overlay surfaces (PM-A7). `requestOverlay`/`closeOverlay` back the INLINE card
  // transport (it passes its ctx explicitly; the WCV transport uses the ctx-scoped wcv-host-* channels).
  // `onWcvOverlay` is how the renderer's OverlayHost learns which overlay surface to mount/unmount over
  // the play area — main drives it (single source of truth); Esc / card-switch just call closeOverlay.
  requestOverlay: (profileId: string, chatId: string, characterId: string, overlayId: string) =>
    ipcRenderer.invoke('overlay-request', profileId, chatId, characterId, overlayId),
  closeOverlay: () => ipcRenderer.invoke('overlay-close'),
  onWcvOverlay: (
    cb: (
      p:
        | { open: { overlayId: string; entry: string; title?: string } }
        | { close: { overlayId: string } }
    ) => void
  ) => {
    const onOpen = (
      _e: unknown,
      d: { overlayId: string; entry: string; title?: string }
    ): void => cb({ open: d })
    const onClose = (_e: unknown, d: { overlayId: string }): void => cb({ close: d })
    ipcRenderer.on('wcv-open-overlay', onOpen)
    ipcRenderer.on('wcv-close-overlay', onClose)
    return () => {
      ipcRenderer.removeListener('wcv-open-overlay', onOpen)
      ipcRenderer.removeListener('wcv-close-overlay', onClose)
    }
  },
  // A card-script toolbar button was clicked → deliver it to the chat's card WCVs (the script's eventOn).
  wcvButtonClick: (chatId: string, name: string) =>
    ipcRenderer.send('wcv-button-click', chatId, name),
  // A card wrote/created/deleted a worldbook → refresh the lorebook editor.
  onWcvLorebookChanged: (cb: (p: { id: string }) => void) => {
    const l = (_e: unknown, p: any): void => cb(p)
    ipcRenderer.on('wcv-lorebook-changed', l)
    return () => ipcRenderer.removeListener('wcv-lorebook-changed', l)
  },
  // Card scripts (replaceScriptButtons) → the renderer toolbar feed.
  onWcvCardButtons: (
    cb: (p: {
      slotId: string
      chatId: string
      characterId: string
      buttons: { name: string; visible: boolean }[]
    }) => void
  ) => {
    const l = (_e: unknown, p: any): void => cb(p)
    ipcRenderer.on('wcv-card-buttons', l)
    return () => ipcRenderer.removeListener('wcv-card-buttons', l)
  },
  wcvBroadcastVars: (chatId: string, statData: unknown, origin?: VarsOrigin) =>
    ipcRenderer.send('wcv-broadcast-vars', chatId, statData, origin),
  wcvBroadcastEvent: (chatId: string, name: string, payload: unknown) =>
    ipcRenderer.send('wcv-broadcast-event', chatId, name, payload),
  generate: (profileId: string, chatId: string, userAction: string, source?: 'player' | 'script') =>
    ipcRenderer.invoke('generate', profileId, chatId, userAction, source),
  regenerate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('regenerate', profileId, chatId),
  abortGeneration: (chatId: string) => ipcRenderer.invoke('abort-generation', chatId),
  deleteChat: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('delete-chat', profileId, chatId),
  editFloor: (
    profileId: string,
    chatId: string,
    floorIndex: number,
    userContent: string | null,
    responseContent: string | null
  ) =>
    ipcRenderer.invoke('edit-floor', profileId, chatId, floorIndex, userContent, responseContent),
  // Delete a consecutive tail of floors (fromFloor..latest); rolls back their memory-table + var writes.
  deleteFloorsFrom: (profileId: string, chatId: string, fromFloor: number) =>
    ipcRenderer.invoke('delete-floors-from', profileId, chatId, fromFloor),
  // TavernHelper chat-write (SP3) — the inline card host reaches chatWriteService via these.
  setChatMessages: (profileId: string, chatId: string, messages: unknown) =>
    ipcRenderer.invoke('chat-set-messages', profileId, chatId, messages),
  deleteChatMessages: (profileId: string, chatId: string, ids: unknown) =>
    ipcRenderer.invoke('chat-delete-messages', profileId, chatId, ids),
  saveChat: (profileId: string, chatId: string, chat: unknown) =>
    ipcRenderer.invoke('chat-save', profileId, chatId, chat),
  deleteCharacter: (profileId: string, charId: string) =>
    ipcRenderer.invoke('delete-character', profileId, charId),
  listPresets: (profileId: string) => ipcRenderer.invoke('list-presets', profileId),
  getActivePresetId: (profileId: string) => ipcRenderer.invoke('get-active-preset-id', profileId),
  getActivePreset: (profileId: string) => ipcRenderer.invoke('get-active-preset', profileId),
  getPreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('get-preset', profileId, presetId),
  setActivePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('set-active-preset', profileId, presetId),
  createPreset: (profileId: string, name: string) =>
    ipcRenderer.invoke('create-preset', profileId, name),
  savePreset: (profileId: string, presetId: string, preset: any) =>
    ipcRenderer.invoke('save-preset', profileId, presetId, preset),
  deletePreset: (profileId: string, presetId: string) =>
    ipcRenderer.invoke('delete-preset', profileId, presetId),
  importPresetDialog: (profileId: string) => ipcRenderer.invoke('import-preset-dialog', profileId),
  // Node-workflow graphs (Phase 3 persistence)
  listNodeTypes: () => ipcRenderer.invoke('list-node-types'),
  listWorkflows: (profileId: string) => ipcRenderer.invoke('list-workflows', profileId),
  getWorkflow: (profileId: string, id: string) => ipcRenderer.invoke('get-workflow', profileId, id),
  saveWorkflow: (profileId: string, id: string, doc: unknown) =>
    ipcRenderer.invoke('save-workflow', profileId, id, doc),
  cloneWorkflow: (profileId: string, sourceId: string) =>
    ipcRenderer.invoke('clone-workflow', profileId, sourceId),
  createWorkflow: (profileId: string, kind?: 'turn' | 'subgraph') =>
    ipcRenderer.invoke('create-workflow', profileId, kind),
  deleteWorkflow: (profileId: string, id: string) =>
    ipcRenderer.invoke('delete-workflow', profileId, id),
  getWorkflowSelection: (profileId: string) =>
    ipcRenderer.invoke('get-workflow-selection', profileId),
  setGlobalWorkflow: (profileId: string, id: string | null) =>
    ipcRenderer.invoke('set-global-workflow', profileId, id),
  setWorldWorkflow: (profileId: string, characterId: string, id: string | null) =>
    ipcRenderer.invoke('set-world-workflow', profileId, characterId, id),
  getChatWorkflow: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-chat-workflow', profileId, chatId),
  setChatWorkflow: (profileId: string, chatId: string, id: string | null) =>
    ipcRenderer.invoke('set-chat-workflow', profileId, chatId, id),
  resolveWorkflowId: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('resolve-workflow-id', profileId, chatId),
  importWorkflowDialog: (profileId: string) =>
    ipcRenderer.invoke('import-workflow-dialog', profileId),
  exportWorkflowDialog: (profileId: string, id: string, name: string) =>
    ipcRenderer.invoke('export-workflow-dialog', profileId, id, name),
  // Per-turn workflow run trace (spec §13 run/trace panel). Returns an unsubscribe function.
  onWorkflowTrace: (cb: (trace: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, trace: unknown): void => cb(trace)
    ipcRenderer.on('workflow-trace', listener)
    return () => ipcRenderer.removeListener('workflow-trace', listener)
  },
  // Opt-in node output panel deltas (spec D4 collapsible chat panels). Returns an unsubscribe.
  onWorkflowPanel: (
    cb: (p: { chatId: string; nodeId: string; label?: string; delta: string }) => void
  ) => {
    const listener = (_e: IpcRendererEvent, p: any): void => cb(p)
    ipcRenderer.on('workflow-panel', listener)
    return () => ipcRenderer.removeListener('workflow-panel', listener)
  },
  // Agent-pack library (agent-packs plan WP1.4): list + per-world gate + exposed-setting overrides.
  // `scope` is 'global' | { world } | { chat } (agentPackStore OverrideScope).
  listAgentPacks: (profileId: string, worldId?: string | null, chatId?: string | null) =>
    ipcRenderer.invoke('agent-packs-list', profileId, worldId, chatId),
  // WP4.6: `version` pins which coexisting version this activation runs (written on open; omitted =
  // leave any existing pin / fall back to the highest installed version at resolve time).
  setAgentPackGate: (
    packId: string,
    worldId: string,
    chatId: string | null,
    open: boolean,
    version?: number | null
  ) => ipcRenderer.invoke('agent-pack-set-gate', packId, worldId, chatId, open, version),
  // WP4.6: re-pin which installed version of a pack runs in a world ("activate what the recipe
  // pinned", ADR 0008). Overrides + trigger state carry over. Returns { ok } | { ok:false, code }.
  setAgentPackActiveVersion: (
    profileId: string,
    packId: string,
    version: number,
    worldId: string
  ) => ipcRenderer.invoke('agent-pack-set-active-version', profileId, packId, version, worldId),
  setAgentPackOverride: (packId: string, scope: unknown, settingId: string, value: unknown) =>
    ipcRenderer.invoke('agent-pack-set-override', packId, scope, settingId, value),
  clearAgentPackOverride: (packId: string, scope: unknown, settingId: string) =>
    ipcRenderer.invoke('agent-pack-clear-override', packId, scope, settingId),
  resolveAgentPackOverrides: (packId: string, worldId: string | null, chatId: string | null) =>
    ipcRenderer.invoke('agent-pack-resolve-overrides', packId, worldId, chatId),
  // The detail panel's settings model (agent-packs plan WP3.2): creator-exposed + auto-derived System
  // trigger params, each with its resolved value + provenance. Null when the pack isn't installed.
  getAgentPackSettings: (
    profileId: string,
    packId: string,
    worldId: string | null,
    chatId: string | null
  ) => ipcRenderer.invoke('agent-pack-settings', profileId, packId, worldId, chatId),
  // Persisted workflow run history for the Runs timeline (agent-packs plan WP2.3). Returns records
  // newest-first; page backward by passing the smallest seq of the previous page as `beforeSeq`.
  listAgentPackRuns: (profileId: string, chatId: string, beforeSeq?: number, limit?: number) =>
    ipcRenderer.invoke('agent-pack-list-runs', profileId, chatId, beforeSeq, limit),
  // Read-only "why isn't this pack running?" trigger explanation for the Agents "Why?" popover
  // (agent-packs plan WP3.5). Evaluates the pack's materialized triggers against committed state
  // WITHOUT advancing baselines or firing — safe to call on popover open. [] when not gate-open.
  explainAgentPackTriggers: (profileId: string, chatId: string, packId: string) =>
    ipcRenderer.invoke('agent-pack-explain-triggers', profileId, chatId, packId),
  // Live trigger badges for the one-canvas editor (one-canvas rebuild WP6.4a): explains the ENABLED
  // trigger.* NODES of the chat's RESOLVED active doc read-only ({ nodeId, description, met, current,
  // required } per node). READ-ONLY — never advances a baseline or fires; safe to fetch on editor open
  // + after save. The doc-path sibling of explainAgentPackTriggers.
  explainDocTriggers: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('workflow-explain-doc-triggers', profileId, chatId),
  // Fire ONE trigger.manual node's chain on explicit user action (RF-01). Guards (active doc, node
  // kind, disabled) live main-side in runManualDoc — they log + no-op, never throw.
  runManualTrigger: (profileId: string, chatId: string, docId: string, triggerNodeId: string) =>
    ipcRenderer.invoke('workflow-run-manual-trigger', profileId, chatId, docId, triggerNodeId),
  // Effective-graph projection for the Workflow view's Effective mode (agent-packs plan WP3.6a;
  // ADR 0010): the composed doc + composition warnings + per-pack grouping. A live projection,
  // never persisted (ADR 0001) — re-fetch after a gate flip or narrator write-through.
  getEffectiveGraph: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('agent-pack-effective-graph', profileId, chatId),
  // Copy-on-edit fork (ADR 0006). Repoints only `worldId`'s activation to the fork. WP3.6a exposes
  // it; WP3.6b consumes it for pack-node edit routing.
  forkAgentPack: (profileId: string, packId: string, worldId: string, editedFragment?: unknown) =>
    ipcRenderer.invoke('agent-pack-fork', profileId, packId, worldId, editedFragment),
  // Fork write-through (ADR 0006; WP3.6b): replace a non-builtin pack's fragment doc (builtin →
  // refused). Returns { ok, code, error } — the renderer toasts on failure.
  updateAgentPackFragment: (profileId: string, packId: string, fragment: unknown) =>
    ipcRenderer.invoke('agent-pack-update-fragment', profileId, packId, fragment),
  // Read a pack's source fragment doc (WP3.6b): the renderer applies an edit to a copy before
  // forking / writing through.
  getAgentPackFragment: (profileId: string, packId: string) =>
    ipcRenderer.invoke('agent-pack-fragment', profileId, packId),
  // Is a pack's activation exclusively this world's? (WP4.4; ADR 0006.) The Effective-mode edit router
  // consults it so a config edit on your OWN non-builtin fork writes through across restarts instead of
  // minting a fork-of-fork. No activation rows → false (fork-again, the safe default).
  isAgentPackActivationExclusive: (profileId: string, packId: string, worldId: string) =>
    ipcRenderer.invoke('agent-pack-activation-exclusive', profileId, packId, worldId),
  // Next-prompt injection preview (agent-packs plan WP3.4): the assembled prompt broken into per-source
  // sections + an omitted list. A DRY RUN — zero state writes, zero LLM calls. Fetched on the Preview
  // pane opening + on the Refresh button; never auto-polled.
  previewNextPrompt: (profileId: string, chatId: string, userAction?: string) =>
    ipcRenderer.invoke('agent-pack-preview-prompt', profileId, chatId, userAction),
  // Agent-pack SHARING: `.rptagent` export / import (agent-packs plan WP4.2). Export refuses builtins
  // (a fork of a builtin IS exportable). Import is TWO-PHASE for WP4.3's inspection screen: the dialog
  // opens + inspects (returns a report incl. a `token`); the renderer then confirms or cancels.
  previewAgentPackExport: (profileId: string, packId: string) =>
    ipcRenderer.invoke('agent-pack-preview-export', profileId, packId),
  exportAgentPackDialog: (profileId: string, packId: string) =>
    ipcRenderer.invoke('agent-pack-export-dialog', profileId, packId),
  importAgentPackDialog: (profileId: string) =>
    ipcRenderer.invoke('agent-pack-import-dialog', profileId),
  confirmAgentPackImport: (token: string) => ipcRenderer.invoke('agent-pack-confirm-import', token),
  cancelAgentPackImport: (token: string) => ipcRenderer.invoke('agent-pack-cancel-import', token),
  // Module SHARING: `.rptmodule` export / import (one-canvas rebuild WP6.5). Export a GROUP of the
  // (unsaved) doc being edited as a reusable slab; import one into the open doc. Export is previewless
  // (the module panel IS the review): pass the doc + groupId + optional whole active template. Import is
  // TWO-PHASE (inspect → confirm): the sheet renders the report incl. a `token`; the renderer confirms
  // (templates install main-side, the module payload comes back for graph insertion) or cancels.
  exportModuleDialog: (
    profileId: string,
    doc: unknown,
    groupId: string,
    includeTemplate?: unknown
  ) => ipcRenderer.invoke('module-export-dialog', profileId, doc, groupId, includeTemplate ?? null),
  importModuleDialog: (profileId: string) => ipcRenderer.invoke('module-import-dialog', profileId),
  confirmModuleImport: (token: string) => ipcRenderer.invoke('module-confirm-import', token),
  cancelModuleImport: (token: string) => ipcRenderer.invoke('module-cancel-import', token),
  // Agent library (agent-memory-ux WP-G): the palette's built-in + user module templates.
  listModuleTemplates: (profileId: string) =>
    ipcRenderer.invoke('list-module-templates', profileId),
  getModuleTemplate: (profileId: string, id: string) =>
    ipcRenderer.invoke('get-module-template', profileId, id),
  saveModuleToLibrary: (profileId: string, module: unknown) =>
    ipcRenderer.invoke('save-module-to-library', profileId, module),
  // Agent & memory UX (WP-H): per-world lorebook entry picks for agent.llm's custom lore mode.
  getLorePicks: (profileId: string, worldId: string, docId: string, nodeId: string) =>
    ipcRenderer.invoke('get-lore-picks', profileId, worldId, docId, nodeId),
  setLorePicks: (
    profileId: string,
    worldId: string,
    docId: string,
    nodeId: string,
    picks: unknown[]
  ) => ipcRenderer.invoke('set-lore-picks', profileId, worldId, docId, nodeId, picks),
  // Recipe SHARING: `.rptrecipe` export / import (agent-packs plan WP5.2; ADR 0008) — "share this
  // world's setup" (a set of embedded packs + activation preset + narrator choice). Export assembles
  // from the CURRENT world; `opts` = the wizard's name/description/creator. Import is TWO-PHASE: the
  // dialog inspects (report incl. a `token` + per-pack sub-reports); the renderer confirms with the
  // TARGET WORLD (chosen at confirm — the recipe file doesn't know it) or cancels.
  previewRecipeExport: (
    profileId: string,
    worldId: string,
    opts: { name: string; description?: string; creator?: string; id?: string }
  ) => ipcRenderer.invoke('recipe-preview-export', profileId, worldId, opts),
  exportRecipeDialog: (
    profileId: string,
    worldId: string,
    opts: { name: string; description?: string; creator?: string; id?: string }
  ) => ipcRenderer.invoke('recipe-export-dialog', profileId, worldId, opts),
  importRecipeDialog: (profileId: string) => ipcRenderer.invoke('recipe-import-dialog', profileId),
  confirmRecipeImport: (token: string, targetWorldId: string) =>
    ipcRenderer.invoke('recipe-confirm-import', token, targetWorldId),
  cancelRecipeImport: (token: string) => ipcRenderer.invoke('recipe-cancel-import', token),
  // Uninstall an installed pack (agent-packs plan WP4.3b). Powers the version-conflict import recovery
  // (uninstall the installed pack, then re-confirm the SAME token) + the detail panel's remove action.
  // Structured result: { ok:true } | { ok:false, code:'builtin' | 'not-found' } (builtins are refused).
  // WP4.6: `version` uninstalls ONE version (omitted = the highest installed). The last version's
  // removal cascades to the version-agnostic activation/override/trigger rows.
  uninstallAgentPack: (profileId: string, packId: string, version?: number) =>
    ipcRenderer.invoke('agent-pack-uninstall', profileId, packId, version),
  // SQL-table memory (issue 02): file-based table templates + per-chat assignment + read-only view
  listTableTemplates: (profileId: string) => ipcRenderer.invoke('table-templates-list', profileId),
  getTableTemplate: (profileId: string, id: string) =>
    ipcRenderer.invoke('table-template-get', profileId, id),
  updateTableTemplate: (profileId: string, id: string, patch: unknown) =>
    ipcRenderer.invoke('table-template-update', profileId, id, patch),
  // Structural template edit + bound-chat migration (Memory-Manager WP4a). `ops` = ordered
  // add/rename/drop table|column ops; rejects the whole batch on any invalid op.
  applyTableStructure: (profileId: string, templateId: string, ops: unknown[]) =>
    ipcRenderer.invoke('table-structure-apply', profileId, templateId, ops),
  deleteTableTemplate: (profileId: string, id: string) =>
    ipcRenderer.invoke('table-template-delete', profileId, id),
  importTableTemplateDialog: (profileId: string) =>
    ipcRenderer.invoke('table-template-import-dialog', profileId),
  getChatTableTemplate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-table-template-get', profileId, chatId),
  setChatTableTemplate: (profileId: string, chatId: string, id: string | null) =>
    ipcRenderer.invoke('chat-table-template-set', profileId, chatId, id),
  previewMemoryMaintain: (profileId: string, chatId: string, config: unknown) =>
    ipcRenderer.invoke('memory-maintain-preview', profileId, chatId, config),
  // Run ONE maintenance pass on demand (Memory-Manager WP2 workbench). `opts` = { lastNFloors?, extraHint? }.
  maintainTablesNow: (
    profileId: string,
    chatId: string,
    opts: { lastNFloors?: number; extraHint?: string }
  ) => ipcRenderer.invoke('chat-tables-maintain-now', profileId, chatId, opts),
  readChatTables: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-tables-read', profileId, chatId),
  // SQL-table memory (issue 06): hand editing, last-maintained status, template export
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
  ) => ipcRenderer.invoke('chat-tables-edit', profileId, chatId, edit),
  readChatTablesStatus: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-tables-status', profileId, chatId),
  // SQL-table memory history (Memory-Manager WP3): the op-log projection + a data-only rewind.
  listChatTableOps: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-tables-ops-list', profileId, chatId),
  rewindChatTables: (profileId: string, chatId: string, fromFloor: number) =>
    ipcRenderer.invoke('chat-tables-rewind', profileId, chatId, fromFloor),
  exportTableTemplateDialog: (profileId: string, templateId: string, chatId?: string | null) =>
    ipcRenderer.invoke('table-template-export-dialog', profileId, templateId, chatId),
  // SQL-table memory (issue 07): manual backfill from history + live progress events
  startTableBackfill: (
    profileId: string,
    chatId: string,
    opts: {
      lastFloors: number | 'all'
      batchSize: number
      apiPresetId?: string | null
      retries?: number
    }
  ) => ipcRenderer.invoke('table-backfill-start', profileId, chatId, opts),
  cancelTableBackfill: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('table-backfill-cancel', profileId, chatId),
  getTableBackfillState: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('table-backfill-state', profileId, chatId),
  onTableBackfillProgress: (cb: (p: any) => void) => {
    const listener = (_e: IpcRendererEvent, p: any): void => cb(p)
    ipcRenderer.on('table-backfill-progress', listener)
    return () => ipcRenderer.removeListener('table-backfill-progress', listener)
  },
  // Lorebook library (id-keyed; a character's own lorebook has id == characterId)
  listLorebooks: (profileId: string) => ipcRenderer.invoke('list-lorebooks', profileId),
  getLorebook: (profileId: string, id: string) => ipcRenderer.invoke('get-lorebook', profileId, id),
  saveLorebook: (profileId: string, id: string, lorebook: any) =>
    ipcRenderer.invoke('save-lorebook', profileId, id, lorebook),
  createLorebook: (profileId: string, name: string) =>
    ipcRenderer.invoke('create-lorebook', profileId, name),
  deleteLorebook: (profileId: string, id: string) =>
    ipcRenderer.invoke('delete-lorebook', profileId, id),
  importLorebookDialog: (profileId: string) =>
    ipcRenderer.invoke('import-lorebook-dialog', profileId),
  exportLorebookDialog: (profileId: string, id: string, name: string) =>
    ipcRenderer.invoke('export-lorebook-dialog', profileId, id, name),
  getChatLorebooks: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-chat-lorebooks', profileId, chatId),
  getRenderMarkers: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-render-markers', profileId, chatId),
  setChatLorebooks: (profileId: string, chatId: string, ids: string[] | null) =>
    ipcRenderer.invoke('set-chat-lorebooks', profileId, chatId, ids),
  getChatMode: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('get-chat-mode', profileId, chatId),
  setChatMode: (profileId: string, chatId: string, mode: string) =>
    ipcRenderer.invoke('set-chat-mode', profileId, chatId, mode),
  // A chat's FSM mode changed MAIN-side (a workflow tool node started combat/duel) — follow it.
  onChatModeChanged: (cb: (p: { chatId: string; mode: string }) => void) => {
    const listener = (_e: IpcRendererEvent, p: any): void => cb(p)
    ipcRenderer.on('chat-mode-changed', listener)
    return () => ipcRenderer.removeListener('chat-mode-changed', listener)
  },
  // TH-2 swipes
  setActiveSwipe: (profileId: string, chatId: string, floorIndex: number, swipeId: number) =>
    ipcRenderer.invoke('set-active-swipe', profileId, chatId, floorIndex, swipeId),
  generateSwipe: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('generate-swipe', profileId, chatId),
  // Card-script runtime (P1)
  pluginVars: (profileId: string, chatId: string, action: any) =>
    ipcRenderer.invoke('plugin-vars', profileId, chatId, action),
  pluginGetVars: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-vars', profileId, chatId),
  // Whole-object global vars (getVariables/replaceVariables({type:'global'}) + the 全局变量 tab).
  pluginGlobalsGetSync: (profileId: string) =>
    ipcRenderer.sendSync('plugin-globals-get-sync', profileId),
  pluginGlobalsSet: (profileId: string, vars: Record<string, any>) =>
    ipcRenderer.invoke('plugin-globals-set', profileId, vars),
  pluginGetMessages: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('plugin-get-messages', profileId, chatId),
  pluginSetMessage: (profileId: string, chatId: string, floorIndex: number, patch: any) =>
    ipcRenderer.invoke('plugin-set-message', profileId, chatId, floorIndex, patch),
  pluginDeleteMessages: (profileId: string, chatId: string, fromIndex: number) =>
    ipcRenderer.invoke('plugin-delete-messages', profileId, chatId, fromIndex),
  pluginCreateMessage: (profileId: string, chatId: string, msg: any) =>
    ipcRenderer.invoke('plugin-create-message', profileId, chatId, msg),
  // TH-4 generation control
  generateRaw: (profileId: string, chatId: string, config: any) =>
    ipcRenderer.invoke('generate-raw', profileId, chatId, config),
  generateImage: (profileId: string, prompt: string) =>
    ipcRenderer.invoke('generate-image', profileId, prompt),
  // TH-3 read/CRUD API
  scriptCardData: (profileId: string, chatId: string, cardId?: string) =>
    ipcRenderer.invoke('script-card-data', profileId, chatId, cardId),
  scriptCardAvatar: (profileId: string, chatId: string, cardId?: string) =>
    ipcRenderer.invoke('script-card-avatar', profileId, chatId, cardId),
  scriptWorldbookList: (profileId: string) =>
    ipcRenderer.invoke('script-worldbook-list', profileId),
  scriptWorldbookGet: (profileId: string, chatId: string, id?: string, cardId?: string) =>
    ipcRenderer.invoke('script-worldbook-get', profileId, chatId, id, cardId),
  scriptWorldbookSet: (
    profileId: string,
    chatId: string,
    id: string | undefined,
    entries: any,
    cardId?: string
  ) => ipcRenderer.invoke('script-worldbook-set', profileId, chatId, id, entries, cardId),
  scriptPresetGet: (profileId: string) => ipcRenderer.invoke('script-preset-get', profileId),
  scriptPresetList: (profileId: string) => ipcRenderer.invoke('script-preset-list', profileId),
  scriptRegexFormat: (profileId: string, ctx: any, text: string, macroCtx?: any) =>
    ipcRenderer.invoke('script-regex-format', profileId, ctx, text, macroCtx),
  scriptRegexList: (profileId: string, ctx?: any) =>
    ipcRenderer.invoke('script-regex-list', profileId, ctx),
  scriptFetchText: (profileId: string, cardId: string | undefined, url: string) =>
    ipcRenderer.invoke('script-fetch-text', profileId, cardId, url),
  scriptFetchModuleGraph: (profileId: string, cardId: string | undefined, urls: string[]) =>
    ipcRenderer.invoke('script-fetch-module-graph', profileId, cardId, urls),
  pluginGetGrants: (profileId: string, cardId: string) =>
    ipcRenderer.invoke('plugin-get-grants', profileId, cardId),
  pluginSetGrants: (profileId: string, cardId: string, patch: any) =>
    ipcRenderer.invoke('plugin-set-grants', profileId, cardId, patch),
  pluginLog: (label: string, message: string) => ipcRenderer.invoke('plugin-log', label, message),
  // Plugin host/loader (P2)
  pluginsList: (profileId: string) => ipcRenderer.invoke('plugins-list', profileId),
  pluginsInstallDialog: () => ipcRenderer.invoke('plugins-install-dialog'),
  pluginsInstallZipDialog: () => ipcRenderer.invoke('plugins-install-zip-dialog'),
  pluginsUninstall: (profileId: string, id: string) =>
    ipcRenderer.invoke('plugins-uninstall', profileId, id),
  pluginsSetEnabled: (profileId: string, id: string, enabled: boolean, grants?: string[]) =>
    ipcRenderer.invoke('plugins-set-enabled', profileId, id, enabled, grants),
  pluginsSetGrants: (profileId: string, id: string, grants: string[]) =>
    ipcRenderer.invoke('plugins-set-grants', profileId, id, grants),
  pluginsScaffoldExample: () => ipcRenderer.invoke('plugins-scaffold-example'),
  pluginStorage: (profileId: string, owner: string, action: any) =>
    ipcRenderer.invoke('plugin-storage', profileId, owner, action),
  // SYNC read of an owner's whole KV bag — inline card host seeds getVariables({type:'script'}) at boot.
  pluginStorageAllSync: (profileId: string, owner: string) =>
    ipcRenderer.sendSync('plugin-storage-all-sync', profileId, owner),
  pluginNetFetch: (pluginId: string, url: string, opts: any) =>
    ipcRenderer.invoke('plugin-net-fetch', pluginId, url, opts),
  // Local grid combat (Track Combat). One active encounter per chat.
  combatStart: (profileId: string, chatId: string, setup: unknown) =>
    ipcRenderer.invoke('combat-start', profileId, chatId, setup),
  combatGet: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-get', profileId, chatId),
  combatStartMock: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-start-mock', profileId, chatId),
  combatAction: (profileId: string, chatId: string, action: unknown) =>
    ipcRenderer.invoke('combat-action', profileId, chatId, action),
  combatEndTurn: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-end-turn', profileId, chatId),
  combatEnemyTurn: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-enemy-turn', profileId, chatId),
  combatStartFromCard: (profileId: string, chatId: string, cue: unknown) =>
    ipcRenderer.invoke('combat-start-from-card', profileId, chatId, cue),
  combatAdjudicate: (profileId: string, chatId: string, prose: string) =>
    ipcRenderer.invoke('combat-adjudicate', profileId, chatId, prose),
  combatNarrate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-narrate', profileId, chatId),
  combatNarrationPrompt: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-narration-prompt', profileId, chatId),
  combatEnd: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-end', profileId, chatId),
  combatClear: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('combat-clear', profileId, chatId),
  // Interactive STS duel (Track Duel). One active duel per chat.
  duelGet: (profileId: string, chatId: string) => ipcRenderer.invoke('duel-get', profileId, chatId),
  duelStartMock: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-start-mock', profileId, chatId),
  duelStart: (profileId: string, chatId: string, characterId: string) =>
    ipcRenderer.invoke('duel-start', profileId, chatId, characterId),
  duelStartFromCue: (profileId: string, chatId: string, cue: unknown) =>
    ipcRenderer.invoke('duel-start-from-cue', profileId, chatId, cue),
  duelPlay: (profileId: string, chatId: string, cardId: string, targetIds: string[]) =>
    ipcRenderer.invoke('duel-play', profileId, chatId, cardId, targetIds),
  duelEndTurn: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-end-turn', profileId, chatId),
  duelNarrate: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('duel-narrate', profileId, chatId),
  duelEnd: (profileId: string, chatId: string) => ipcRenderer.invoke('duel-end', profileId, chatId),
  // Subscribe to incremental generation text. Returns an unsubscribe function.
  onGenerationDelta: (cb: (payload: { chatId: string; delta: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string; delta: string }): void =>
      cb(payload)
    ipcRenderer.on('generation-delta', listener)
    return () => ipcRenderer.removeListener('generation-delta', listener)
  },
  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  // Regex
  getRenderRegex: (profileId: string, ctx?: { cardId?: string | null; chatId?: string | null }) =>
    ipcRenderer.invoke('get-render-regex', profileId, ctx),
  listRegex: (profileId: string) => ipcRenderer.invoke('list-regex', profileId),
  listPanelRegex: (profileId: string, ctx?: { cardId?: string | null; chatId?: string | null }) =>
    ipcRenderer.invoke('list-panel-regex', profileId, ctx),
  deleteRegex: (profileId: string, file: string) =>
    ipcRenderer.invoke('delete-regex', profileId, file),
  setRegexScope: (profileId: string, file: string, scope: string, owner?: string) =>
    ipcRenderer.invoke('regex-set-scope', profileId, file, scope, owner),
  setRegexRenderMode: (profileId: string, file: string, renderMode: string | null) =>
    ipcRenderer.invoke('regex-set-render-mode', profileId, file, renderMode),
  setRegexDisabled: (profileId: string, file: string, disabled: boolean) =>
    ipcRenderer.invoke('regex-set-disabled', profileId, file, disabled),
  // Scripts library
  listScripts: (profileId: string) => ipcRenderer.invoke('list-scripts', profileId),
  getScript: (profileId: string, file: string) => ipcRenderer.invoke('get-script', profileId, file),
  saveScript: (profileId: string, script: any, scope?: string, owner?: string) =>
    ipcRenderer.invoke('save-script', profileId, script, scope, owner),
  updateScript: (profileId: string, file: string, patch: any) =>
    ipcRenderer.invoke('update-script', profileId, file, patch),
  setScriptScope: (profileId: string, file: string, scope: string, owner?: string) =>
    ipcRenderer.invoke('script-set-scope', profileId, file, scope, owner),
  setScriptDisabled: (profileId: string, file: string, disabled: boolean) =>
    ipcRenderer.invoke('script-set-disabled', profileId, file, disabled),
  deleteScript: (profileId: string, file: string) =>
    ipcRenderer.invoke('delete-script', profileId, file),
  importScriptDialog: (profileId: string, scope?: string, owner?: string) =>
    ipcRenderer.invoke('import-script-dialog', profileId, scope, owner),
  getRuntimeScripts: (profileId: string, cardId: string | null, chatId: string | null) =>
    ipcRenderer.invoke('get-runtime-scripts', profileId, cardId, chatId),
  getRegexRules: (profileId: string, file: string) =>
    ipcRenderer.invoke('regex-script-rules', profileId, file),
  updateRegexRule: (profileId: string, file: string, index: number, patch: any) =>
    ipcRenderer.invoke('regex-update-rule', profileId, file, index, patch),
  importRegexDialog: (profileId: string) => ipcRenderer.invoke('import-regex-dialog', profileId),
  onLog: (cb: (entry: any) => void) => {
    const listener = (_e: IpcRendererEvent, entry: any): void => cb(entry)
    ipcRenderer.on('log-event', listener)
    return () => ipcRenderer.removeListener('log-event', listener)
  },
  // A WebContentsView card panel wrote variables → refresh the host's native panels.
  onWcvHostVars: (cb: (payload: { chatId: string; variables: unknown }) => void) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { chatId: string; variables: unknown }
    ): void => cb(payload)
    ipcRenderer.on('wcv-host-vars', listener)
    return () => ipcRenderer.removeListener('wcv-host-vars', listener)
  },
  // A card panel asked to set the chat input box (onboarding finish "inject prompt").
  onWcvHostInput: (cb: (payload: { chatId: string; text: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string; text: string }): void =>
      cb(payload)
    ipcRenderer.on('wcv-host-input', listener)
    return () => ipcRenderer.removeListener('wcv-host-input', listener)
  },
  // A card panel asked to "press the send button" (/trigger → submit the current box content).
  onWcvHostSubmit: (cb: (payload: { chatId: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string }): void => cb(payload)
    ipcRenderer.on('wcv-host-submit', listener)
    return () => ipcRenderer.removeListener('wcv-host-submit', listener)
  },
  // A card panel changed message content via saveChat → reload the active chat's floors.
  onWcvHostReload: (cb: (payload: { chatId: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { chatId: string }): void => cb(payload)
    ipcRenderer.on('wcv-host-reload', listener)
    return () => ipcRenderer.removeListener('wcv-host-reload', listener)
  },
  // An inline card reported its content height → size that message slot to fit.
  onWcvSlotSize: (cb: (payload: { slotId: string; height: number }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { slotId: string; height: number }): void =>
      cb(payload)
    ipcRenderer.on('wcv-slot-size', listener)
    return () => ipcRenderer.removeListener('wcv-slot-size', listener)
  },
  // An inline card overlay forwarded a wheel delta → scroll the message list past it.
  onWcvWheel: (cb: (payload: { slotId: string; dy: number }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { slotId: string; dy: number }): void =>
      cb(payload)
    ipcRenderer.on('wcv-host-wheel', listener)
    return () => ipcRenderer.removeListener('wcv-host-wheel', listener)
  },
  // Runtime play theme (runtime-theme-api-design §5): a WCV card called setPlayTheme → main relays it here
  // for the renderer to derive/AA-check/apply; the renderer replies with the verdict (keyed by id). The
  // renderer also pushes its effective play-theme snapshot to main so a WCV's getPlayTheme() can read it.
  onWcvSetPlayTheme: (
    cb: (payload: { id: number; chatId: string; theme: unknown; opts: unknown }) => void
  ) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { id: number; chatId: string; theme: unknown; opts: unknown }
    ): void => cb(payload)
    ipcRenderer.on('wcv-host-set-play-theme', listener)
    return () => ipcRenderer.removeListener('wcv-host-set-play-theme', listener)
  },
  wcvSetPlayThemeReply: (id: number, ok: boolean) =>
    ipcRenderer.send('wcv-host-set-play-theme-reply', id, ok),
  setPlayThemeCache: (snapshot: {
    tokens: Record<string, string>
    source: 'user' | 'card' | 'runtime'
  }) => ipcRenderer.send('set-play-theme-cache', snapshot),
  // App light/dark mode sync (WCV mode sync): push RPT's IN-APP theme axis so a WCV card surface follows
  // the app theme, not the OS `prefers-color-scheme`. Mirrors setPlayThemeCache; the renderer calls it on
  // app-theme change. Main snapshots it (WCV sync read at boot) + pushes the change to every WCV.
  setColorSchemeCache: (scheme: 'light' | 'dark') =>
    ipcRenderer.send('set-colorscheme-cache', scheme),
  // World Assets (per-world image asset layer)
  assetCoverage: (profileId: string, lorebookIds: string[], category: string, roster: string[]) =>
    ipcRenderer.invoke('asset-coverage', profileId, lorebookIds, category, roster),
  assetUrl: (
    profileId: string,
    lorebookIds: string[],
    category: string,
    name: string,
    type: string,
    mood?: string
  ) => ipcRenderer.invoke('asset-url', profileId, lorebookIds, category, name, type, mood),
  // Card-facing (WA-3): enumerate one entry's variants; main applies id precedence + category inference.
  assetList: (profileId: string, lorebookIds: string[], name: string, type: string) =>
    ipcRenderer.invoke('asset-list-for-card', profileId, lorebookIds, name, type),
  // Card-facing (WA-3): open the OS image picker and import into the primary world; returns the new
  // rptasset:// URL or null (cancel/invalid). Backs rptHost.requestAssetImport on inline cards.
  assetImportForCard: (
    profileId: string,
    lorebookIds: string[],
    name: string,
    type: string,
    variant?: string
  ) =>
    ipcRenderer.invoke('asset-import-for-card', profileId, lorebookIds, name, type, variant),
  duelPreview: (profileId: string, chatId: string, characterId: string) =>
    ipcRenderer.invoke('duel-preview', profileId, chatId, characterId),
  assetRefresh: (profileId: string, lorebookIds: string[]) =>
    ipcRenderer.invoke('asset-refresh', profileId, lorebookIds),
  assetOpenFolder: (profileId: string, lorebookId: string, category: string) =>
    ipcRenderer.invoke('asset-open-folder', profileId, lorebookId, category),
  assetImportZipDialog: (profileId: string, lorebookId: string) =>
    ipcRenderer.invoke('asset-import-zip-dialog', profileId, lorebookId),
  // Asset manager surface (WA-2). The `assets` workspace view's read + mutation API.
  assetListIndex: (profileId: string, lorebookIds: string[]) =>
    ipcRenderer.invoke('asset-list-index', profileId, lorebookIds),
  assetImportFiles: (
    profileId: string,
    lorebookId: string,
    items: { srcPath: string; name: string; type: string; variant?: string }[]
  ) => ipcRenderer.invoke('asset-import-files', profileId, lorebookId, items),
  assetDeleteFile: (profileId: string, lorebookId: string, category: string, file: string) =>
    ipcRenderer.invoke('asset-delete-file', profileId, lorebookId, category, file),
  assetRenameVariant: (
    profileId: string,
    lorebookId: string,
    category: string,
    file: string,
    newVariant: string
  ) => ipcRenderer.invoke('asset-rename-variant', profileId, lorebookId, category, file, newVariant),
  assetExportZipDialog: (profileId: string, lorebookId: string) =>
    ipcRenderer.invoke('asset-export-zip', profileId, lorebookId),
  assetPickImages: (multi: boolean) => ipcRenderer.invoke('asset-pick-images', multi),
  // Electron 39 removed `File.path`; drag-drop OS paths now come from webUtils.getPathForFile.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  // Per-chat card KV (inline transport): general scope, getVariables({type:'chat'}).
  chatCardVarsGet: (profileId: string, chatId: string) =>
    ipcRenderer.invoke('chat-card-vars-get', profileId, chatId),
  // SYNC read for the inline card host — the card reads its saved session KV at boot before it paints.
  chatCardVarsGetSync: (profileId: string, chatId: string) =>
    ipcRenderer.sendSync('chat-card-vars-get-sync', profileId, chatId),
  chatCardVarsSet: (profileId: string, chatId: string, vars: Record<string, any>) =>
    ipcRenderer.invoke('chat-card-vars-set', profileId, chatId, vars),
  // Storage location (app-global; pointer file, not per-profile settings)
  getDataLocation: () => ipcRenderer.invoke('get-data-location'),
  setDataLocationDialog: () => ipcRenderer.invoke('set-data-location-dialog'),
  openDataLocation: () => ipcRenderer.invoke('open-data-location'),
  resetDataLocation: () => ipcRenderer.invoke('reset-data-location'),
  restartApp: () => ipcRenderer.invoke('restart-app')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
