import { z } from 'zod'

/**
 * A single World Info / Lorebook entry. Mirrors the ST `character_book` entry
 * shape (embedded lorebook) but normalized so both array-style (v3 embedded)
 * and object-keyed (standalone world info) sources map onto it.
 */
export const LorebookEntrySchema = z.object({
  keys: z.array(z.string()).default([]),
  secondary_keys: z.array(z.string()).default([]),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
  insertion_order: z.number().default(100),
  /** How many messages up from the bottom of the chat to inject this entry.
   * null = inject at the top (in the World Info block) — the default. */
  insertion_depth: z.number().nullable().default(null),
  case_sensitive: z.boolean().default(false),
  /** constant entries are always injected regardless of keyword match */
  constant: z.boolean().default(false),
  /** require a secondary key match in addition to a primary key */
  selective: z.boolean().default(false),
  /** % chance (0–100) a matched entry actually fires; <100 rolls each turn */
  probability: z.number().default(100),
  /** this entry can NOT be activated by recursion (only by the conversation scan) */
  exclude_recursion: z.boolean().default(false),
  /** this entry's content does NOT trigger further recursive matches */
  prevent_recursion: z.boolean().default(false),
  comment: z.string().default('')
})
export type LorebookEntry = z.infer<typeof LorebookEntrySchema>

export const LorebookSchema = z.object({
  name: z.string().default('Imported Lorebook'),
  entries: z.array(LorebookEntrySchema).default([])
})
export type Lorebook = z.infer<typeof LorebookSchema>

/** A single status-panel widget definition rendered by the renderer. */
export const WidgetDefSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  path: z.string().default(''),
  config: z.record(z.string(), z.any()).default({})
})
export type WidgetDef = z.infer<typeof WidgetDefSchema>

/** RP Terminal specific card payload, stored under data.extensions.rp_terminal. */
export const RPTerminalExtSchema = z.object({
  ui_layout: z.array(WidgetDefSchema).default([]),
  css: z.string().default(''),
  theme: z.record(z.string(), z.any()).default({}),
  state_schema: z.record(z.string(), z.any()).default({}),
  /** MVU Zod `data_schema` source (JS). Run sandboxed (R4) to derive stat_data
   * defaults + validation. Native cards can instead put plain defaults in
   * `state_schema.defaults`. */
  data_schema: z.string().default(''),
  scripts: z.array(z.object({ name: z.string(), code: z.string() })).default([]),
  game_rules: z.record(z.string(), z.any()).default({}),
  assets: z.record(z.string(), z.string()).default({})
})
export type RPTerminalExt = z.infer<typeof RPTerminalExtSchema>

export const CardDataSchema = z.object({
  name: z.string().default('Unknown'),
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  first_mes: z.string().default(''),
  mes_example: z.string().default(''),
  creator_notes: z.string().default(''),
  system_prompt: z.string().default(''),
  post_history_instructions: z.string().default(''),
  alternate_greetings: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  creator: z.string().default(''),
  character_version: z.string().default(''),
  character_book: LorebookSchema.optional(),
  // Known: rp_terminal. Unknown ST extension keys are preserved via catchall.
  extensions: z
    .object({ rp_terminal: RPTerminalExtSchema.optional() })
    .catchall(z.any())
    .default({})
})
export type CardData = z.infer<typeof CardDataSchema>

export const RPTerminalCardSchema = z.object({
  // Accept any spec on read (legacy 'rpterminal', ST 'chara_card_v2', etc.) and
  // normalize to v3 so older/foreign saved cards migrate instead of being dropped.
  spec: z
    .string()
    .default('chara_card_v3')
    .transform(() => 'chara_card_v3' as const),
  spec_version: z.string().default('3.0'),
  data: CardDataSchema
})
export type RPTerminalCard = z.infer<typeof RPTerminalCardSchema>

/** Convenience accessor for the rp_terminal extension block (may be undefined). */
export const getRpExt = (card: RPTerminalCard): RPTerminalExt | undefined =>
  card.data.extensions?.rp_terminal
