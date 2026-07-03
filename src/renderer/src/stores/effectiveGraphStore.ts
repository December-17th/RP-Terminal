import { create } from 'zustand'
import type { WorkflowDoc } from '../../../shared/workflow/types'
import type { ComposeWarning } from '../../../shared/workflow/compose'
import {
  applyFragmentEdit,
  fragmentEditApplies,
  unprefixFragmentNodeId,
  type FragmentEdit
} from '../components/workflow/packEditRouting'
import { useToastStore } from './toastStore'
import { translate, useI18nStore } from '../i18n'

/** Locale-bound t() for use outside React (the store's toasts) — reads the live locale. */
const t = (key: string, vars?: Record<string, string | number>): string =>
  translate(useI18nStore.getState().locale, key, vars)

// Store for the Workflow view's EFFECTIVE mode (agent-packs plan WP3.6a/WP3.6b; ADR 0006 + 0010).
// Holds the LIVE projection (the narrator composed with every gate-open pack) for the active chat,
// fetched via getEffectiveGraph. Kept SEPARATE from useWorkflowEditorStore so Normal-mode editing is
// pixel-identical + untouched. The projection is NEVER saved as a doc (ADR 0001/0010); only narrator
// write-through (WP3.6a) and PACK-node edits (WP3.6b) mutate anything, each re-fetching afterward.
//
// WP3.6b — "the edit IS the fork" (ADR 0006): the FIRST mutating action on a builtin/upstream pack's
// node forks the pack (with that edit applied), repoints this world (forkPack does), recomposes, and
// toasts. Subsequent edits to a pack THIS SESSION forked for THIS WORLD write through to the fork's
// fragment directly. See routePackEdit. `forkedPacks` records `sourcePackId → forkId` for the current
// world/session — the ONLY packs we write through to (see the exclusivity rule in routePackEdit).

/** One pack's presence in the projection (mirrors main's EffectivePackInfo — the IPC payload). */
export interface EffectivePackInfo {
  packId: string
  name: string
  gateOpen: boolean
  nodeIds: string[]
  triggerOnly: boolean
  /** Fork provenance (ADR 0006), present only on fork entries — the region header localizes "fork". */
  fork?: { base: string; n: number }
  /** Lineage: the upstream install this was forked from (null/absent for a root install). */
  upstreamId?: string | null
}

interface EffectiveGraphState {
  loading: boolean
  error: boolean
  doc: WorkflowDoc | null
  warnings: ComposeWarning[]
  packs: EffectivePackInfo[]
  /** The chat/world the current projection was fetched for (so a stale projection is not shown). */
  chatId: string | null
  worldId: string | null
  profileId: string | null
  /** Forks THIS SESSION created for the CURRENT world (sourcePackId → forkId, and the fork's own id →
   *  itself so a re-edit of an already-forked node routes as write-through). Reset on world/chat
   *  change (a fork's world-exclusivity is only asserted for the world it was created for). */
  forkedPacks: Record<string, string>
  /** Monotonic request seq — a fetch/route only commits if it is still the newest in flight (rapid
   *  edits recompose without a stale response clobbering a newer one). */
  reqSeq: number
  fetch(profileId: string, chatId: string, worldId: string | null): Promise<void>
  /** Flip a pack's gate at WORLD scope for the current world, then re-fetch (live recompose). */
  toggleGate(profileId: string, packId: string, open: boolean): Promise<void>
  /** Route a pack-node edit through fork-on-first-edit / write-through (ADR 0006). `packId` is the
   *  projection owner (the composed packId — may already be a fork we created). */
  routePackEdit(packId: string, edit: FragmentEdit): Promise<void>
  /** Explicitly fork a pack WITHOUT an edit (the config panel's "fork to edit" button for users who
   *  want to fork first). Repoints this world, recomposes, toasts. No-op if already forked this world. */
  forkPackExplicit(packId: string): Promise<void>
  clear(): void
}

const api = (): any => (window as unknown as { api: any }).api

/** The composed packId → the id whose fragment we WRITE. A pack we forked this session for this world
 *  maps to its fork id (write-through); anything else maps to itself and is treated as needing a fresh
 *  fork (the ADR 0006 safe default — see routePackEdit). */
const writableIdFor = (composedPackId: string, forked: Record<string, string>): string | undefined =>
  forked[composedPackId]

