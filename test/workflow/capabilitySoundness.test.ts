import { describe, it, expect } from 'vitest'
import { builtinRegistry } from '../../src/main/services/nodes/builtin'
import {
  capabilityOfNodeType,
  INERT_NODE_TYPES,
  deriveCapabilityReport
} from '../../src/shared/workflow/capabilities'
import { WorkflowDoc } from '../../src/shared/workflow/types'

// SOUNDNESS (ADR 0007): capability derivation is ENFORCEMENT now, not advice. The invariant this
// file guards is: EVERY registered builtin node type is EITHER capability-mapped
// (NODE_TYPE_CAPABILITY) OR in the justified inert ALLOWLIST (INERT_NODE_TYPES) — never neither. A
// new node type added to the registry with no mapping and no allowlist entry FAILS here, forcing a
// deliberate decision ("does this node touch durable state / call the model / run a tool?"). That is
// the whole point: no node type may silently derive zero capabilities.
//
// This test imports MAIN (the registry) — the established test-side convention for enumerating the
// real node set (see asyncMemoryPack.test.ts etc.). The derivation itself stays pure/shared.

const registeredTypes = [...builtinRegistry.descriptors().keys()]

describe('capability derivation soundness (ADR 0007)', () => {
  it('every registered builtin type is mapped OR explicitly inert — never neither', () => {
    const unclassified = registeredTypes.filter(
      (type) => capabilityOfNodeType(type) === undefined && !INERT_NODE_TYPES.has(type)
    )
    // If this fails, a node type was registered without deciding its capability. Add it to
    // NODE_TYPE_CAPABILITY (if it reads/writes durable state, calls the LLM, or runs a game tool) or
    // to INERT_NODE_TYPES with a one-line justification (if it is pure plumbing / control flow).
    expect(unclassified).toEqual([])
  })

  it('no type is BOTH mapped and inert (the "exactly one table" invariant)', () => {
    const both = registeredTypes.filter(
      (type) => capabilityOfNodeType(type) !== undefined && INERT_NODE_TYPES.has(type)
    )
    expect(both).toEqual([])
  })

  it('the inert allowlist contains no phantom entries (every entry is a registered type)', () => {
    const known = new Set(registeredTypes)
    const phantom = [...INERT_NODE_TYPES].filter((type) => !known.has(type))
    expect(phantom).toEqual([])
  })

  it('deriveCapabilityReport surfaces NO unknown types for an all-builtin fragment', () => {
    const knownTypes = new Set(registeredTypes)
    const doc: WorkflowDoc = {
      id: 'f',
      name: 'f',
      version: 1,
      schemaVersion: 1,
      kind: 'fragment',
      nodes: registeredTypes.map((type, i) => ({ id: `n${i}`, type })),
      edges: [],
      attachments: []
    }
    const report = deriveCapabilityReport(doc, knownTypes)
    expect(report.unknownNodeTypes).toEqual([])
  })
})
