// The value shape at each agent-pack checkpoint: the PortType of the value flowing where a
// fragment enters or rejoins the narrator's main path. The PortType-FREE half of this ABI (the
// checkpoint id vocabulary and the AttachmentDecl shapes) lives in ./attachments.ts; keeping them
// apart lets ./types.ts type WorkflowDoc.attachments without an import cycle.
//
// Spec: docs/superpowers/specs/2026-07-03-agent-pack-workflow-ux-design-revision-3.md §Runtime
// Model ("The v1 checkpoint vocabulary (frozen at four)"). Decisions: ADR 0002 (fragments attach
// at checkpoints) and ADR 0009 (one pack, one graph, many attachments). Glossary: root CONTEXT.md.
//
// Pure: imports only the shared graph types + attachment ids. Safe from main, renderer, preload,
// and tests — no I/O.
import { PortType } from './types'
import { CheckpointId } from './attachments'

// Re-export the id vocabulary + narrowing so consumers can import everything checkpoint-related
// from one place, without knowing about the internal ./attachments split.
export { CHECKPOINT_IDS, isCheckpointId } from './attachments'
export type { CheckpointId } from './attachments'

/** One anchor LANE of a checkpoint: a named port on the checkpoint's anchor node that a rejoin can
 *  land on. The lane's `port` doubles as the selector name a `RejoinAttachment.anchor` uses.
 *  WP1.6b controller decision: `prompt-assembly` stays ONE checkpoint but gains TWO named anchor
 *  ports — the blocked thing (WP1.6 ABI finding: the table-memory pack could not reproduce
 *  `export.entries → assemble.entries`) is the same concept, "inject into prompt assembly", so it
 *  is one checkpoint with two lanes, NOT a fifth checkpoint. */
export interface CheckpointAnchor {
  /** The port on `anchorNode` this lane lands on — ALSO the selector name a rejoin uses. */
  port: string
  /** The PortType of the value flowing on this lane. */
  valueType: PortType
}

/** A checkpoint's position on the narrator's main path and the PortType of the value flowing
 *  there. `anchorNode`/`anchorPort` name the builtin-spine node + port the checkpoint sits on —
 *  informative here (they let a later WP locate the anchor) and the evidence for `valueType`.
 *
 *  `anchors` lists EVERY lane, DEFAULT FIRST. `anchorPort`/`valueType` stay pinned to the DEFAULT
 *  lane (== anchors[0]) so single-anchor consumers are untouched — the WP1.6b shape change is
 *  backward-clean for the three single-lane checkpoints. */
export interface CheckpointSpec {
  id: CheckpointId
  /** The DEFAULT lane's value type (== anchors[0].valueType). */
  valueType: PortType
  /** The builtin-spine node type this checkpoint anchors on (defaultGraph.ts spine). */
  anchorNode: string
  /** The DEFAULT lane's port on `anchorNode` (== anchors[0].port). */
  anchorPort: string
  /** Every anchor lane, default first. Single-lane checkpoints list exactly one entry. */
  anchors: readonly CheckpointAnchor[]
}

/** Resolve a rejoin's anchor lane on `spec`: no selector → the default lane (anchors[0]); a
 *  selector → the lane whose port name matches, or undefined (unknown selector — the caller
 *  reports it: validate.ts UNKNOWN_ANCHOR, compose.ts 'unknown-anchor-port'). */
export function resolveAnchorLane(
  spec: CheckpointSpec,
  selector?: string
): CheckpointAnchor | undefined {
  if (selector === undefined) return spec.anchors[0]
  return spec.anchors.find((a) => a.port === selector)
}

/**
 * The v1 checkpoint specs, keyed by id. Value types are derived from the builtin spine's REAL
 * port types at each anchor — NOT guessed. Evidence (all in
 * src/main/services/nodes/builtin/generationNodes.ts, wired by defaultGraph.ts):
 *
 *  - context-ready  → output of `input.context`, port `gen` : `Context`
 *      generationNodes.ts:22-30 (`inputContext.outputs = [{ name: 'gen', type: 'Context' }]`).
 *      Anchors on the `ctx` node's `gen` output in defaultGraph.ts:15.
 *
 *  - prompt-assembly → the injection-accepting inputs of `prompt.assemble` — TWO LANES (WP1.6b):
 *      generationNodes.ts:71-94. `prompt.assemble` has three inputs — `gen` (Context, the main
 *      flow), `block` (Text) and `entries` (Any). Per spec §Runtime Model the checkpoint "accepts
 *      prompt-injection contributions (block + placement)":
 *        · lane `block` (DEFAULT) : `Text` — the plain injected text tail (generationNodes.ts:76).
 *        · lane `entries` : `Any` — pre-qualified LorebookEntry[] CONCATENATED onto the scanned
 *          world-info matches before assembly, so the contribution rides the real placement/depth
 *          machinery (generationNodes.ts:65-93; the port is `Any` on the wire —
 *          generationNodes.ts:77 — and the run() treats it as LorebookEntry[],
 *          generationNodes.ts:86-89). This is the placement half the spec promised; pinned in
 *          WP1.6b after the table-memory pack (WP1.6) could not reproduce its
 *          `export.entries → assemble.entries` injection through the block-only anchor.
 *      The `assemble` node is defaultGraph.ts:16; BOTH lanes are intentionally left unwired in the
 *      default graph (defaultGraph.ts:6 comment).
 *
 *  - reply-parsed   → output of `parse.response`, port `parsed` : `Any`
 *      generationNodes.ts:182-207. `parse.response` outputs `parsed`/`mvu`/`metrics`, ALL `Any`
 *      (generationNodes.ts:191-195). The spec's "parsed reply + Context" value maps to the primary
 *      `parsed` output; the narrowest existing PortType that matches the parsed structure is `Any`
 *      (there is no dedicated parsed-reply PortType in PORT_TYPES). Anchor: the `parse` node,
 *      defaultGraph.ts:18.
 *
 *  - turn-committed → output of `output.writeFloor`, port `floor` : `Any`
 *      generationNodes.ts:234-260. `output.writeFloor` (the isMainOutput node) has a single output
 *      `floor`, typed `Any` (generationNodes.ts:245). The spec's "final floor + Context" value maps
 *      to this `floor` output; narrowest matching PortType is `Any`. Anchor: the `write` node,
 *      defaultGraph.ts:20.
 */
export const CHECKPOINTS: Readonly<Record<CheckpointId, CheckpointSpec>> = {
  'context-ready': {
    id: 'context-ready',
    valueType: 'Context',
    anchorNode: 'input.context',
    anchorPort: 'gen',
    anchors: [{ port: 'gen', valueType: 'Context' }]
  },
  'prompt-assembly': {
    id: 'prompt-assembly',
    valueType: 'Text',
    anchorNode: 'prompt.assemble',
    anchorPort: 'block',
    // Two lanes (WP1.6b): `block` (default, plain text tail) and `entries` (placement-carrying
    // LorebookEntry[] — generationNodes.ts:65-93). See the evidence block above.
    anchors: [
      { port: 'block', valueType: 'Text' },
      { port: 'entries', valueType: 'Any' }
    ]
  },
  'reply-parsed': {
    id: 'reply-parsed',
    valueType: 'Any',
    anchorNode: 'parse.response',
    anchorPort: 'parsed',
    anchors: [{ port: 'parsed', valueType: 'Any' }]
  },
  'turn-committed': {
    id: 'turn-committed',
    valueType: 'Any',
    anchorNode: 'output.writeFloor',
    anchorPort: 'floor',
    anchors: [{ port: 'floor', valueType: 'Any' }]
  }
} as const
