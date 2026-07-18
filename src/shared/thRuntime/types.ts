// src/shared/thRuntime/types.ts
import type { CardCtx } from './hostPrimitives'
import type {
  VarsHost,
  WorldbookHost,
  ChatHost,
  RegexHost,
  SurfaceHost,
  AssetHost,
  GenHost,
  EngineHost
} from './hostFacets'

// Re-export the facets so `import { VarsHost, … } from '.../types'` and `.../hostFacets` both work.
export type {
  VarsHost,
  WorldbookHost,
  ChatHost,
  RegexHost,
  SurfaceHost,
  AssetHost,
  GenHost,
  EngineHost
} from './hostFacets'

// Re-export the primitive aliases (now defined in the leaf `hostPrimitives.ts`, so `hostFacets.ts`
// and `types.ts` can both depend on them without a cycle). Every name that used to be declared here
// stays importable from `.../types` unchanged.
export type {
  CardChatScope,
  CardCtx,
  VarsOrigin,
  ThMessage,
  StMessage,
  FloorLike,
  GenCfgNormalized,
  HostPresetPrompt,
  HostPresetView
} from './hostPrimitives'

/**
 * The single seam between the realm-agnostic TH runtime and each transport.
 *
 * Type-level, `Host` is the intersection of eight cohesive facets (see `hostFacets.ts`); at
 * runtime it is a single FLAT object each transport builds. `ctx` sits on the root, outside any
 * facet. Members' doc comments live on the facet they belong to.
 */
export type Host = { ctx: CardCtx } & VarsHost &
  WorldbookHost &
  ChatHost &
  RegexHost &
  SurfaceHost &
  AssetHost &
  GenHost &
  EngineHost

/** What createThRuntime returns — spread onto the card window by each transport. */
export type ThGlobals = Record<string, any>
