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

/** The registry of all built-in node types (Phase 2b-1b task 5, +2b-2 control/authoring nodes).
 *  Backs the default graph and any future card/workflow authoring surface — see spec §14
 *  extensibility. */
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
  mvuSet
])
