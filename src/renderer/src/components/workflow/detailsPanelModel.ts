// Pure model for the universal details panel (agent & memory UX WP-E; spec §6). Derives the panel's
// selection context (agent / non-agent group / single node / nothing) and which tabs are visible for
// it, the prompt-editor row operations (role-message array ↔ rows), and the shared exposed-enum
// resolver (static enum | dynamicEnum) both the panel and the Agents ▾ dropdown render. NO React
// imports — vitest-pure like groupModel/agentModel, so all of this logic is unit-tested.
import { getPath as getConfigPath } from '../../../../shared/objectPath'
import { fieldsFromSchema } from './schemaForm'

/** What the panel is describing. `group` = a plain (non-agent) group → the legacy ModulePanel with no
 *  tab rail; `agent` = a trigger-rooted group → the tabbed agent context; `node`/`none` per spec §6. */
export type PanelSelection =
  | { kind: 'agent'; groupId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'none' }

export type DetailsTab = 'settings' | 'prompt' | 'runs' | 'docs'

/** Selection is mutually exclusive in the store (a group OR a node OR nothing). An agent group is a
 *  group the caller has already classified via agentModel.isAgentGroup. */
export const resolveSelection = (
  selectedGroupId: string | null,
  selectedNodeId: string | null,
  selectedGroupIsAgent: boolean
): PanelSelection => {
  if (selectedGroupId) {
    return selectedGroupIsAgent
      ? { kind: 'agent', groupId: selectedGroupId }
      : { kind: 'group', groupId: selectedGroupId }
  }
  if (selectedNodeId) return { kind: 'node', nodeId: selectedNodeId }
  return { kind: 'none' }
}

/** The tab rail for a selection (spec §6 table). Agent + node share the four-tab shell; the Prompt tab
 *  appears only when a prompt field exists (node-type `promptFields`). A plain group + the empty
 *  selection use no tab rail (they render a single body), so they get []. */
export const visibleTabs = (sel: PanelSelection, hasPrompt: boolean): DetailsTab[] => {
  if (sel.kind === 'agent' || sel.kind === 'node') {
    return ['settings', ...(hasPrompt ? (['prompt'] as const) : []), 'runs', 'docs']
  }
  return []
}

// ── prompt editor rows (spec §6 Prompt tab) ───────────────────────────────────────────────────────

export type PromptRole = 'system' | 'user' | 'assistant'
export const PROMPT_ROLES: readonly PromptRole[] = ['system', 'user', 'assistant']

/** Insertable placeholder chips (spec §6). Sourced from this one constant so the editor + docs agree.
 *  `{{tables}}` is the memory.maintain rendered-tables-block placeholder (alias of `{{input}}`). */
export const PROMPT_PLACEHOLDERS: readonly string[] = [
  '{history}',
  '{{tables}}',
  '{{input}}',
  '{{user}}',
  '{{char}}'
]

export interface PromptRow {
  role: string
  content: string
}

/** Coerce a node's role-message config value into editor rows (fail-soft: a non-array, or rows missing
 *  role/content, degrade rather than throw — the config may be mid-edit or hand-authored). */
export const normalizeRows = (value: unknown): PromptRow[] => {
  if (!Array.isArray(value)) return []
  return value.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>
    return {
      role: typeof row.role === 'string' ? row.role : 'system',
      content: typeof row.content === 'string' ? row.content : ''
    }
  })
}

export const setRole = (rows: PromptRow[], index: number, role: string): PromptRow[] =>
  rows.map((r, i) => (i === index ? { ...r, role } : r))

export const setContent = (rows: PromptRow[], index: number, content: string): PromptRow[] =>
  rows.map((r, i) => (i === index ? { ...r, content } : r))

export const addRow = (rows: PromptRow[], role: PromptRole = 'system'): PromptRow[] => [
  ...rows,
  { role, content: '' }
]

export const removeRow = (rows: PromptRow[], index: number): PromptRow[] =>
  rows.filter((_, i) => i !== index)

/** Move the row at `from` to `to`, clamping (a drag past the ends is a no-op-ish clamp, never throws). */
export const moveRow = (rows: PromptRow[], from: number, to: number): PromptRow[] => {
  if (from < 0 || from >= rows.length) return rows
  const clamped = Math.max(0, Math.min(to, rows.length - 1))
  if (clamped === from) return rows
  const next = rows.slice()
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)
  return next
}

/** Insert `text` into `content` at `caret` (or append when caret is null) — the placeholder-chip click. */
export const insertAtCaret = (content: string, text: string, caret: number | null): string => {
  if (caret == null || caret < 0 || caret > content.length) return content + text
  return content.slice(0, caret) + text + content.slice(caret)
}

// ── exposed-enum resolution (WP-E/WP-F: the shared Mode-dropdown renderer, spec §1) ────────────────

/** Resolve a `dynamicEnum` hint against a node's config into {key,label} options (plan §0.5): the
 *  options live in a sibling config array, keyed/labelled by the hint's field names. Fail-soft — a
 *  missing/!array options path yields []. */
export const dynamicEnumOptions = (
  config: Record<string, unknown>,
  hint: { optionsPath: string; keyField: string; labelField: string }
): { key: string; label: string }[] => {
  const raw = getConfigPath(config, hint.optionsPath)
  if (!Array.isArray(raw)) return []
  return raw
    .map((o) => {
      const row = (o ?? {}) as Record<string, unknown>
      const key = row[hint.keyField]
      if (typeof key !== 'string') return null
      const label = row[hint.labelField]
      return { key, label: typeof label === 'string' && label ? label : key }
    })
    .filter((o): o is { key: string; label: string } => o !== null)
}

/** The options for an exposed field IF it renders as an enum dropdown, else null (spec §1 "Mode
 *  dropdown = any exposed enum field"): a static JSON-Schema enum, else a dynamicEnum resolved against
 *  the node's config. Used by the details panel AND the Agents ▾ dropdown so both share one renderer. */
export const exposedEnumOptions = (
  config: Record<string, unknown>,
  configSchema: Record<string, unknown> | undefined,
  dynamicEnum: { path: string; optionsPath: string; keyField: string; labelField: string } | undefined,
  path: string
): { key: string; label: string }[] | null => {
  if (dynamicEnum && dynamicEnum.path === path) return dynamicEnumOptions(config, dynamicEnum)
  const field = fieldsFromSchema(configSchema).find((f) => f.key === path)
  if (field && field.kind === 'enum') return field.options.map((o) => ({ key: o, label: o }))
  return null
}