// Per-pack serialization (rapid-edit coherence, task B): consecutive edits to the SAME pack chain so
// (a) two quick first-edits can't BOTH take the fork branch and double-fork, and (b) a write-through
// reads the fragment the PREVIOUS write produced, never a stale copy. Keyed by the ROUTING key (the
// composed packId the user is editing); the chain re-reads store state after awaiting, so once the
// first edit forks, the next runs the write-through branch. Module-level (survives store re-renders).
const editChains = new Map<string, Promise<void>>()

/** Serialize `run` after any in-flight edit for `key`. Returns when `run` has completed. */
const serializeByKey = (key: string, run: () => Promise<void>): Promise<void> => {
  const prev = editChains.get(key) ?? Promise.resolve()
  const next = prev.then(run, run) // run regardless of a prior rejection; never chain-poison
  editChains.set(
    key,
    next.finally(() => {
      if (editChains.get(key) === next) editChains.delete(key)
    })
  )
  return next
}

export const useEffectiveGraphStore = create<EffectiveGraphState>((set, get) => ({
  loading: false,
  error: false,
  doc: null,
  warnings: [],
  packs: [],
  chatId: null,
  worldId: null,
  profileId: null,
  forkedPacks: {},
  reqSeq: 0,

  fetch: async (profileId, chatId, worldId) => {
    // A world/chat change invalidates the session fork map (world-exclusivity was only established for
    // the previous world). Keep it across same-world re-fetches (recompose after a write-through).
    const changedContext = get().chatId !== chatId || get().worldId !== worldId
    const seq = get().reqSeq + 1
    set({
      loading: true,
      error: false,
      chatId,
      worldId,
      profileId,
      reqSeq: seq,
      ...(changedContext ? { forkedPacks: {} } : {})
    })
    try {
      const result = await api().getEffectiveGraph(profileId, chatId)
      // Commit only if this is still the newest request AND the chat is unchanged (guards a stale
      // response from clobbering a newer one — rapid-edit coherence, task B).
      if (get().reqSeq !== seq || get().chatId !== chatId) return
      set({
        loading: false,
        doc: result.doc,
        warnings: result.warnings ?? [],
        packs: result.packs ?? []
      })
    } catch {
      if (get().reqSeq !== seq || get().chatId !== chatId) return
      set({ loading: false, error: true, doc: null, warnings: [], packs: [] })
    }
  },

  toggleGate: async (profileId, packId, open) => {
    const { worldId, chatId } = get()
    if (!worldId || !chatId) return
    try {
      await api().setAgentPackGate(packId, worldId, null, open)
    } catch {
      // Non-fatal — the re-fetch below reflects the true persisted state either way.
    }
    await get().fetch(profileId, chatId, worldId)
  },

  routePackEdit: (packId, edit) =>
    // Serialize per pack so rapid edits can't double-fork / clobber the fork (task B). The body reads
    // store state AFTER acquiring its turn, so once the first edit forks, the next sees the fork.
    serializeByKey(packId, async () => {
      const { profileId, chatId, worldId } = get()
      if (!profileId || !chatId || !worldId) return

      // Un-prefix the edit's target node ids from projection (pack:<id>:<orig>) to fragment ids. The
      // owner packId is authoritative (passed in), so we strip its exact prefix.
      const mapNode = (id: string): string | null => unprefixFragmentNodeId(id, packId)
      const fragEdit = remapEditToFragment(edit, mapNode)
      if (!fragEdit) return // an edit whose node(s) don't belong to this pack — never routable

      const writableId = writableIdFor(packId, get().forkedPacks)

      if (writableId) {
        // ── Subsequent edit: write through to the fork's fragment doc directly ─────────────────────
        const source = (await api().getAgentPackFragment(profileId, writableId)) as WorkflowDoc | null
        if (!source) return
        if (!fragmentEditApplies(source, fragEdit)) return // stale edit (node already gone) — drop it
        const next = applyFragmentEdit(source, fragEdit)
        const res = await api().updateAgentPackFragment(profileId, writableId, next)
        if (!res?.ok) {
          pushInvalidToast(res?.code)
          return
        }
        await get().fetch(profileId, chatId, worldId)
        return
      }

      // ── First edit: the edit IS the fork (ADR 0006) ────────────────────────────────────────────
      // Exclusivity rule (grounded): we only WRITE THROUGH to a fork we created THIS SESSION for THIS
      // world (forkPack repoints only this world, so a fresh fork's activation is this world's alone).
      // For anything else — a builtin, an upstream install, or a fork we did NOT create this session
      // (which another world might share) — forking AGAIN is the ADR 0006 safe default: it never
      // mutates a shared artifact. So "already a fork owned by this world" = membership in forkedPacks.
      const source = (await api().getAgentPackFragment(profileId, packId)) as WorkflowDoc | null
      if (!source) return
      if (!fragmentEditApplies(source, fragEdit)) return
      const edited = applyFragmentEdit(source, fragEdit)
      const res = await api().forkAgentPack(profileId, packId, worldId, edited)
      if (!res?.ok || !res.pack) {
        pushInvalidToast('invalid')
        return
      }
      const forkId: string = res.pack.id
      // Record BOTH source→fork AND fork→fork (so a re-edit of the now-forked node, which the recompose
      // presents under the FORK's prefix, routes as write-through, not a second fork).
      set({ forkedPacks: { ...get().forkedPacks, [packId]: forkId, [forkId]: forkId } })
      await get().fetch(profileId, chatId, worldId)
      pushForkToast(res.pack.manifest)
    }),

  forkPackExplicit: async (packId) => {
    const { profileId, chatId, worldId, forkedPacks } = get()
    if (!profileId || !chatId || !worldId) return
    if (writableIdFor(packId, forkedPacks)) return // already forked this world/session — no-op
    const res = await api().forkAgentPack(profileId, packId, worldId)
    if (!res?.ok || !res.pack) return
    const forkId: string = res.pack.id
    set({ forkedPacks: { ...get().forkedPacks, [packId]: forkId, [forkId]: forkId } })
    await get().fetch(profileId, chatId, worldId)
    pushForkToast(res.pack.manifest)
  },

  clear: () =>
    set({
      doc: null,
      warnings: [],
      packs: [],
      chatId: null,
      worldId: null,
      profileId: null,
      forkedPacks: {},
      error: false
    })
}))

