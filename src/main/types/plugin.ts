import { z } from 'zod'

/**
 * Standalone plugin manifest (`manifest.json`). A plugin is a folder under
 * `userData/rp-terminal-data/plugins/<id>/` containing this manifest plus its
 * entry script. The shape mirrors the design doc (§4) and is intentionally
 * permissive on read — unknown future keys are preserved, missing keys default.
 *
 * Clean-room: our own format, not derived from js-slash-runner.
 */
export const PERMISSIONS = [
  'vars:read',
  'vars:write',
  'chat:read',
  'chat:write',
  'generate',
  'ui:toast',
  'ui:panel',
  'ui:button',
  'slash',
  'storage',
  'lorebook:read',
  'net'
] as const
export type Permission = (typeof PERMISSIONS)[number]

/** Permissions that require explicit user approval (the rest are auto-granted). */
export const SENSITIVE_PERMISSIONS: Permission[] = ['generate', 'chat:write', 'net', 'slash']

export const PluginManifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(''),
    version: z.string().default('0.0.0'),
    description: z.string().default(''),
    author: z.string().default(''),
    type: z.enum(['card-script', 'app-extension']).default('app-extension'),
    entry: z.string().default('main.js'),
    apiVersion: z.string().default('rpt.v1'),
    permissions: z.array(z.string()).default([]),
    /** Allow-listed hostnames for the opt-in `net` capability (host-enforced). */
    net: z.array(z.string()).default([]),
    contributes: z.record(z.string(), z.any()).default({})
  })
  .transform((m) => ({ ...m, name: m.name || m.id }))
export type PluginManifest = z.infer<typeof PluginManifestSchema>

/** Persisted per-profile enable/permission state for an installed plugin. */
export interface PluginState {
  enabled: boolean
  grants: string[]
}

/** What `listPlugins` returns to the renderer for one installed plugin. */
export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  enabled: boolean
  grants: string[]
  /** The entry script source (loaded into the sandboxed iframe). */
  code: string
  /** Set when the manifest/entry could not be read; the plugin can't run. */
  error?: string
}
