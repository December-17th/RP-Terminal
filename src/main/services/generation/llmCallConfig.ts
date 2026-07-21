import { z } from 'zod'
import type { LlmCallConfig } from './mainSample'

/**
 * The zod schema for `LlmCallConfig` + its assembler, relocated OUT of the `llm.sample`/`agent.llm` node
 * file (`nodes/builtin/generationNodes.ts`) into `generation/` (execution-plan M5c-1) so the survivors
 * that share them — the memory maintainer composer (`memory/maintainerCompose.ts`, whose config schema
 * `.extend()`s this) — keep them after the node engine is deleted. Moved VERBATIM. `generationNodes.ts`
 * re-imports both so its nodes (and `memoryNodes.ts`) resolve them unchanged.
 */

/** The zod schema for LlmCallConfig — llm.sample uses it directly; agent.llm / memory.maintain extend it. */
export const llmCallConfigSchema = z.object({
  stream: z.boolean().optional(),
  api_preset_id: z.string().optional(),
  retries: z.number().int().min(0).max(5).optional(),
  retry_delay_s: z.number().min(0).max(300).optional(),
  fallback_preset_id: z.string().optional(),
  validator: z.enum(['none', 'non_empty', 'regex', 'json']).optional(),
  validator_pattern: z.string().optional(),
  validator_retries: z.number().int().min(0).max(3).optional(),
  corrective_nudge: z.string().optional()
})

/** Assemble the `LlmCallConfig` from a parsed config carrying the `llmCallConfigSchema` fields — the
 *  conditional-spread the side-call nodes share. `agent.llm` and `memory.maintain` are side calls, so
 *  `stream` defaults to false here (a maintenance/agent reply must not pollute the player stream); pass
 *  a config whose `stream` is `true` to opt into streaming. */
export const buildLlmCallConfig = (cfg: z.infer<typeof llmCallConfigSchema>): LlmCallConfig => ({
  stream: cfg.stream === true,
  ...(cfg.api_preset_id ? { api_preset_id: cfg.api_preset_id } : {}),
  ...(cfg.retries != null ? { retries: cfg.retries } : {}),
  ...(cfg.retry_delay_s != null ? { retry_delay_s: cfg.retry_delay_s } : {}),
  ...(cfg.fallback_preset_id ? { fallback_preset_id: cfg.fallback_preset_id } : {}),
  ...(cfg.validator ? { validator: cfg.validator } : {}),
  ...(cfg.validator_pattern ? { validator_pattern: cfg.validator_pattern } : {}),
  ...(cfg.validator_retries != null ? { validator_retries: cfg.validator_retries } : {}),
  ...(cfg.corrective_nudge ? { corrective_nudge: cfg.corrective_nudge } : {})
})
