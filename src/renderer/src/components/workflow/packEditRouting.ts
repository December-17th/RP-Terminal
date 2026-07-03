// Pure edit-routing helpers for the Workflow view's EFFECTIVE mode pack-node editing (agent-packs
// plan WP3.6b; ADR 0006 + 0010). The React-free, side-effect-free half of "the edit IS the fork":
// map a projection (prefixed) node id back to its packId + original fragment node id, and apply an
// edit to a COPY of the source fragment doc. NO React / @xyflow / src/main imports (mirrors
// effectiveProjection.ts) so it stays vitest-testable under Node and clears check:deps (this module
// may import only shared/workflow, which is pure).
//
// Grounding (read, not inferred):
//   · compose.ts stamps every spliced fragment node id EXACTLY `pack:<packId>:<origId>`
//     (PACK_PREFIX / packNodeId, compose.ts:114-119). unprefixFragmentNodeId is the inverse of that
//     within a KNOWN packId: strip `pack:<packId>:` and the remainder is the ORIGINAL fragment node
//     id (fragment ids carry no colon). We take the packId from the projection's owner map
//     (authoritative), so we never have to guess where the packId ends.
//   · A pack edit ALWAYS targets the SOURCE fragment doc (the pack's stored `kind:'fragment'`
//     WorkflowDoc), never the composed projection — the projection is recomposed from sources after
//     every write (ADR 0010). So applyFragmentEdit takes the fragment doc + an edit keyed by the
//     ORIGINAL (un-prefixed) fragment node id, and returns a NEW fragment doc (never mutates input).

import { WorkflowDoc } from '../../../../shared/workflow/types'
import { PACK_PREFIX, packNodeId } from '../../../../shared/workflow/compose'

// ── Prefix ↔ fragment-node mapping ────────────────────────────────────────────────────────────────

/** Strip the `pack:<packId>:` prefix from a projection node id to recover the ORIGINAL fragment node
 *  id, given the KNOWN packId. Returns null when `id` is not a node of that pack (unprefixed, or a
 *  different pack) — the caller treats null as "not routable to this pack". Pure. */
