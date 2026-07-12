/**
 * codeColumn — PLOT-RECALL (WP3). Derive the display column that carries a table's memory code
 * (RPT's `MT####` convention; imported `AM####` cards work unchanged) from its export config.
 *
 * PURE / SHARED so BOTH sides can import it: the recall node (main) and the Memory-Manager /
 * Tables-view MT badge (renderer, WP7). Per the depcruise `shared-not-to-main-renderer` rule, shared
 * may import NEITHER the main-side `TableExportConfig` (src/main/types/tableTemplate.ts) NOR the
 * renderer's structural mirror (TableGrid.tsx). So this declares its OWN minimal structural parameter
 * type — the established mirror pattern, one more structural pick — which both sides' config objects
 * satisfy. Do NOT re-export or move the existing types across the boundary.
 */

/** The minimal shape of an `exportConfig` this helper reads. Both sides' configs are supersets. */
export interface CodeColumnConfig {
  /** Comma-separated display COLUMN names whose cells become per-row activation keywords. */
  keywords: string
  /** Index columns, in config order. */
  extraIndexColumns: string[]
  /** Per-index-column mode: `'both'` (index + keyword) or `'index_only'`. */
  extraIndexColumnModes: Record<string, 'both' | 'index_only'>
}

/**
 * The code column, or `null` when the table carries no code. Derivation:
 *  1. the FIRST column named in the comma-separated `keywords` string, else
 *  2. the first `extraIndexColumns` entry whose `extraIndexColumnModes` value is `'both'`, else
 *  3. `null`.
 */
export const codeColumnOf = (config: CodeColumnConfig): string | null => {
  const firstKeyword = config.keywords
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (firstKeyword) return firstKeyword
  const both = config.extraIndexColumns.find(
    (c) => config.extraIndexColumnModes[c] === 'both'
  )
  return both ?? null
}
