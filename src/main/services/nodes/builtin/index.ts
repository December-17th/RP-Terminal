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

/** The registry of all built-in node types (Phase 2b-1b task 5). Backs the default graph and
 *  any future card/workflow authoring surface — see spec §14 extensibility. */
export const builtinRegistry = createRegistry([
  inputContext,
  memoryRecallNode,
  promptAssemble,
  llmSample,
  parseResponseNode,
  applyState,
  outputWriteFloor,
  memoryCompact
])
