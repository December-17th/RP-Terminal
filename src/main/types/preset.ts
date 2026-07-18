import { z } from 'zod'
import { SPresetProjectionSchema } from '../../shared/spreset'

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
  top_a: z.number().optional(),
  /** Stop sequences (SPreset ChatSquash — issue 16). Optional, set ONLY when a ChatSquash config
   *  enables stop strings; forwarded on the OpenAI-compatible path (`cleanParams` spread). Native
   *  presets never carry it, so the request body is byte-identical (parity gate). */
  stop: z.array(z.string()).optional()
})
export type PresetParameters = z.infer<typeof PresetParametersSchema>

/**
 * A marker tells the prompt builder to expand this block into dynamic content
 * instead of using its literal `content`. `none` = literal prompt block.
 *
 * ST 1.18.0 keeps World Info, Character Personality, and Scenario as DISTINCT default
 * markers (openai.js:1365-1371), each free to take its own role/position. RPT mirrors
 * that for ST IMPORTS: `worldInfoBefore`/`worldInfoAfter` → `world_info_before`/
 * `world_info_after`, `charPersonality` → `char_personality`, `scenario` → `scenario`.
 * NATIVE RPT presets keep the single, simpler `world_info` marker and fold personality +
 * scenario into `char_description` (getDefaultPreset below) — the builder emits the folded
 * fields only when no distinct personality/scenario marker is present, so the two coexist.
 */
export const PromptMarker = z.enum([
  'none',
  'char_description', // name/description (+personality/scenario when no distinct marker)
  'char_personality', // ST charPersonality marker (imports); own role/position
  'scenario', // ST scenario marker (imports); own role/position
  'mes_example', // example dialogue
  'world_info', // lorebook injections (NATIVE presets: the single combined block)
  'world_info_before', // ST worldInfoBefore marker (↑Char); imports
  'world_info_after', // ST worldInfoAfter marker (↓Char); imports
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
  injection_depth: z.number().nullable().default(null),
  /** ST `injection_order` (openai.js:824-833): same-depth in-chat injections are grouped by this
   * value and processed HIGH→LOW during ST's build (which then reverses the whole array). Default
   * 100 — the value ST's own extension IN_CHAT prompts use, so a plain depth block merges with them.
   * Only meaningful on in-chat (depth-injected) blocks; ignored for relative/inline ones. */
  injection_order: z.number().default(100),
  /** ST `injection_trigger`: a generation-type allow-list (PromptManager.js:1549-1553).
   * Empty = fires for ALL generation types; otherwise the lowercased current generation
   * type must be listed for the block to be included. Carried from ST imports; the builder
   * filters against `BuildPromptArgs.generationType`. */
  injection_trigger: z.array(z.string()).default([]),
  /** ST `forbid_overrides`: when true, a character card's system-prompt / post-history
   * override must NOT replace this block (openai.js:1489/1499). Only meaningful on the
   * `main` / `jailbreak` literal blocks that overrides target. */
  forbid_overrides: z.boolean().default(false)
})
export type PromptBlock = z.infer<typeof PromptBlockSchema>

export const PresetSchema = z.object({
  name: z.string().default('Default Preset'),
  parameters: PresetParametersSchema.default({ temperature: 0.9, max_tokens: 4000 }),
  /** Ordered list of prompt blocks assembled into the final message array. */
  prompts: z.array(PromptBlockSchema).default([]),
  /**
   * ST `oai_settings.squash_system_messages` (openai.js:1599-1601). Carried ONLY by imported ST
   * presets (the parser sets an explicit boolean); NATIVE presets leave it UNDEFINED. The provider
   * seam (`providerShape`) reads it: `true` → ST selective system-message squash (openai.js:3827);
   * `false`/undefined → RPT's merge-all-adjacent (`mergeConsecutiveRoles`). Optional-without-default
   * so a native preset never gains the key and its wire output stays byte-identical (parity gate).
   */
  squash_system_messages: z.boolean().optional(),
  /**
   * ST per-marker FORMAT strings (`oai_settings.wi_format` / `personality_format` / `scenario_format`,
   * openai.js:106,112-113). Carried ONLY by imported ST presets (the parser sets them, defaulting to ST's
   * own defaults `{0}` / `{{personality}}` / `{{scenario}}`); NATIVE presets leave them UNDEFINED. Their
   * presence is the IMPORT signal the builder uses to switch the char/scenario/personality/world-info
   * markers to ST-faithful formatting (bare charDescription, `stringFormat(wi_format, …)`,
   * `substituteParams(personality_format|scenario_format)`) instead of RPT's native `Name:/Description:`
   * + `World Info:\n` shape. Optional-without-default so a native preset never gains the key and its wire
   * output stays byte-identical (parity gate). See promptBuilder `renderWorldInfo` / the marker cases.
   */
  wi_format: z.string().optional(),
  personality_format: z.string().optional(),
  scenario_format: z.string().optional(),
  /**
   * SPreset (`extensions.SPreset`) runtime projection (issue 16 / WP-2.6), mirroring how
   * `squash_system_messages` is projected. Present ONLY on an imported preset that carries the SPreset
   * namespace (or its `SPresetSettings` mirror block); NATIVE presets leave it UNDEFINED so their build
   * is byte-identical (parity gate). The assembly path reads the flags here — never the envelope:
   * `regexBindingEnabled` selects the preset-first regex tier order, `macroNest` gates macro nesting,
   * `chatSquash` drives the ChatSquash pass. The bound regex records themselves are installed into the
   * regex store at import (kept DISTINCT from core `regex_scripts`), not carried here.
   */
  spreset: SPresetProjectionSchema.optional()
})
export type Preset = z.infer<typeof PresetSchema>

