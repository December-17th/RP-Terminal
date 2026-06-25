// src/shared/thRuntime/worldbookEntry.ts
//
// Pure bidirectional mapping between our native lorebook-entry shape (LorebookEntrySchema: keys / constant /
// selective / secondary_keys / insertion_order|depth / …) and the TavernHelper `WorldbookEntry` shape that
// cards read via getWorldbook and write via updateWorldbookWith / replaceWorldbook (`strategy.{type,keys,
// keys_secondary}` + `position` + `recursion`/`effect` + `extra`). Realm-agnostic; lives in shared/thRuntime
// so BOTH transports map identically (the worldbook bridge previously only added uid/name, dropping the
// keys + constant flag — which made downloaded entries keyless and never-on). See JSR worldbook.d.ts.

const asStrings = (arr: any): string[] =>
  Array.isArray(arr) ? arr.map((k) => (k instanceof RegExp ? k.source : String(k))) : []

/** Native lorebook entry → TavernHelper `WorldbookEntry` (read path). Keeps the native fields too (harmless)
 *  and ADDS the `strategy`/`position`/`recursion`/`effect` a card expects. */
export const nativeToThEntry = (en: any, i: number): any => {
  const e = en && typeof en === 'object' ? en : {}
  return {
    ...e,
    uid: typeof e.uid === 'number' ? e.uid : i,
    name: e.name || e.comment || `Entry ${i + 1}`,
    comment: e.comment ?? '',
    enabled: e.enabled !== false,
    content: typeof e.content === 'string' ? e.content : '',
    strategy: {
      // blue light (constant, always on) vs green light (keyword-scanned, selective)
      type: e.constant ? 'constant' : 'selective',
      keys: Array.isArray(e.keys) ? e.keys : [],
      keys_secondary: {
        logic: e.selective ? 'and_all' : 'and_any',
        keys: Array.isArray(e.secondary_keys) ? e.secondary_keys : []
      },
      scan_depth: 'same_as_global'
    },
    position: {
      type: e.insertion_depth != null ? 'at_depth' : 'before_character_definition',
      role: 'system',
      depth: e.insertion_depth ?? 0,
      order: typeof e.insertion_order === 'number' ? e.insertion_order : 100
    },
    probability: typeof e.probability === 'number' ? e.probability : 100,
    recursion: {
      prevent_incoming: e.exclude_recursion === true,
      prevent_outgoing: e.prevent_recursion === true,
      delay_until: null
    },
    effect: { sticky: null, cooldown: null, delay: null },
    extra: e.extra && typeof e.extra === 'object' ? e.extra : {}
  }
}

/** TavernHelper `WorldbookEntry` → native lorebook entry (write path). Maps `strategy.keys` → keys,
 *  `strategy.type:'constant'` → constant (always-on), secondary keys → selective, and round-trips `extra`. */
export const thToNativeEntry = (th: any): Record<string, any> => {
  const t = th && typeof th === 'object' ? th : {}
  const s = (t.strategy && typeof t.strategy === 'object' ? t.strategy : {}) as any
  const p = (t.position && typeof t.position === 'object' ? t.position : {}) as any
  const sec = (s.keys_secondary && typeof s.keys_secondary === 'object' ? s.keys_secondary : {}) as any
  const secKeys = asStrings(sec.keys)
  return {
    keys: asStrings(s.keys),
    secondary_keys: secKeys,
    content: typeof t.content === 'string' ? t.content : '',
    enabled: t.enabled !== false,
    constant: s.type === 'constant',
    selective: secKeys.length > 0,
    insertion_order: typeof p.order === 'number' ? p.order : 100,
    insertion_depth: p.type === 'at_depth' && typeof p.depth === 'number' ? p.depth : null,
    // Preserve case_sensitive across a round-trip (nativeToThEntry spreads it onto the TH entry); default off.
    case_sensitive: t.case_sensitive === true,
    probability: typeof t.probability === 'number' ? t.probability : 100,
    exclude_recursion: t.recursion?.prevent_incoming === true,
    prevent_recursion: t.recursion?.prevent_outgoing === true,
    comment: t.name || t.comment || '',
    // Keep card metadata (the workshop's cw_project_id/cw_entry_key) but don't persist an empty object.
    extra:
      t.extra && typeof t.extra === 'object' && Object.keys(t.extra).length ? t.extra : undefined
  }
}
