import { z } from 'zod'
import { AgentDefinitionSchema } from '../../shared/agentRuntime'

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
  comment: z.string().default(''),
  /** Opaque per-entry metadata round-tripped for the card runtime (TavernHelper `WorldbookEntry.extra`,
   * e.g. the 创意工坊 workshop tags its entries with `cw_project_id`/`cw_entry_key`). */
  extra: z.record(z.string(), z.any()).optional()
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

/** World-Card combat bundle (Track Combat / P7; docs/combat-system-design.md §10).
 *  Permissive on purpose — structure fields are validated, but ability/map shapes stay
 *  loose (z.any) and unknown keys pass through, so a partial or future bundle still
 *  round-trips instead of failing card import. The engine's `buildEncounter` normalizes
 *  what it reads. Structure fields are snake_case; ability/stat-block internals are the
 *  engine's camelCase shapes. */
const CombatStatBlockSchema = z
  .object({
    hp: z.number(),
    maxHp: z.number().optional(),
    ac: z.number().optional(),
    speed: z.number().optional(),
    mods: z.record(z.string(), z.number()).optional(),
    abilities: z.array(z.string()).optional(),
    resist: z.array(z.string()).optional(),
    vulnerable: z.array(z.string()).optional()
  })
  .passthrough()

export const CombatBundleSchema = z
  .object({
    ruleset: z.string().optional(),
    grid: z
      .object({ type: z.string().optional(), cell_ft: z.number().optional() })
      .passthrough()
      .optional(),
    enemy_controller: z.enum(['weighted', 'ai']).optional(),
    abilities: z.array(z.any()).optional(),
    bestiary: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            tier: z.string().optional(),
            block: CombatStatBlockSchema,
            abilities: z.array(z.string()).optional(),
            controller: z.enum(['weighted', 'ai']).optional()
          })
          .passthrough()
      )
      .optional(),
    party: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            block: CombatStatBlockSchema,
            abilities: z.array(z.string()).optional()
          })
          .passthrough()
      )
      .optional(),
    maps: z.array(z.any()).optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    skin: z.record(z.string(), z.any()).optional(),
    /** MVU-import config (build the party from stat_data instead of `party` templates).
     *  Loose markers — authoritative shapes are StatMap/DeriveConfig in shared/combat/bundle.ts,
     *  consumed/normalized by buildEncounterFromMvu. */
    stat_map: z.record(z.string(), z.any()).optional(),
    derive: z.record(z.string(), z.any()).optional(),
    enemies: z.record(z.string(), z.any()).optional(),
    /** Steers the end-of-combat narration; overrides the user's setting. */
    narration_prompt: z.string().optional(),
    /** Steers the freeform-action / mid-fight-exit adjudication; overrides the user's setting. */
    improvise_prompt: z.string().optional(),
    /** Which native combat system this world's fights open: grid tactics (default) or the STS duel. */
    mode: z.enum(['grid', 'duel']).optional()
  })
  .passthrough()

