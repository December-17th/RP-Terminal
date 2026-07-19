import crypto from 'crypto'
import type Database from 'better-sqlite3'
import {
  parseAgentDefinition,
  normalizeAgentName,
  type AgentContractError,
  type AgentDefinition
} from '../../../../shared/agentRuntime'
import { getDb } from '../../db'
import { BUILTIN_AGENTS } from './builtins'

export type AgentSourceKind = 'builtin' | 'user-created' | 'user-imported' | 'card'
/** Defined in the shared contracts so the renderer can name roles; re-exported for existing callers. */
import type { AgentRole } from '../../../../shared/agentRuntime'
export type { AgentRole }

export interface AgentSource {
  kind: AgentSourceKind
  key: string
  version: string
}

export interface AgentImportPackage {
  source: AgentSource
  agents: unknown[]
  roleRecommendations?: Partial<Record<AgentRole, string>>
}

export interface CatalogAgent {
  id: string
  name: string
  source: AgentSource
  sourcePresent: boolean
  availableSource: { version: string; baseline: AgentDefinition } | null
  baseline: AgentDefinition
  effective: AgentDefinition
  effectiveHash: string
  customized: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface PackageInspection {
  definitions: AgentDefinition[]
  collisions: Array<{ incomingName: string; existing: CatalogAgent }>
}

export interface PackageInstallResult {
  installed: CatalogAgent[]
  roleRecommendations: Partial<Record<AgentRole, string>>
}

export interface CardSourceInspection extends PackageInspection {
  retained: Array<{ agent: CatalogAgent; incoming: AgentDefinition }>
  added: AgentDefinition[]
  removed: CatalogAgent[]
}

export interface UpgradeInspection {
  changedPaths: string[]
  customizedPaths: string[]
  conflicts: string[]
  incoming: AgentDefinition
}

export type StandaloneInspection =
  | { ok: true; format: 'agent-definition'; definition: AgentDefinition; collisions: PackageInspection['collisions'] }
  | {
      ok: false
      format: 'legacy-workflow-pack' | 'invalid'
      errors?: AgentContractError[]
    }

type PathPart = string | number
type CustomizationOp =
  | { op: 'set'; path: PathPart[]; value: unknown }
  | { op: 'delete'; path: PathPart[] }

interface CatalogRow {
  id: string
  name: string
  name_key: string
  source_kind: AgentSourceKind
  source_key: string
  source_version: string
  source_present: number
  available_source_version: string | null
  available_definition: string | null
  baseline_definition: string
  customization_ops: string
  effective_definition: string
  effective_hash: string
  enabled: number
  created_at: string
  updated_at: string
}

export class AgentCatalogError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DEFINITION'
      | 'NAME_COLLISION'
      | 'MISSING_RENAME'
      | 'NOT_FOUND'
      | 'SOURCE_BACKED'
      | 'ROLE_BOUND'
      | 'INCOMPATIBLE_ROLE'
      | 'UPGRADE_CONFLICT'
      | 'INVALID_SOURCE',
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'AgentCatalogError'
  }
}

const ROLES: AgentRole[] = ['classic.narrator', 'yuzu.sceneDirector']

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const hashDefinition = (definition: AgentDefinition): string =>
  crypto.createHash('sha256').update(stableJson(definition)).digest('hex')

const equal = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)
const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null && typeof value === 'object'

