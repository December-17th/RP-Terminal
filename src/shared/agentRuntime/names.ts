/** Locale-independent comparison key for profile-wide Agent Name uniqueness. */
export const normalizeAgentName = (name: string): string =>
  name.normalize('NFKC').toUpperCase().toLowerCase()