export function unprefixFragmentNodeId(id: string, packId: string): string | null {
  const prefix = `${PACK_PREFIX}${packId}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : null
}

/** Re-derive the projection node id for an ORIGINAL fragment node id under `packId` — the forward of
 *  unprefixFragmentNodeId (kept for callers that need to re-select the node after a recompose). */
export function prefixFragmentNodeId(packId: string, origNodeId: string): string {
  return packNodeId(packId, origNodeId)
}

/** The owner packId of an edit, from its (projection-prefixed) node ids, using the authoritative owner
 *  map with the id-string parse as the fallback. Returns null for a narrator-owned edit or a
 *  cross-owner (splice) edge — such edits are NOT routed to any pack (splice edges stay locked this
 *  WP). Pure. Used by the router to pick which pack forks / writes through. */
export function ownerPackOfEdit(
  edit: FragmentEdit,
  ownerOf: (id: string) => string | null
): string | null {
  switch (edit.kind) {
    case 'config':
    case 'panel':
    case 'mainOutput':
    case 'removeNode':
      return ownerOf(edit.nodeId)
    case 'connect':
    case 'removeEdge': {
      const from = ownerOf(edit.from.node)
      const to = ownerOf(edit.to.node)
      // Only a pack-INTERNAL edge (both ends the same pack) is routable; a splice / narrator edge → null.
      return from != null && from === to ? from : null
    }
  }
}

// ── Fragment edits (applied to a COPY of the source fragment doc) ──────────────────────────────────
//
// The edit set mirrors the model-layer lock guards WP3.6a placed on pack nodes (setNodeConfig,
// removeNode, connect/removeEdge, setMainOutput/setNodePanel) — the same actions that must now route
// through the fork instead of being dropped. POSITION moves are deliberately NOT here (see
// WorkflowEditorView / the WP report): a drag alone must not fork, and pack node positions are
// projection-programmatic anyway (they are never written back to the fragment). Every edit is keyed
// by the ORIGINAL fragment node id (post-unprefix), targets the fragment doc, and is PURE.

export type FragmentEdit =
  | { kind: 'config'; nodeId: string; config: Record<string, unknown> }
  | { kind: 'panel'; nodeId: string; panel: { show: boolean; label?: string } | undefined }
  | { kind: 'mainOutput'; nodeId: string }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'connect'; from: { node: string; port: string }; to: { node: string; port: string } }
  | { kind: 'removeEdge'; from: { node: string; port: string }; to: { node: string; port: string } }

/** Whether an edit maps cleanly onto the given fragment (its target node(s) exist). A stale edit
 *  (node already removed by a racing write) returns false so the caller can drop it rather than
 *  produce an incoherent fragment. Pure. */
export function fragmentEditApplies(doc: WorkflowDoc, edit: FragmentEdit): boolean {
  const has = (id: string): boolean => doc.nodes.some((n) => n.id === id)
  switch (edit.kind) {
    case 'config':
    case 'panel':
    case 'mainOutput':
    case 'removeNode':
      return has(edit.nodeId)
    case 'connect':
    case 'removeEdge':
      return has(edit.from.node) && has(edit.to.node)
  }
}

/** Apply one FragmentEdit to a COPY of `doc`, returning the new fragment doc (input untouched).
 *  Edges are matched/added by (from.node, from.port, to.node, to.port) — the same identity the engine
 *  keys edges by (editorModel.edgeId). A no-op edit (target missing) returns a structural copy so the
 *  caller can always treat the result as the authoritative next fragment. Pure. */
export function applyFragmentEdit(doc: WorkflowDoc, edit: FragmentEdit): WorkflowDoc {
  const nodes = doc.nodes.map((n) => ({ ...n }))
  let edges = doc.edges.map((e) => ({ from: { ...e.from }, to: { ...e.to } }))

  const findNode = (id: string): (typeof nodes)[number] | undefined => nodes.find((n) => n.id === id)

  switch (edit.kind) {
    case 'config': {
      const node = findNode(edit.nodeId)
      if (node) {
        if (Object.keys(edit.config).length === 0) delete node.config
        else node.config = edit.config
      }
      break
    }
    case 'panel': {
      const node = findNode(edit.nodeId)
      if (node) {
        if (!edit.panel) delete node.panel
        else node.panel = edit.panel
      }
      break
    }
    case 'mainOutput': {
      // Exactly one main-output node (validateWorkflow's turn rule; fragments skip it but we keep the
      // single-flag invariant so a fork that is later run as-is stays well-formed).
      for (const n of nodes) {
        if (n.id === edit.nodeId) n.isMainOutput = true
        else if (n.isMainOutput) delete n.isMainOutput
      }
      break
    }
    case 'removeNode': {
      const i = nodes.findIndex((n) => n.id === edit.nodeId)
      if (i >= 0) nodes.splice(i, 1)
      edges = edges.filter((e) => e.from.node !== edit.nodeId && e.to.node !== edit.nodeId)
      break
    }
    case 'connect': {
      const exists = edges.some(
        (e) =>
          e.from.node === edit.from.node &&
          e.from.port === edit.from.port &&
          e.to.node === edit.to.node &&
          e.to.port === edit.to.port
      )
      if (!exists && findNode(edit.from.node) && findNode(edit.to.node)) {
        edges.push({ from: { ...edit.from }, to: { ...edit.to } })
      }
      break
    }
    case 'removeEdge': {
      edges = edges.filter(
        (e) =>
          !(
            e.from.node === edit.from.node &&
            e.from.port === edit.from.port &&
            e.to.node === edit.to.node &&
            e.to.port === edit.to.port
          )
      )
      break
    }
  }

  return { ...doc, nodes, edges }
}
