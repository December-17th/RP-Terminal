import { create } from 'zustand'
import type { FloorMetrics } from '../../../shared/usageTypes'
import type { VarsOrigin } from '../../../shared/thRuntime/types'
import { useCombatStore } from './combatStore'
import { useDuelStore } from './duelStore'
import { useSettingsStore } from './settingsStore'

export interface FloorIndexEntry {
  floor: number
  timestamp: string
  user_preview: string
  response_preview: string
}

export interface ChatSession {
  id: string
  character_id: string
  updated_at: string
  floor_count: number
  floor_index: FloorIndexEntry[]
}

export interface Floor {
  floor: number
  chat_id: string
  user_message: { content: string }
  response: { content: string }
  /** Alternate responses (TH-2 swipes); swipes[swipe_id] === response.content. */
  swipes?: string[]
  swipe_id?: number
  /** Cache/token metrics for this floor (present once it has been through a metered turn). */
  metrics?: FloorMetrics
  /** Plot-recall (data layer): recall's planner output as a display-only directive block, shown in a
   *  collapsible plot panel. Present only when the pre-turn recall emitted one. */
  plot_block?: string
  variables: Record<string, any>
}

/** A JSONPatch-style variable op for the write-back bridge (panel UI editing stat_data). */
export interface VarOp {
  op: string
  path: string
  value?: unknown
  from?: string
}

interface ChatState {
  chats: ChatSession[]
  activeChatId: string | null
  /** Active FSM mode for the open session (Phase H). */
  activeChatMode: string
  floors: Floor[]
  /** Origin of the LATEST floors mutation, tagged so the card runtime fires MVU events faithfully
   *  (only for non-`card-write` origins — a card's own write echoed back must not re-fire its events
   *  and loop). Read by the inline `cardBridge` onVarsChanged subscription and by App.tsx's WCV
   *  broadcast; set alongside every floors-mutating `set()`. See shared/thRuntime `VarsOrigin`. */
  lastVarsOrigin: VarsOrigin
  isGenerating: boolean
  /** Live partial text for the in-flight response (pre-regex), shown while streaming. */
  streamingText: string
  error: string | null
  /** One-time new-session nudge: set true right after createChat when the memory-table reminder
   *  setting is on (a brand-new session never has a template assigned). Cleared by
   *  dismissTemplateReminder. Rendered by TableTemplateReminderModal. */
  templateReminderOpen: boolean
  loadChats: (profileId: string) => Promise<void>
  createChat: (profileId: string, characterId: string) => Promise<void>
  setActiveChat: (profileId: string, chatId: string) => Promise<void>
  /** Reload floors after a CARD-initiated chat mutation (saveChat / setChatMessages / delete / regex
   *  write / reloadCurrentChat — every pushHostReload initiator is a card). Tags the change card-write so
   *  the App.tsx floor-subscription rebroadcast does not re-fire card MVU events (the setChatMessages twin
   *  of the WS-3 fix). Deliberately does NOT reset combat/duel stores or refetch mode — this is a floor
   *  refresh, not a session switch. */
  refreshFloors: (profileId: string, chatId: string) => Promise<void>
  /** Re-derive stat_data by replaying the stored <UpdateVariable> updates (no regeneration). */
  reevaluateVariables: (profileId: string) => Promise<void>
  /** Apply variable ops (JSONPatch) to a floor's stat_data from panel UI (write-back). */
  applyVariableOps: (profileId: string, ops: VarOp[], floor?: number) => Promise<void>
  /** Replace the latest floor's stat_data wholesale (the Variables-view editor's write path). */
  setStatData: (profileId: string, json: unknown) => Promise<void>
  /** Switch the open session's FSM mode (Explore/Dialogue/Combat). */
  setMode: (profileId: string, mode: string) => Promise<void>
  sendAction: (profileId: string, actionText: string) => Promise<void>
  regenerate: (profileId: string) => Promise<void>
  stopGeneration: () => Promise<void>
  deleteChat: (profileId: string, chatId: string) => Promise<void>
  /** Export one session to a `.rpsave` file (Feature 2). Returns the native-dialog result (or null
   *  if the user cancelled); the caller toasts success/error. */
  exportSave: (
    profileId: string,
    chatId: string
  ) => Promise<{ name: string } | { error: string } | null>
  /** Import a `.rpsave` into a NEW session (requires its world installed). Refreshes the chat list on
   *  success so the imported session appears. */
  importSave: (
    profileId: string
  ) => Promise<{ chatId: string } | { error: string; worldName?: string } | null>
  /** Drop the active session + its loaded floors (e.g. when switching/deleting worlds, so a
   * stale chat from another world isn't rendered). */
  clearActiveChat: () => void
  editFloor: (
    profileId: string,
    floorIndex: number,
    field: 'user' | 'response',
    text: string
  ) => Promise<void>
  /** Delete a consecutive tail of floors (fromFloor..latest, inclusive). Rolls back the removed
   *  floors' memory-table ops + journaled variable writes (main-side truncateFloors), then reloads
   *  floors so the UI + native panels reflect the rewound state. */
  deleteFloorsFrom: (profileId: string, fromFloor: number) => Promise<void>
  /** Navigate or generate a floor's swipe. 'left'/'right' rotate existing alternates;
   * 'right' past the last alternate on the latest floor generates a new one. */
  swipe: (profileId: string, floorIndex: number, dir: 'left' | 'right') => Promise<void>
  appendDelta: (delta: string) => void
  /** Replace the latest floor's variables (used by card scripts that mutate state
   * outside a generation turn, so status widgets reflect the change immediately). */
  setLatestFloorVariables: (variables: Record<string, any>) => void
  /** Close the new-session memory-table reminder popup. */
  dismissTemplateReminder: () => void
}

