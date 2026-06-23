import { parentPort } from 'worker_threads'
import { getSandbox, runScript, SandboxJob } from '../services/sandboxRunner'

/**
 * Worker-thread entry for the sandbox harness (T3.2). Loads the quickjs WASM
 * module once, then runs each posted job off the main thread so heavy or
 * long-running scripts (combat math, MVU schema validation, later vector math)
 * never jank the UI. Built as a separate main entry (see electron.vite.config.ts)
 * and spawned by `sandboxService`. The host falls back to in-process execution if
 * this worker can't be spawned, so the same `runScript` core runs either way.
 */
if (parentPort) {
  const port = parentPort
  const ready = getSandbox()
  port.on('message', (msg: { id: number; job: SandboxJob }) => {
    ready
      .then((mod) => {
        port.postMessage({ id: msg.id, res: runScript(mod, msg.job) })
      })
      .catch((e: unknown) => {
        port.postMessage({
          id: msg.id,
          res: { ok: false, events: [], logs: [], error: String((e as Error)?.message || e) }
        })
      })
  })
}