const diffOps = (
  baseline: unknown,
  effective: unknown,
  path: PathPart[] = []
): CustomizationOp[] => {
  if (equal(baseline, effective)) return []
  if (
    isContainer(baseline) &&
    isContainer(effective) &&
    Array.isArray(baseline) === Array.isArray(effective)
  ) {
    if (
      Array.isArray(baseline) &&
      Array.isArray(effective) &&
      baseline.length !== effective.length
    ) {
      return [{ op: 'set', path, value: effective }]
    }
    const base = baseline as Record<string, unknown>
    const next = effective as Record<string, unknown>
    const keys = new Set([...Object.keys(base), ...Object.keys(next)])
    const ops: CustomizationOp[] = []
    for (const key of keys) {
      const part = Array.isArray(effective) ? Number(key) : key
      if (!(key in next)) ops.push({ op: 'delete', path: [...path, part] })
      else if (!(key in base)) ops.push({ op: 'set', path: [...path, part], value: next[key] })
      else ops.push(...diffOps(base[key], next[key], [...path, part]))
    }
    return ops
  }
  return [{ op: 'set', path, value: effective }]
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const applyOps = (baseline: AgentDefinition, ops: CustomizationOp[]): unknown => {
  const value: unknown = clone(baseline)
  for (const op of ops) {
    if (op.path.length === 0) return op.op === 'set' ? clone(op.value) : undefined
    let parent = value as Record<string | number, unknown>
    for (const part of op.path.slice(0, -1)) {
      parent = parent[part] as Record<string | number, unknown>
    }
    const leaf = op.path[op.path.length - 1]
    if (op.op === 'set') parent[leaf] = clone(op.value)
    else if (Array.isArray(parent) && typeof leaf === 'number') parent.splice(leaf, 1)
    else delete parent[leaf]
  }
  return value
}

const displayPath = (path: PathPart[]): string => path.join('.')
const pathsOverlap = (a: PathPart[], b: PathPart[]): boolean => {
  const short = Math.min(a.length, b.length)
  return a.slice(0, short).every((part, index) => part === b[index])
}

const parseDefinition = (raw: unknown): AgentDefinition => {
  const result = parseAgentDefinition(raw)
  if (!result.ok) {
    throw new AgentCatalogError('INVALID_DEFINITION', 'Invalid Agent Definition', result.errors)
  }
  return result.value
}

const validateSource = (source: AgentSource): void => {
  if (
    !['builtin', 'user-created', 'user-imported', 'card'].includes(source.kind) ||
    !source.key.trim() ||
    !source.version.trim()
  ) {
    throw new AgentCatalogError('INVALID_SOURCE', 'Agent Source kind, key, and version are required')
  }
}

export class AgentCatalog {
  private readonly database: Database.Database

  constructor(
    readonly profileId: string,
    database: Database.Database = getDb()
  ) {
    this.database = database
    this.seedBuiltins()
  }

  list(): CatalogAgent[] {
    return (
      this.database
        .prepare('SELECT * FROM agent_catalog WHERE profile_id = ? ORDER BY name COLLATE NOCASE')
        .all(this.profileId) as CatalogRow[]
    ).map(toAgent)
  }

  get(idOrName: string): CatalogAgent | null {
    const row = this.database
      .prepare(
        'SELECT * FROM agent_catalog WHERE profile_id = ? AND (id = ? OR name_key = ?)'
      )
      .get(this.profileId, idOrName, normalizeAgentName(idOrName)) as CatalogRow | undefined
    return row ? toAgent(row) : null
  }

  create(raw: unknown): CatalogAgent {
    const definition = parseDefinition(raw)
    return this.insert(
      definition,
      { kind: 'user-created', key: crypto.randomUUID(), version: '1' },
      true
    )
  }

  inspectPackage(pkg: AgentImportPackage): PackageInspection {
    validateSource(pkg.source)
    const definitions = pkg.agents.map(parseDefinition)
    const names = new Set<string>()
    for (const definition of definitions) {
      const key = normalizeAgentName(definition.name)
      if (names.has(key)) {
        throw new AgentCatalogError(
          'NAME_COLLISION',
          `Incoming package contains duplicate Agent Name "${definition.name}"`
        )
      }
      names.add(key)
    }
    const collisions = definitions.flatMap((definition) => {
      const existing = this.get(definition.name)
      return existing ? [{ incomingName: definition.name, existing }] : []
    })
    return { definitions, collisions }
  }

  installPackage(
    pkg: AgentImportPackage,
    incomingRenames: Record<string, string> = {}
  ): PackageInstallResult {
    const inspection = this.inspectPackage(pkg)
    const collidingNames = new Set(inspection.collisions.map((item) => item.incomingName))
    for (const collision of collidingNames) {
      if (!incomingRenames[collision]?.trim()) {
        throw new AgentCatalogError(
          'MISSING_RENAME',
          `Incoming Agent "${collision}" must be renamed before import`,
          inspection.collisions
        )
      }
    }

    const definitions = inspection.definitions.map((definition) =>
      parseDefinition({ ...definition, name: incomingRenames[definition.name] ?? definition.name })
    )
    const finalNames = new Set<string>()
    for (const definition of definitions) {
      const key = normalizeAgentName(definition.name)
      if (finalNames.has(key) || this.get(definition.name)) {
        throw new AgentCatalogError(
          'NAME_COLLISION',
          `Agent Name "${definition.name}" is already in use`
        )
      }
      finalNames.add(key)
    }

    const recommendations = Object.fromEntries(
      Object.entries(pkg.roleRecommendations ?? {}).map(([role, name]) => [
        role,
        incomingRenames[name] ?? name
      ])
    ) as Partial<Record<AgentRole, string>>
    for (const [role, name] of Object.entries(recommendations) as Array<[AgentRole, string]>) {
      const definition =
        definitions.find(
          (agent) => normalizeAgentName(agent.name) === normalizeAgentName(name)
        ) ??
        this.get(name)?.effective
      if (!definition || !isRoleCompatible(role, definition)) {
        throw new AgentCatalogError(
          'INCOMPATIBLE_ROLE',
          `Role recommendation ${role} does not name a compatible Agent`
        )
      }
    }

    return this.database.transaction(() => ({
      installed: definitions.map((definition) => this.insert(definition, pkg.source, true)),
      roleRecommendations: recommendations
    }))()
  }

  inspectCardSource(sourceKey: string, version: string, agents: unknown[]): CardSourceInspection {
    const source: AgentSource = { kind: 'card', key: sourceKey, version }
    validateSource(source)
    const definitions = agents.map(parseDefinition)
    const names = new Set<string>()
    for (const definition of definitions) {
      const key = normalizeAgentName(definition.name)
      if (names.has(key)) {
        throw new AgentCatalogError(
          'NAME_COLLISION',
          `Incoming package contains duplicate Agent Name "${definition.name}"`
        )
      }
      names.add(key)
    }

    const existing = this.list().filter(
      (agent) => agent.source.kind === 'card' && agent.source.key === sourceKey
    )
    const bySourceName = new Map(
      existing.map((agent) => [
        normalizeAgentName(agent.availableSource?.baseline.name ?? agent.baseline.name),
        agent
      ])
    )
    const retained = definitions.flatMap((incoming) => {
      const agent = bySourceName.get(normalizeAgentName(incoming.name))
      return agent ? [{ agent, incoming }] : []
    })
    const retainedIds = new Set(retained.map(({ agent }) => agent.id))
    const added = definitions.filter(
      (definition) => !bySourceName.has(normalizeAgentName(definition.name))
    )
    const removed = existing.filter((agent) => !retainedIds.has(agent.id))
    const collisions = added.flatMap((definition) => {
      const collision = this.get(definition.name)
      return collision ? [{ incomingName: definition.name, existing: collision }] : []
    })
    return { definitions, collisions, retained, added, removed }
  }

  validateCardSource(
    sourceKey: string,
    version: string,
    agents: unknown[],
    incomingRenames: Record<string, string> = {},
    roleRecommendations: Partial<Record<AgentRole, string>> = {}
  ): CardSourceInspection {
    const inspection = this.inspectCardSource(sourceKey, version, agents)
    const unresolved = inspection.collisions.filter(
      ({ incomingName }) => !incomingRenames[incomingName]?.trim()
    )
    if (unresolved.length) return inspection

    const additions = inspection.added.map((definition) =>
      parseDefinition({ ...definition, name: incomingRenames[definition.name] ?? definition.name })
    )
    const finalNames = new Set<string>()
    for (const definition of additions) {
      const key = normalizeAgentName(definition.name)
      if (finalNames.has(key) || this.get(definition.name)) {
        throw new AgentCatalogError(
          'NAME_COLLISION',
          `Agent Name "${definition.name}" is already in use`
        )
      }
      finalNames.add(key)
    }
    const retainedNames = new Map(
      inspection.retained.map(({ agent, incoming }) => [incoming.name, agent.name])
    )
    const retainedDefinitions = new Map(
      inspection.retained.map(({ agent, incoming }) => [
        normalizeAgentName(agent.name),
        incoming
      ])
    )
    for (const [role, sourceName] of Object.entries(roleRecommendations) as Array<
      [AgentRole, string]
    >) {
      const name = retainedNames.get(sourceName) ?? incomingRenames[sourceName] ?? sourceName
      const definition =
        additions.find((agent) => normalizeAgentName(agent.name) === normalizeAgentName(name)) ??
        retainedDefinitions.get(normalizeAgentName(name)) ??
        this.get(name)?.effective
      if (!definition || !isRoleCompatible(role, definition)) {
        throw new AgentCatalogError(
          'INCOMPATIBLE_ROLE',
          `Role recommendation ${role} does not name a compatible Agent`
        )
      }
    }
    return inspection
  }

  reconcileCardSource(
    sourceKey: string,
    version: string,
    agents: unknown[],
    incomingRenames: Record<string, string> = {},
    roleRecommendations: Partial<Record<AgentRole, string>> = {}
  ): PackageInstallResult {
    const inspection = this.validateCardSource(
      sourceKey,
      version,
      agents,
      incomingRenames,
      roleRecommendations
    )
    for (const collision of inspection.collisions) {
      if (!incomingRenames[collision.incomingName]?.trim()) {
        throw new AgentCatalogError(
          'MISSING_RENAME',
          `Incoming Agent "${collision.incomingName}" must be renamed before import`,
          inspection.collisions
        )
      }
    }
    const additions = inspection.added.map((definition) =>
      parseDefinition({ ...definition, name: incomingRenames[definition.name] ?? definition.name })
    )
    const finalNames = new Set<string>()
    for (const definition of additions) {
      const key = normalizeAgentName(definition.name)
      if (finalNames.has(key) || this.get(definition.name)) {
        throw new AgentCatalogError(
          'NAME_COLLISION',
          `Agent Name "${definition.name}" is already in use`
        )
      }
      finalNames.add(key)
    }
    const retainedNames = new Map(
      inspection.retained.map(({ agent, incoming }) => [incoming.name, agent.name])
    )
    const retainedDefinitions = new Map(
      inspection.retained.map(({ agent, incoming }) => [
        normalizeAgentName(agent.name),
        incoming
      ])
    )
    const recommendations = Object.fromEntries(
      Object.entries(roleRecommendations).map(([role, name]) => [
        role,
        retainedNames.get(name) ?? incomingRenames[name] ?? name
      ])
    ) as Partial<Record<AgentRole, string>>
    for (const [role, name] of Object.entries(recommendations) as Array<[AgentRole, string]>) {
      const definition =
        additions.find((agent) => normalizeAgentName(agent.name) === normalizeAgentName(name)) ??
        retainedDefinitions.get(normalizeAgentName(name)) ??
        this.get(name)?.effective
      if (!definition || !isRoleCompatible(role, definition)) {
        throw new AgentCatalogError(
          'INCOMPATIBLE_ROLE',
          `Role recommendation ${role} does not name a compatible Agent`
        )
      }
    }

    return this.database.transaction(() => {
      const now = new Date().toISOString()
      const stage = this.database.prepare(
        `UPDATE agent_catalog
            SET source_present = 1, available_source_version = ?, available_definition = ?,
                updated_at = ?
          WHERE profile_id = ? AND id = ?`
      )
      for (const { agent, incoming } of inspection.retained) {
        stage.run(version, JSON.stringify(incoming), now, this.profileId, agent.id)
      }
      const markMissing = this.database.prepare(
        `UPDATE agent_catalog
            SET source_present = 0, available_source_version = NULL, available_definition = NULL,
                updated_at = ?
          WHERE profile_id = ? AND id = ?`
      )
      for (const agent of inspection.removed) markMissing.run(now, this.profileId, agent.id)
      return {
        installed: additions.map((definition) =>
          this.insert(definition, { kind: 'card', key: sourceKey, version }, true)
        ),
        roleRecommendations: recommendations
      }
    })()
  }

  replaceCardSource(
    previousSourceKey: string,
    sourceKey: string,
    version: string,
    agents: unknown[],
    incomingRenames: Record<string, string> = {},
    roleRecommendations: Partial<Record<AgentRole, string>> = {}
  ): PackageInstallResult {
    return this.database.transaction(() => {
      const result = this.reconcileCardSource(
        previousSourceKey,
        version,
        agents,
        incomingRenames,
        roleRecommendations
      )
      this.database
        .prepare(
          `UPDATE agent_catalog
              SET source_key = ?, updated_at = ?
            WHERE profile_id = ? AND source_kind = 'card' AND source_key = ?`
        )
        .run(sourceKey, new Date().toISOString(), this.profileId, previousSourceKey)
      return result
    })()
  }

  edit(id: string, rawEffective: unknown): CatalogAgent {
    const current = this.require(id)
    const effective = parseDefinition(rawEffective)
    const collision = this.get(effective.name)
    if (collision && collision.id !== current.id) {
      throw new AgentCatalogError(
        'NAME_COLLISION',
        `Agent Name "${effective.name}" is already in use`
      )
    }
    const ops = diffOps(current.baseline, effective)
    this.assertRoleCompatibility(current.id, effective)
    this.writeEffective(current.id, current.baseline, ops, effective, current.source.version)
    return this.require(current.id)
  }

  restore(id: string): CatalogAgent {
    const current = this.require(id)
    if (!current.sourcePresent && current.source.kind === 'card') {
      throw new AgentCatalogError(
        'SOURCE_BACKED',
        'A source-missing card Agent has no restorable source baseline'
      )
    }
    this.writeEffective(
      current.id,
      current.baseline,
      [],
      current.baseline,
      current.source.version
    )
    return this.require(current.id)
  }

  inspectUpgrade(id: string, rawBaseline: unknown, version: string): UpgradeInspection {
    if (!version.trim()) throw new AgentCatalogError('INVALID_SOURCE', 'Source version is required')
    const current = this.require(id)
    const incoming = parseDefinition(rawBaseline)
    const changed = diffOps(current.baseline, incoming)
    const customized = this.opsFor(current.id)
    const conflicts = customized.filter((custom) =>
      changed.some((source) => pathsOverlap(custom.path, source.path))
    )
    return {
      changedPaths: changed.map((op) => displayPath(op.path)),
      customizedPaths: customized.map((op) => displayPath(op.path)),
      conflicts: conflicts.map((op) => displayPath(op.path)),
      incoming
    }
  }

  inspectAvailableUpgrade(id: string): UpgradeInspection | null {
    const current = this.require(id)
    return current.availableSource &&
      (current.availableSource.version !== current.source.version ||
        !equal(current.availableSource.baseline, current.baseline))
      ? this.inspectUpgrade(
          current.id,
          current.availableSource.baseline,
          current.availableSource.version
        )
      : null
  }

  upgrade(
    id: string,
    rawBaseline: unknown,
    version: string,
    options: { conflicts?: 'keep-customization' | 'use-source' } = {}
  ): CatalogAgent {
    const current = this.require(id)
    const inspection = this.inspectUpgrade(id, rawBaseline, version)
    if (inspection.conflicts.length && !options.conflicts) {
      throw new AgentCatalogError(
        'UPGRADE_CONFLICT',
        'Source upgrade conflicts with customized fields',
        inspection
      )
    }
    const changed = diffOps(current.baseline, inspection.incoming)
    let ops = this.opsFor(id)
    if (options.conflicts === 'use-source') {
      ops = ops.filter((custom) => !changed.some((source) => pathsOverlap(custom.path, source.path)))
    }
    const candidate = parseDefinition(applyOps(inspection.incoming, ops))
    const collision = this.get(candidate.name)
    if (collision && collision.id !== id) {
      throw new AgentCatalogError(
        'NAME_COLLISION',
        `Agent Name "${candidate.name}" is already in use`
      )
    }
    this.assertRoleCompatibility(id, candidate)
    this.writeEffective(id, inspection.incoming, ops, candidate, version)
    return this.require(id)
  }

  setEnabled(id: string, enabled: boolean): CatalogAgent {
    const current = this.require(id)
    if (!enabled) this.assertNotRoleBound(id)
    this.database
      .prepare('UPDATE agent_catalog SET enabled = ?, updated_at = ? WHERE profile_id = ? AND id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), this.profileId, current.id)
    return this.require(id)
  }

  delete(id: string): void {
    const current = this.require(id)
    if (
      current.source.kind === 'builtin' ||
      (current.source.kind === 'card' && current.sourcePresent)
    ) {
      throw new AgentCatalogError(
        'SOURCE_BACKED',
        'A source-backed Agent cannot be deleted while its source exists'
      )
    }
    this.assertNotRoleBound(id)
    this.database
      .prepare('DELETE FROM agent_catalog WHERE profile_id = ? AND id = ?')
      .run(this.profileId, id)
  }

  bindRole(role: AgentRole, id: string): void {
    if (!ROLES.includes(role)) {
      throw new AgentCatalogError('INCOMPATIBLE_ROLE', `Unknown Agent Role "${role}"`)
    }
    const agent = this.require(id)
    if (!agent.enabled || !isRoleCompatible(role, agent.effective)) {
      throw new AgentCatalogError(
        'INCOMPATIBLE_ROLE',
        `Agent "${agent.name}" is not enabled and compatible with ${role}`
      )
    }
    this.database
      .prepare(
        `INSERT INTO agent_role_bindings (profile_id, role, agent_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, role) DO UPDATE
         SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`
      )
      .run(this.profileId, role, id, new Date().toISOString())
  }

  getRoleBindings(): Record<AgentRole, string> {
    const rows = this.database
      .prepare(
        `SELECT b.role, a.name
           FROM agent_role_bindings b
           JOIN agent_catalog a ON a.profile_id = b.profile_id AND a.id = b.agent_id
          WHERE b.profile_id = ?`
      )
      .all(this.profileId) as Array<{ role: AgentRole; name: string }>
    return Object.fromEntries(rows.map((row) => [row.role, row.name])) as Record<AgentRole, string>
  }

  inspectStandalone(text: string): StandaloneInspection {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, format: 'invalid' }
    }
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as { kind?: unknown }).kind === 'rptagent' &&
      (raw as { format?: unknown }).format !== 'rpt-agent'
    ) {
      return { ok: false, format: 'legacy-workflow-pack' }
    }
    const result = parseAgentDefinition(raw)
    if (!result.ok) return { ok: false, format: 'invalid', errors: result.errors }
    return {
      ok: true,
      format: 'agent-definition',
      definition: result.value,
      collisions: this.inspectPackage({
        source: { kind: 'user-imported', key: 'inspection', version: '1' },
        agents: [result.value]
      }).collisions
    }
  }

  importStandalone(
    text: string,
    options: { rename?: string; sourceKey?: string; sourceVersion?: string } = {}
  ): CatalogAgent {
    const inspection = this.inspectStandalone(text)
    if (!inspection.ok) {
      throw new AgentCatalogError('INVALID_DEFINITION', 'File is not an Agent Definition', inspection)
    }
    const result = this.installPackage(
      {
        source: {
          kind: 'user-imported',
          key: options.sourceKey ?? crypto.randomUUID(),
          version: options.sourceVersion ?? '1'
        },
        agents: [inspection.definition]
      },
      options.rename ? { [inspection.definition.name]: options.rename } : {}
    )
    return result.installed[0]
  }

  exportStandalone(id: string): string {
    return `${JSON.stringify(this.require(id).effective, null, 2)}\n`
  }

  /** Mark a removed card source as missing, or purge rows while rolling back a failed fresh import. */
  removeCardSource(sourceKey: string, purge = false): void {
    const rows = this.list().filter(
      (agent) => agent.source.kind === 'card' && agent.source.key === sourceKey
    )
    if (purge) {
      for (const agent of rows) this.assertNotRoleBound(agent.id)
      this.database
        .prepare(
          `DELETE FROM agent_catalog
            WHERE profile_id = ? AND source_kind = 'card' AND source_key = ?`
        )
        .run(this.profileId, sourceKey)
      return
    }
    this.database
      .prepare(
        `UPDATE agent_catalog
            SET source_present = 0, available_source_version = NULL, available_definition = NULL,
                updated_at = ?
          WHERE profile_id = ? AND source_kind = 'card' AND source_key = ?`
      )
      .run(new Date().toISOString(), this.profileId, sourceKey)
  }

  private seedBuiltins(): void {
    this.database.transaction(() => {
      for (const builtin of BUILTIN_AGENTS) {
        const existing = this.database
          .prepare(
            `SELECT id FROM agent_catalog
              WHERE profile_id = ? AND source_kind = 'builtin' AND source_key = ?`
          )
          .get(this.profileId, builtin.key) as { id: string } | undefined
        if (!existing) {
          this.insert(
            builtin.definition,
            { kind: 'builtin', key: builtin.key, version: '1' },
            true
          )
        }
      }
      const classic = this.get('Classic Narrator')
      const yuzu = this.get('Yuzu Scene Director')
      if (classic) this.bindRoleIfMissing('classic.narrator', classic.id)
      if (yuzu) this.bindRoleIfMissing('yuzu.sceneDirector', yuzu.id)
    })()
  }

  private bindRoleIfMissing(role: AgentRole, id: string): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO agent_role_bindings (profile_id, role, agent_id, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(this.profileId, role, id, new Date().toISOString())
  }

  private insert(definition: AgentDefinition, source: AgentSource, enabled: boolean): CatalogAgent {
    validateSource(source)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    try {
      this.database
        .prepare(
          `INSERT INTO agent_catalog
           (id, profile_id, name, name_key, source_kind, source_key, source_version, source_present,
            available_source_version, available_definition, baseline_definition, customization_ops,
            effective_definition, effective_hash, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          this.profileId,
          definition.name,
          normalizeAgentName(definition.name),
          source.kind,
          source.key,
          source.version,
          source.version,
          JSON.stringify(definition),
          JSON.stringify(definition),
          JSON.stringify(definition),
          hashDefinition(definition),
          enabled ? 1 : 0,
          now,
          now
        )
    } catch (error) {
      throw new AgentCatalogError(
        'NAME_COLLISION',
        `Agent Name "${definition.name}" is already in use`,
        error
      )
    }
    return this.require(id)
  }

  private writeEffective(
    id: string,
    baseline: AgentDefinition,
    ops: CustomizationOp[],
    effective: AgentDefinition,
    version: string
  ): void {
    this.database
      .prepare(
        `UPDATE agent_catalog
            SET name = ?, name_key = ?, source_version = ?, baseline_definition = ?,
                customization_ops = ?, effective_definition = ?, effective_hash = ?, updated_at = ?
          WHERE profile_id = ? AND id = ?`
      )
      .run(
        effective.name,
        normalizeAgentName(effective.name),
        version,
        JSON.stringify(baseline),
        JSON.stringify(ops),
        JSON.stringify(effective),
        hashDefinition(effective),
        new Date().toISOString(),
        this.profileId,
        id
      )
  }

  private opsFor(id: string): CustomizationOp[] {
    const row = this.database
      .prepare('SELECT customization_ops FROM agent_catalog WHERE profile_id = ? AND id = ?')
      .get(this.profileId, id) as { customization_ops: string } | undefined
    if (!row) throw new AgentCatalogError('NOT_FOUND', `Agent "${id}" was not found`)
    return JSON.parse(row.customization_ops) as CustomizationOp[]
  }

  private require(idOrName: string): CatalogAgent {
    const agent = this.get(idOrName)
    if (!agent) throw new AgentCatalogError('NOT_FOUND', `Agent "${idOrName}" was not found`)
    return agent
  }

  private assertNotRoleBound(id: string): void {
    const binding = this.database
      .prepare('SELECT role FROM agent_role_bindings WHERE profile_id = ? AND agent_id = ?')
      .get(this.profileId, id) as { role: AgentRole } | undefined
    if (binding) {
      throw new AgentCatalogError(
        'ROLE_BOUND',
        `Agent has the ${binding.role} role binding; bind a replacement first`
      )
    }
  }

  private assertRoleCompatibility(id: string, definition: AgentDefinition): void {
    const bindings = this.database
      .prepare('SELECT role FROM agent_role_bindings WHERE profile_id = ? AND agent_id = ?')
      .all(this.profileId, id) as Array<{ role: AgentRole }>
    const incompatible = bindings.find((binding) => !isRoleCompatible(binding.role, definition))
    if (incompatible) {
      throw new AgentCatalogError(
        'INCOMPATIBLE_ROLE',
        `Edited Agent is not compatible with its ${incompatible.role} role binding`
      )
    }
  }
}

const toAgent = (row: CatalogRow): CatalogAgent => ({
  id: row.id,
  name: row.name,
  source: {
    kind: row.source_kind,
    key: row.source_key,
    version: row.source_version
  },
  sourcePresent: row.source_present === 1,
  availableSource:
    row.available_source_version && row.available_definition
      ? {
          version: row.available_source_version,
          baseline: JSON.parse(row.available_definition) as AgentDefinition
        }
      : null,
  baseline: JSON.parse(row.baseline_definition) as AgentDefinition,
  effective: JSON.parse(row.effective_definition) as AgentDefinition,
  effectiveHash: row.effective_hash,
  customized: (JSON.parse(row.customization_ops) as unknown[]).length > 0,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const isRoleCompatible = (role: AgentRole, definition: AgentDefinition): boolean => {
  if (definition.result.mode !== 'text') return false
  return role === 'classic.narrator'
    ? definition.result.validator === undefined
    : definition.result.validator === 'yss'
}
