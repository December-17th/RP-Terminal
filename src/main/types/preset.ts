import { z } from 'zod'

/**
 * Sampler / generation parameters sent to the provider. Superset of OpenAI +
 * common OpenRouter knobs; providers ignore what they don't support.
 */
export const PresetParametersSchema = z.object({
  temperature: z.number().default(0.9),
  max_tokens: z.number().default(4000),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  min_p: z.number().optional(),
  top_a: z.number().optional()
})
export type PresetParameters = z.infer<typeof PresetParametersSchema>

/**
 * A marker tells the prompt builder to expand this block into dynamic content
 * instead of using its literal `content`. `none` = literal prompt block.
 */
export const PromptMarker = z.enum([
  'none',
  'char_description', // name/description/personality/scenario
  'mes_example', // example dialogue
  'world_info', // lorebook injections
  'persona_description', // user persona description (ST personaDescription / IN_PROMPT)
  'chat_history', // the running conversation
  'post_history' // post_history_instructions (jailbreak / final reminder)
])
export type PromptMarker = z.infer<typeof PromptMarker>

export const PromptBlockSchema = z.object({
  identifier: z.string(),
  name: z.string().default(''),
  role: z.enum(['system', 'user', 'assistant']).default('system'),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
  marker: PromptMarker.default('none'),
  /** Inject a literal block into the chat history this many messages up from the
   * bottom instead of inline. null = inline, in preset order (the default).
   * Ignored for marker blocks (char_description, chat_history, …). */
  injection_depth: z.number().nullable().default(null)
})
export type PromptBlock = z.infer<typeof PromptBlockSchema>

export const PresetSchema = z.object({
  name: z.string().default('Default Preset'),
  parameters: PresetParametersSchema.default({ temperature: 0.9, max_tokens: 4000 }),
  /** Ordered list of prompt blocks assembled into the final message array. */
  prompts: z.array(PromptBlockSchema).default([])
})
export type Preset = z.infer<typeof PresetSchema>

/**
 * A sensible default preset: main instruction, character definition, world
 * info, the running history, then a post-history reminder. This gives real
 * ordering control out of the box and is what imported ST presets fall back to
 * for any markers we can't map.
 */
export const getDefaultPreset = (): Preset => ({
  name: 'Default Preset',
  parameters: { temperature: 0.9, max_tokens: 4000 },
  prompts: [
    {
      identifier: 'main',
      name: 'Main Prompt',
      role: 'system',
      content:
        'You are an expert roleplay partner and game master. Stay in character as {{char}}. Write vivid, immersive prose in response to {{user}}. Never break character or mention you are an AI.',
      enabled: true,
      marker: 'none',
      injection_depth: null
    },
    {
      identifier: 'char_description',
      name: 'Character Description',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'char_description',
      injection_depth: null
    },
    {
      identifier: 'mes_example',
      name: 'Example Dialogue',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'mes_example',
      injection_depth: null
    },
    {
      identifier: 'world_info',
      name: 'World Info',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'world_info',
      injection_depth: null
    },
    {
      identifier: 'chat_history',
      name: 'Chat History',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'chat_history',
      injection_depth: null
    },
    {
      identifier: 'post_history',
      name: 'Post-History Instructions',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'post_history',
      injection_depth: null
    }
  ]
})