// ── Toasts (non-blocking; ADR 0006: no prompt, no choice — the edit already happened) ───────────────
//
// Undo: SHIPPED WITHOUT. The toast store (toastStore.ts) is a plain push(msg) with no action-button
// surface, and undo would need to uninstall the fork + RESTORE the source's deleted activation — but
// forkPack does not return the removed rows, so restoring them is not cheap with the current store
// API. Per the task, we ship without Undo and say so (WP report). The toast still tells the user what
// happened and that the world now uses their copy.

const pushForkToast = (manifest: { name: string; fork?: { base: string; n: number } }): void => {
  const name = manifest.fork
    ? `${manifest.fork.base} (${t('workflowEffective.fork')} ${manifest.fork.n})`
    : manifest.name
  useToastStore.getState().push(t('workflowEffective.forkedToast', { name }))
}

const pushInvalidToast = (code?: string): void => {
  const key = code === 'builtin' ? 'workflowEffective.forkWriteBuiltin' : 'workflowEffective.forkWriteInvalid'
  useToastStore.getState().push(t(key))
}

// ── Edit remapping (projection node ids → fragment node ids) ────────────────────────────────────────

/** Remap a FragmentEdit's node ids from projection (prefixed) to fragment (un-prefixed) ids via
 *  `mapNode`. Returns null when any referenced node is not this pack's (mapNode → null) — the edit is
 *  then not routable to this pack and is dropped. Pure over `mapNode`. */
export function remapEditToFragment(
  edit: FragmentEdit,
  mapNode: (id: string) => string | null
): FragmentEdit | null {
  switch (edit.kind) {
    case 'config':
    case 'panel':
    case 'mainOutput':
    case 'removeNode': {
      const nodeId = mapNode(edit.nodeId)
      return nodeId == null ? null : { ...edit, nodeId }
    }
    case 'connect':
    case 'removeEdge': {
      const from = mapNode(edit.from.node)
      const to = mapNode(edit.to.node)
      if (from == null || to == null) return null // a cross-owner edge is a splice edge — stays locked
      return { ...edit, from: { node: from, port: edit.from.port }, to: { node: to, port: edit.to.port } }
    }
  }
}
