import path from 'path'
import { readJsonSync, writeJsonSyncAtomic } from './storageService'
import type { ArtifactScope, ScopeMeta } from '../../shared/artifactScope'
import type { CardRenderMode } from '../../shared/cardRenderMode'

/**
 * Generic scope-metadata sidecar for a scoped-artifact directory (regex, scripts, …).
 * Scope/owner/disabled live in a `_meta.json` next to the artifact files (filename → meta),
 * so the artifact files themselves stay untouched (e.g. ST regex JSON). Files with no entry
 * are `global` + enabled. Callers pass the artifact dir; this module owns the format.
 */

const metaPath = (dir: string): string => path.join(dir, '_meta.json')

export const readScopeMeta = (dir: string): Record<string, ScopeMeta> =>
  readJsonSync<Record<string, ScopeMeta>>(metaPath(dir)) || {}

const writeScopeMeta = (dir: string, meta: Record<string, ScopeMeta>): void =>
  writeJsonSyncAtomic(metaPath(dir), meta)

// Drop an entry once it carries no information (global + no owner + enabled + no renderMode + not high-trust).
const prune = (meta: Record<string, ScopeMeta>, file: string): void => {
  const m = meta[file]
  if (
    m &&
    (m.scope ?? 'global') === 'global' &&
    !m.owner &&
    !m.disabled &&
    !m.renderMode &&
    !m.highTrust
  )
    delete meta[file]
}

export const getScopeMeta = (dir: string, file: string): ScopeMeta =>
  readScopeMeta(dir)[file] ?? { scope: 'global' }

/** Set scope (+ owner for world/session), preserving the disabled flag and renderMode. */
export const setScope = (dir: string, file: string, scope: ArtifactScope, owner?: string): void => {
  const meta = readScopeMeta(dir)
  const prev = meta[file] || ({ scope: 'global' } as ScopeMeta)
  meta[file] = {
    scope,
    owner: scope === 'global' ? undefined : owner,
    disabled: prev.disabled,
    renderMode: prev.renderMode,
    highTrust: prev.highTrust
  }
  prune(meta, file)
  writeScopeMeta(dir, meta)
}

/** Enable/disable an artifact, preserving its scope/owner and renderMode. */
export const setDisabled = (dir: string, file: string, disabled: boolean): void => {
  const meta = readScopeMeta(dir)
  const prev = meta[file] || ({ scope: 'global' } as ScopeMeta)
  meta[file] = {
    scope: prev.scope ?? 'global',
    owner: prev.owner,
    disabled: disabled || undefined,
    renderMode: prev.renderMode,
    highTrust: prev.highTrust
  }
  prune(meta, file)
  writeScopeMeta(dir, meta)
}

/**
 * Mark (or clear) an artifact as a high-trust remote-code artifact (ADR 0017), preserving
 * scope/owner/disabled/renderMode. A high-trust artifact runs ONLY in the isolated WCV realm
 * (see `isScopeActive`).
 */
export const setHighTrust = (dir: string, file: string, highTrust: boolean): void => {
  const meta = readScopeMeta(dir)
  const prev = meta[file] || ({ scope: 'global' } as ScopeMeta)
  meta[file] = {
    scope: prev.scope ?? 'global',
    owner: prev.owner,
    disabled: prev.disabled,
    renderMode: prev.renderMode,
    highTrust: highTrust || undefined
  }
  prune(meta, file)
  writeScopeMeta(dir, meta)
}

/** Set (or clear, with null) a per-card render-mode override, preserving scope/owner/disabled. */
export const setRenderMode = (
  dir: string,
  file: string,
  renderMode: CardRenderMode | null
): void => {
  const meta = readScopeMeta(dir)
  const prev = meta[file] || ({ scope: 'global' } as ScopeMeta)
  meta[file] = {
    scope: prev.scope ?? 'global',
    owner: prev.owner,
    disabled: prev.disabled,
    renderMode: renderMode ?? undefined,
    highTrust: prev.highTrust
  }
  prune(meta, file)
  writeScopeMeta(dir, meta)
}

/** Drop an artifact's entry entirely (on delete) so the sidecar doesn't accumulate orphans. */
export const removeScopeEntry = (dir: string, file: string): void => {
  const meta = readScopeMeta(dir)
  if (meta[file]) {
    delete meta[file]
    writeScopeMeta(dir, meta)
  }
}
