// Globals are an untyped variable bag (Record<string, any>), matching TemplateContext.globals.
import path from 'path'
import { getQuickJS } from 'quickjs-emscripten'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { getAppDir, readJsonSync, writeJsonSyncAtomic } from './storageService'
import { log } from './logService'
import { applyJsonPatch } from '../parsers/mvuParser'
import { initEngine, setEngineDeps } from '../../shared/templateEngine'

/**
 * Main-process wiring for the shared ST-Prompt-Template engine. The engine
 * itself (compile + the quickjs sandbox + the getvar/setvar/getchar/… bridge)
 * lives in src/shared/templateEngine.ts so the renderer can reuse it at
 * render-time. Here we inject the main-only host deps (logging + the RFC-6902
 * patch impl) and own per-profile global-variable persistence.
 */

// Re-export the engine surface so existing imports (promptBuilder, tests, …) are unchanged.
export {
  evalTemplate,
  evalTemplateDetailed,
  hasTags,
  stripTags,
  isEngineReady,
  buildTemplateContext
} from '../../shared/templateEngine'
export type {
  TemplateData,
  TemplateContext,
  TemplateContextOpts
} from '../../shared/templateEngine'

export const initTemplates = async (): Promise<void> => {
  // Wire the deps the shared engine can't import from src/main, then load quickjs.
  // `log`'s first param is a LogLevel union (not `string`), so adapt it to the engine's LogFn.
  setEngineDeps({
    log: (level, msg, detail) => log(level as Parameters<typeof log>[0], msg, detail),
    applyJsonPatch,
    // Faithful block-style YAML for the `YAML` sandbox global (status/MVU world-info entries).
    yamlStringify: (val, opts) => yamlStringify(val, opts),
    yamlParse: (text) => yamlParse(text)
  })
  // Main runs in Node — the default wasmfile variant loads from node_modules.
  await initEngine(() => getQuickJS())
}

// --- per-profile global variable persistence (JSON file) ---
const globalsPath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'template-globals.json')

export const loadGlobals = (profileId: string): Record<string, any> =>
  readJsonSync<Record<string, any>>(globalsPath(profileId)) || {}

export const saveGlobals = (profileId: string, globals: Record<string, any>): void => {
  try {
    writeJsonSyncAtomic(globalsPath(profileId), globals)
  } catch {
    /* non-fatal */
  }
}
