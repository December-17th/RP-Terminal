import variant from '@jitl/quickjs-singlefile-browser-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { initEngine } from '../../../shared/templateEngine'

/**
 * Renderer-side init for the shared ST-Prompt-Template engine. Uses the SINGLEFILE
 * browser quickjs variant (the WASM is embedded as base64 in the JS), so there is no
 * separate `.wasm` fetch — it loads identically under the Vite dev server and the
 * production bundle. Phase C render-time eval builds on this. Idempotent.
 */
export const initRendererEngine = (): Promise<void> =>
  initEngine(() => newQuickJSWASMModuleFromVariant(variant))
