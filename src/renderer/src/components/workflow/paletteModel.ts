// Pure palette-search model (agent & memory UX WP-G; spec §2): ONE search box filters BOTH palette
// sections (the Agent library and the node-type list). NO React imports — vitest-pure like the other
// editor models.

/** Case-insensitive multi-term match: every whitespace-separated term of `query` must appear in at
 *  least one of the entry's `texts` (title, type id, description, …). An empty/blank query matches
 *  everything (the palette shows all entries until the user types). */
export const paletteMatch = (query: string, texts: (string | undefined)[]): boolean => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = texts
    .filter((t): t is string => !!t)
    .join('\n')
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
