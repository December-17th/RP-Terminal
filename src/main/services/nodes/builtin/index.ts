import { createRegistry } from '../registry'
import {
  inputContext,
  contextRefresh,
  promptAssemble,
  llmSample,
  parseResponseNode,
  applyState,
  outputWriteFloor
} from './generationNodes'
import { controlIf, controlSwitch, controlWhen } from './controlNodes'
import { textTemplate, promptMessages, mergeMessages, messagesTrim } from './messageNodes'
import { mvuSet } from './mvuNodes'
import { utilLog } from './utilNodes'
import { toolStartCombat, toolStartDuel, toolLorebookSearch } from './toolNodes'
import { lorebookSelect, lorebookEntries } from './lorebookNodes'
import { promptPreset } from './presetNodes'
import { varsGet, varsSave } from './varsNodes'
import { parseExtract } from './parseNodes'
import { tableApply, tableExport, tableGate, tableRead, tableQuery } from './tableNodes'
import {
  contextHistory,
  contextCard,
  contextPersona,
  contextAction,
  contextParams,
  contextTrimProcessed
} from './contextNodes'
import {
  subgraphInput,
  subgraphOutput,
  subgraphCall,
  subgraphLoop,
  setBuiltinRegistry
} from './subgraphNodes'
import { triggerState, triggerCadence, triggerManual } from './triggerNodes'

/** The registry of all built-in node types (Phase 2b-1b task 5, +2b-2 control/authoring nodes,
 *  +sub-graph nodes v1). Backs the default graph and any future card/workflow authoring surface
 *  — see spec §14 extensibility. */
export const builtinRegistry = createRegistry([
  inputContext,
  contextRefresh,
  promptAssemble,
  llmSample,
  parseResponseNode,
  applyState,
  outputWriteFloor,
  controlIf,
  controlSwitch,
  controlWhen,
  textTemplate,
  promptMessages,
  mergeMessages,
  messagesTrim,
  mvuSet,
  utilLog,
  toolStartCombat,
  toolStartDuel,
  toolLorebookSearch,
  lorebookSelect,
  lorebookEntries,
  promptPreset,
  varsGet,
  varsSave,
  parseExtract,
  tableApply,
  tableExport,
  tableGate,
  tableRead,
  tableQuery,
  contextHistory,
  contextCard,
  contextPersona,
  contextAction,
  contextParams,
  contextTrimProcessed,
  subgraphInput,
  subgraphOutput,
  subgraphCall,
  subgraphLoop,
  triggerState,
  triggerCadence,
  triggerManual
])

// subgraph.call needs the full registry (to run a nested doc's own node types via runSubgraph),
// but the registry's own list includes subgraphCall — a static import cycle subgraphNodes.ts
// can't close from its side. Wire it here, once, right after construction (see subgraphNodes.ts's
// header comment).
setBuiltinRegistry(builtinRegistry)
