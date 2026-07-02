import { createRegistry } from '../registry'
import {
  inputContext,
  memoryRecallNode,
  promptAssemble,
  llmSample,
  parseResponseNode,
  applyState,
  outputWriteFloor,
  memoryCompact
} from './generationNodes'
import { controlIf, controlSwitch, controlWhen } from './controlNodes'
import { textTemplate, promptMessages, mergeMessages } from './messageNodes'
import { mvuSet } from './mvuNodes'
import { utilLog } from './utilNodes'
import { memoryGate, memoryExtract, memoryWrite, memoryQuery } from './memoryNodes'
import { toolStartCombat, toolStartDuel, toolLorebookSearch } from './toolNodes'
import { varsGet, varsSave } from './varsNodes'
import { contextHistory, contextCard, contextPersona } from './contextNodes'
import {
  subgraphInput,
  subgraphOutput,
  subgraphCall,
  subgraphLoop,
  setBuiltinRegistry
} from './subgraphNodes'

/** The registry of all built-in node types (Phase 2b-1b task 5, +2b-2 control/authoring nodes,
 *  +sub-graph nodes v1). Backs the default graph and any future card/workflow authoring surface
 *  — see spec §14 extensibility. */
export const builtinRegistry = createRegistry([
  inputContext,
  memoryRecallNode,
  promptAssemble,
  llmSample,
  parseResponseNode,
  applyState,
  outputWriteFloor,
  memoryCompact,
  controlIf,
  controlSwitch,
  controlWhen,
  textTemplate,
  promptMessages,
  mergeMessages,
  mvuSet,
  utilLog,
  memoryGate,
  memoryExtract,
  memoryWrite,
  memoryQuery,
  toolStartCombat,
  toolStartDuel,
  toolLorebookSearch,
  varsGet,
  varsSave,
  contextHistory,
  contextCard,
  contextPersona,
  subgraphInput,
  subgraphOutput,
  subgraphCall,
  subgraphLoop
])

// subgraph.call needs the full registry (to run a nested doc's own node types via runSubgraph),
// but the registry's own list includes subgraphCall — a static import cycle subgraphNodes.ts
// can't close from its side. Wire it here, once, right after construction (see subgraphNodes.ts's
// header comment).
setBuiltinRegistry(builtinRegistry)