/** RP Terminal specific card payload, stored under data.extensions.rp_terminal. */
export const RPTerminalExtSchema = z
  .object({
    ui_layout: z.array(WidgetDefSchema).default([]),
    css: z.string().default(''),
    /** Card-customizable reasoning UI: an HTML shell with `{{reasoning}}`/`{{title}}`/`{{tp}}`/
     * `{{state}}` (+ `{{time}}`/`{{location}}`/`{{weather}}`) slots. The app folds `<think>` into
     * it (streaming + settled). Empty ⇒ the built-in collapsible reasoning panel. See ReasoningPanel. */
    reasoning_template: z.string().default(''),
    theme: z.record(z.string(), z.any()).default({}),
    state_schema: z.record(z.string(), z.any()).default({}),
    /** MVU Zod `data_schema` source (JS). Run sandboxed (R4) to derive stat_data
     * defaults + validation. Native cards can instead put plain defaults in
     * `state_schema.defaults`. */
    data_schema: z.string().default(''),
    scripts: z
      .array(z.object({ name: z.string(), code: z.string(), enabled: z.boolean().optional() }))
      .default([]),
    game_rules: z.record(z.string(), z.any()).default({}),
    assets: z.record(z.string(), z.string()).default({}),

    /** A card UI panel (renderMode:'panel', matched by its scriptName) the app auto-docks on the
     *  workspace's left when this card is active. */
    left_panel: z.object({ name: z.string() }).optional(),

    /** Static, card-determined panel layout (the WCV plan): a grid of slots, each hosting a native
     *  view (by id, e.g. "chat"/"status") or an out-of-process card-UI WebContentsView ("wcv" + an
     *  `entry` URL). `rect` is [col, row, colSpan, rowSpan] in the grid. */
    panel_ui: z
      .object({
        mode: z.literal('static').optional(),
        grid: z.object({ cols: z.number(), rows: z.number() }).default({ cols: 12, rows: 12 }),
        // Seamless composition (the VN-stage case): drop the inter-slot gap/padding and the per-slot
        // panel chrome (border, radius, title bar) so adjacent WCV surfaces read as one continuous
        // surface. Off by default so existing chromed cards are unchanged; a slot can still opt back
        // into chrome with `chrome:true`. See docs/design/poem-play-area-redesign.md §5.1.
        seamless: z.boolean().optional(),
        slots: z
          .array(
            z.object({
              id: z.string(),
              view: z.string(),
              rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
              entry: z.string().optional(),
              title: z.string().optional(),
              // Per-slot chrome override. Defaults to `!seamless`: chromed in normal layouts, bare in
              // seamless ones. Set explicitly to force one slot to differ from the layout default.
              chrome: z.boolean().optional()
            })
          )
          .default([]),
        // Full-play-area overlay surfaces a card can raise at runtime (partner sheet, 地图) — a card
        // surface can't escape its slot rectangle (WCVs composite above the DOM in their slot), so an
        // overlay opens as a temporary WCV covering the whole panel_ui grid region above the slots. The
        // card declares them here (same `entry` URL semantics as slots) and drives them via the runtime
        // `requestOverlay(id)` / `closeOverlay()` API. One overlay is shown at a time. See PM-A7 +
        // docs/design/poem-status-parity-design-2026-07-07.md §5.
        overlays: z
          .array(
            z.object({
              id: z.string(),
              entry: z.string(),
              title: z.string().optional()
            })
          )
          .optional()
      })
      .optional(),

    /** Project Yuzu opt-in. `surface.entry` is the MVP full-play-area card UI: one unrestricted WCV
     * document owns all Yuzu pixels and uses the existing card runtime globals. */
    yuzu: z
      .object({
        version: z.number().int().positive(),
        opening: z.string().optional(),
          surface: z
            .object({
              /** MUST be a card-code path (`card-code:...`) served from the card's own embedded code
               * dir — never a bare/remote URL. Without this a card could auto-load an arbitrary remote
               * document full-screen on session open. Matches wcvManager's CODE_ENTRY_PREFIX. */
              entry: z
                .string()
                .startsWith('card-code:', 'Yuzu surface entry must use the card-code: scheme')
                .refine((s) => s.length > 'card-code:'.length, {
                  message: 'Yuzu surface entry needs a path after card-code:'
                }),
              /** Presentation and generation are orthogonal. Opt in only when this UI consumes YSS. */
              enable_vn_mode: z.boolean().optional()
            })
          .catchall(z.any())
          .optional()
      })
      .catchall(z.any())
      .optional(),

    // --- World Card bundle slots (Track S). Optional so a plain card stays minimal; the
    // element shapes stay loose (z.any) because they're foreign formats (ST regex/preset/
    // lorebook) normalized on import. See docs/world-card-design.md §3. ---
    /** Bundle version marker; present ⇒ this is a World Card. */
    world_card: z.string().optional(),
    meta: z.record(z.string(), z.any()).optional(),
    regex: z.array(z.any()).optional(),
    presets: z.array(z.any()).optional(),
    lorebooks: z.array(z.any()).optional(),
    // Legacy `workflows: []` (bundled node-graph docs) was dropped from the active surface in
    // execution-plan M5c-2 (workflow system deleted). A card that still carries the key round-trips
    // losslessly — `parseCardFile` preserves the entire `extensions` object — it is simply no longer
    // read or imported.
    /** Declarative Agent Runtime definitions bundled by this card. Unlike legacy workflows these are
     * strict at the card import boundary and normalize through AgentContracts. */
    agents: z.array(AgentDefinitionSchema).optional(),
    /** A card recommendation only; the player's profile role binding remains authoritative. */
    agent_role_recommendations: z
      .strictObject({
        'classic.narrator': z.string().trim().min(1).optional(),
        'yuzu.sceneDirector': z.string().trim().min(1).optional()
      })
      .optional(),
    /** Bundled memory-table templates (chatSheets v2, or our native TableTemplate). Dropped into the
     *  profile's template library on install (never auto-assigned — assignment is destructive). */
    table_templates: z.array(z.any()).optional(),
    plugins: z.array(z.any()).optional(),
    agent: z.record(z.string(), z.any()).optional(),
    combat: CombatBundleSchema.optional(),
    recommended_settings: z.record(z.string(), z.any()).optional()
  })
  // Still catch any further unknown/future slots so the manifest round-trips.
  .catchall(z.any())
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