/**
 * A **Preset Envelope** (ADR 0018) is the lossless provenance record kept alongside
 * the lossy normalized `Preset` view above. The runtime consumes the normalized view;
 * the envelope preserves *everything* the imported ST preset carried — every
 * `prompt_order` list, every prompt field (`injection_order`/`injection_trigger`/
 * `forbid_overrides`/`marker`), full `extensions.*` (SPreset, tavern_helper),
 * and unknown top-level fields — so nothing is ever destroyed at import.
 *
 * The stored bytes + SHA-256 describe the *import*, not the current edited state:
 * edits mutate the normalized view in place and never touch the envelope (deliberate —
 * provenance, not integrity enforcement). A preset never edited in RPT round-trips
 * byte-exact from `originalBase64`; otherwise export re-serializes semantic JSON.
 */
export const PresetEnvelopeSchema = z.object({
  /** SHA-256 (hex) of the verbatim original bytes. null when the preset came from a
   *  pre-parsed World Card bundle (no original file bytes to hash). */
  sha256: z.string().nullable().default(null),
  /** The parsed, nothing-dropped JSON, exactly as `JSON.parse` produced it at import. */
  parsed: z.any(),
  /** Verbatim original file bytes, base64-encoded. null for pre-parsed bundles.
   *  Byte-exact re-export is possible only when this is present. */
  originalBase64: z.string().nullable().default(null),
  /** ISO timestamp of the import. */
  importedAt: z.string(),
  /** Identifies the importer that produced this envelope, for future format migrations. */
  importerVersion: z.string(),
  /**
   * Normalized view at import time. This lets semantic export distinguish an editor change from a
   * parser default when the raw JSON omitted the edited key (for example a nameless preset).
   * Optional for envelopes written before this snapshot was introduced.
   */
  importedView: PresetSchema.optional()
})
export type PresetEnvelope = z.infer<typeof PresetEnvelopeSchema>

/**
 * A sensible default preset: main instruction, character definition, world
 * info, the running history, then a post-history reminder. This gives real
 * ordering control out of the box and is what imported ST presets fall back to
 * for any markers we can't map.
 *
 * NATIVE representation (deliberate, see the PromptMarker note): one combined
 * `world_info` marker (not the ST `world_info_before`/`world_info_after` pair) and no
 * distinct `char_personality`/`scenario` markers — `char_description` folds Name +
 * Description + Personality + Scenario. ST IMPORTS get the split markers from the parser
 * instead; the builder honors either shape.
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
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    },
    {
      identifier: 'char_description',
      name: 'Character Description',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'char_description',
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    },
    {
      identifier: 'mes_example',
      name: 'Example Dialogue',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'mes_example',
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    },
    {
      identifier: 'world_info',
      name: 'World Info',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'world_info',
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    },
    {
      identifier: 'chat_history',
      name: 'Chat History',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'chat_history',
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    },
    {
      identifier: 'post_history',
      name: 'Post-History Instructions',
      role: 'system',
      content: '',
      enabled: true,
      marker: 'post_history',
      injection_depth: null,
      injection_order: 100,
      injection_trigger: [],
      forbid_overrides: false
    }
  ]
})
