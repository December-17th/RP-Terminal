import { setAgentPresetAssembler } from './agentRuntime/prompt'
import { assembleAgentPresetPrompt } from './generation/agentPresetAssembly'

/**
 * Registration bridge for preset-driven Agent prompt assembly (ADR 0021).
 *
 * `generation/` already imports `agentRuntime/` (harnessDispatch.ts), so `agentRuntime` importing
 * the assembler back would close a cycle. Instead `agentRuntime` owns an empty slot and this module —
 * on the generation side of the boundary, imported once from `main/index.ts` — fills it at startup.
 * Same shape as `cardAgentCatalogBridge.ts`. Import for side effect only.
 */
setAgentPresetAssembler(assembleAgentPresetPrompt)