export const useChatStore = create<ChatState>((set, get) => {
  // Coalesce streamed tokens: append to a buffer and flush to state at most once
  // per animation frame. This avoids an O(n^2) re-render/markdown-parse storm on
  // long responses (and a backlog freeze when the window is backgrounded).
  let streamBuffer = ''
  let rafId: number | null = null
  const flush = (): void => {
    rafId = null
    set({ streamingText: streamBuffer })
  }
  const scheduleFlush = (): void => {
    if (rafId == null) rafId = requestAnimationFrame(flush)
  }
  const resetStream = (): void => {
    streamBuffer = ''
    if (rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }
  // A re-roll/swipe rewrites the message a fight branched from; the server clears the encounter, so
  // drop the local combat mirror and leave combat mode if we were in it.
  const stopStaleCombat = (profileId: string): void => {
    useCombatStore.getState().reset()
    if (get().activeChatMode === 'combat' || get().activeChatMode === 'duel')
      void get().setMode(profileId, 'explore')
  }

  return {
    chats: [],
    activeChatId: null,
    activeChatMode: 'explore',
    floors: [],
    lastVarsOrigin: 'model-fold',
    isGenerating: false,
    streamingText: '',
    error: null,
    templateReminderOpen: false,

    appendDelta: (delta) => {
      streamBuffer += delta
      scheduleFlush()
    },

    setLatestFloorVariables: (variables) =>
      set((state) => {
        if (state.floors.length === 0) return {}
        const floors = state.floors.slice()
        const last = floors[floors.length - 1]
        floors[floors.length - 1] = { ...last, variables }
        // This is the echo of a card panel's own write (onWcvHostVars → here). Tag it card-write so the
        // card runtime refreshes its cache but does NOT re-fire mag_* events (which would loop).
        return { floors, lastVarsOrigin: 'card-write' as const }
      }),

    loadChats: async (profileId) => {
      const chats = await window.api.getChats(profileId)
      set({ chats })
    },

    createChat: async (profileId, characterId) => {
      // Same session-switch hygiene as setActiveChat: drop the previous chat's live combat/duel
      // mirror, and clear floors in the SAME set that flips activeChatId — otherwise the new chat
      // briefly renders the old chat's floors/variables (stale variables on a fresh session).
      useCombatStore.getState().reset()
      useDuelStore.getState().reset()
      const newChat = await window.api.createChat(profileId, characterId)
      set((state) => ({
        chats: [newChat, ...state.chats],
        activeChatId: newChat.id,
        activeChatMode: 'explore',
        floors: [],
        lastVarsOrigin: 'external',
        error: null
      }))
      // A freshly created chat may already contain a seeded greeting floor.
      const floors = await window.api.getFloors(profileId, newChat.id)
      // New-session nudge: a brand-new chat never has a memory-table template assigned, so when the
      // reminder setting is on (default) pop the one-time reminder to set one. Scoped to createChat
      // only (not setActiveChat) so reopening an existing session never nags.
      const remind = useSettingsStore.getState().settings?.tables?.remind_set_template !== false
      set({ floors, lastVarsOrigin: 'model-fold', templateReminderOpen: remind })
    },

    setActiveChat: async (profileId, chatId) => {
      // Session-switch hygiene: drop the previous chat's live combat/duel mirror so it never
      // shows for the newly-selected chat (CombatView/DuelView refetch on mount for the new chat).
      useCombatStore.getState().reset()
      useDuelStore.getState().reset()
      set({ activeChatId: chatId, floors: [], lastVarsOrigin: 'external', error: null })
      const [floors, mode] = await Promise.all([
        window.api.getFloors(profileId, chatId),
        window.api.getChatMode(profileId, chatId)
      ])
      set({ floors, activeChatMode: mode || 'explore', lastVarsOrigin: 'external' })
    },

    refreshFloors: async (profileId, chatId) => {
      if (get().activeChatId !== chatId) return
      const floors = await window.api.getFloors(profileId, chatId)
      set({ floors, lastVarsOrigin: 'card-write' })
    },

    reevaluateVariables: async (profileId) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      const floors = await window.api.reevaluateVariables(profileId, activeChatId)
      set({ floors, lastVarsOrigin: 'external' })
    },

    applyVariableOps: async (profileId, ops, floor) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return
      // Default to the latest floor (the "current message" whose variables the UI shows).
      const target = floor ?? floors[floors.length - 1].floor
      const updated = await window.api.applyVariableOps(profileId, activeChatId, target, ops)
      // card-write: a panel/card programmatic write — refresh the cache but don't re-fire MVU events.
      if (updated)
        set((s) => ({
          floors: s.floors.map((f) => (f.floor === target ? updated : f)),
          lastVarsOrigin: 'card-write'
        }))
    },

    setStatData: async (profileId, json) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return
      const target = floors[floors.length - 1].floor
      const updated = await window.api.setFloorStatData(profileId, activeChatId, target, json)
      // external: a manual Variables-view edit — SHOULD fire MVU events so panels refresh.
      if (updated)
        set((s) => ({
          floors: s.floors.map((f) => (f.floor === target ? updated : f)),
          lastVarsOrigin: 'external'
        }))
    },

    setMode: async (profileId, mode) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      set({ activeChatMode: mode }) // optimistic; the write is a simple column update
      await window.api.setChatMode(profileId, activeChatId, mode)
    },

    deleteFloorsFrom: async (profileId, fromFloor) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      await window.api.deleteFloorsFrom(profileId, activeChatId, fromFloor)
      // Reload the survivors (their variables now reflect the rolled-back memory tables). Tag the
      // broadcast 'card-write', NOT 'external': the native React panels refresh from `floors` either
      // way, but 'external' RE-FIRES the card's mag_variable_update handler (thRuntime onVarsChanged),
      // and a card with self-writing automation (e.g. 命定之诗's date/world-clock — see
      // generation/varsWrite.ts) would then re-inject its stale `date.npcs` onto the now-latest floor,
      // silently re-adding to floor 0 exactly what the delete just removed. 'card-write' refreshes the
      // card's cache to the rewound state but fires no events, so it can't write back.
      const floors = await window.api.getFloors(profileId, activeChatId)
      set({ floors, lastVarsOrigin: 'card-write' })
    },

    sendAction: async (profileId, actionText) => {
      const { activeChatId } = get()
      if (!activeChatId) return

      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        // Main assembles the prompt (card + preset + lorebook + history), streams the
        // provider (deltas arrive via appendDelta), post-processes, persists and returns.
        const newFloor = await window.api.generate(profileId, activeChatId, actionText)
        resetStream()
        set((state) => ({
          floors: newFloor ? [...state.floors, newFloor] : state.floors,
          lastVarsOrigin: 'model-fold',
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId) // refresh session previews / sort order
      } catch (err: any) {
        console.error(err)
        resetStream()
        set({ isGenerating: false, streamingText: '', error: err?.message || 'Generation failed' })
      }
    },

    regenerate: async (profileId) => {
      const { activeChatId, floors } = get()
      if (!activeChatId || floors.length === 0) return

      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        // Optimistically drop the last floor so the UI shows the re-roll in progress.
        set((state) => ({ floors: state.floors.slice(0, -1), lastVarsOrigin: 'model-fold' }))
        const newFloor = await window.api.regenerate(profileId, activeChatId)
        resetStream()
        set((state) => ({
          floors: newFloor ? [...state.floors, newFloor] : state.floors,
          lastVarsOrigin: 'model-fold',
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId)
        stopStaleCombat(profileId)
      } catch (err: any) {
        console.error(err)
        resetStream()
        // Reload the persisted floors so the optimistic removal can't desync state.
        const restored = await window.api.getFloors(profileId, activeChatId)
        set({
          floors: restored,
          lastVarsOrigin: 'external',
          isGenerating: false,
          streamingText: '',
          error: err?.message || 'Regeneration failed'
        })
      }
    },

    stopGeneration: async () => {
      const { activeChatId } = get()
      if (!activeChatId) return
      // Aborts the provider request in main; the in-flight generate()/regenerate()
      // promise then resolves with the partial floor (or null) and clears state.
      await window.api.abortGeneration(activeChatId)
    },

    editFloor: async (profileId, floorIndex, field, text) => {
      const { activeChatId } = get()
      if (!activeChatId) return
      await window.api.editFloor(
        profileId,
        activeChatId,
        floorIndex,
        field === 'user' ? text : null,
        field === 'response' ? text : null
      )
      set((state) => ({
        lastVarsOrigin: 'external',
        floors: state.floors.map((f) =>
          f.floor === floorIndex
            ? field === 'user'
              ? { ...f, user_message: { ...f.user_message, content: text } }
              : { ...f, response: { ...f.response, content: text } }
            : f
        )
      }))
      get().loadChats(profileId)
    },

    swipe: async (profileId, floorIndex, dir) => {
      const { activeChatId, floors, isGenerating } = get()
      if (!activeChatId || isGenerating) return
      const idx = floors.findIndex((f) => f.floor === floorIndex)
      if (idx < 0) return
      const f = floors[idx]
      const swipeArr = f.swipes && f.swipes.length ? f.swipes : [f.response.content]
      const cur = f.swipe_id ?? 0
      const isLastFloor = idx === floors.length - 1

      // Apply a server-returned swiped floor to the store (response text + active index).
      const applyUpdated = (updated: any): void =>
        set((state) => ({
          lastVarsOrigin: 'model-fold',
          floors: state.floors.map((fl) =>
            fl.floor === floorIndex
              ? {
                  ...fl,
                  response: { ...fl.response, content: updated.response.content },
                  swipes: updated.swipes,
                  swipe_id: updated.swipe_id
                }
              : fl
          )
        }))

      // Navigate within existing alternates.
      const target = dir === 'left' ? cur - 1 : cur + 1
      if (dir === 'left' ? cur > 0 : cur < swipeArr.length - 1) {
        const updated = await window.api.setActiveSwipe(profileId, activeChatId, floorIndex, target)
        if (updated) applyUpdated(updated)
        stopStaleCombat(profileId)
        return
      }

      // Right past the last alternate on the latest floor → generate a new swipe.
      if (dir !== 'right' || !isLastFloor) return
      resetStream()
      set({ isGenerating: true, streamingText: '', error: null })
      try {
        // show the re-roll in progress
        set((state) => ({ floors: state.floors.slice(0, -1), lastVarsOrigin: 'model-fold' }))
        const fresh = await window.api.generateSwipe(profileId, activeChatId)
        resetStream()
        set((state) => ({
          floors: fresh ? [...state.floors, fresh] : state.floors,
          lastVarsOrigin: 'model-fold',
          isGenerating: false,
          streamingText: ''
        }))
        get().loadChats(profileId)
        stopStaleCombat(profileId)
      } catch (err: any) {
        console.error(err)
        resetStream()
        const restored = await window.api.getFloors(profileId, activeChatId)
        set({
          floors: restored,
          lastVarsOrigin: 'external',
          isGenerating: false,
          streamingText: '',
          error: err?.message || 'Swipe failed'
        })
      }
    },

    deleteChat: async (profileId, chatId) => {
      await window.api.deleteChat(profileId, chatId)
      set((state) => {
        const isActive = state.activeChatId === chatId
        return {
          chats: state.chats.filter((c) => c.id !== chatId),
          activeChatId: isActive ? null : state.activeChatId,
          floors: isActive ? [] : state.floors,
          lastVarsOrigin: 'external'
        }
      })
    },

    exportSave: async (profileId, chatId) => window.api.exportSaveDialog(profileId, chatId),

    importSave: async (profileId) => {
      const res = await window.api.importSaveDialog(profileId)
      if (res && 'chatId' in res) get().loadChats(profileId) // surface the imported session
      return res
    },

    clearActiveChat: () => {
      resetStream()
      set({
        activeChatId: null,
        floors: [],
        activeChatMode: 'explore',
        lastVarsOrigin: 'external',
        streamingText: '',
        error: null
      })
    },

    dismissTemplateReminder: () => set({ templateReminderOpen: false })
  }
})
