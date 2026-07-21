import { AgentCatalog } from '../catalog'

/**
 * Per-profile `AgentCatalog` memoization shared by the Lab's production singletons (replay + live run).
 * A catalog is constructed lazily on first use for a profile and reused thereafter, so both run modes
 * resolve the CURRENT definition through the same cached instance.
 */
export const createProfileCatalogCache = (): ((profileId: string) => AgentCatalog) => {
  const catalogs = new Map<string, AgentCatalog>()
  return (profileId) => {
    let catalog = catalogs.get(profileId)
    if (!catalog) {
      catalog = new AgentCatalog(profileId)
      catalogs.set(profileId, catalog)
    }
    return catalog
  }
}
