// Pure model for the universal details panel (agent & memory UX WP-E; spec §6). Derives the panel's
// selection context (agent / non-agent group / single node / nothing) and which tabs are visible for
// it, plus the prompt-editor row operations (role-message array ↔ rows). NO React imports — vitest-pure
// like groupModel/agentModel, so the selection + tab logic and the prompt round-trip are unit-tested.

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

/** Insertable placeholder chips (spec §6). Sourced from this one constant so the editor + docs agree. */
export const PROMPT_PLACEHOLDERS: readonly string[] = ['{history}', '{{input}}', '{{user}}', '{{char}}']

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
