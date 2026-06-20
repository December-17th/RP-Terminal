import { Worker } from 'worker_threads'
import path from 'path'
import { getSandbox, runScript, SandboxJob, SandboxResult } from './sandboxRunner'
import { log } from './logService'

/**
 * Host side of the sandbox harness (T3.2). `runSandbox` prefers a long-lived
 * worker thread (so untrusted scripts run off the main thread) but transparently
 * falls back to in-process `runScript` if the worker can't be spawned or hangs —
 * the VM-level interrupt timeout means even the fallback can't lock the UI for
 * long. Callers (combat engine, MVU schema validation) don't care which path ran.
 */

// Built next to index.js as a separate main entry (electron.vite.config.ts).
const workerPath = (): string => path.join(__dirname, 'sandboxWorker.js')

let worker: Worker | null = null
let workerBroken = false
let seq = 0

interface Pending {
  resolve: (r: SandboxResult) => void
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<number, Pending>()

/** Drop the worker (and fail anything still in flight) so the next call respawns it. */
const recycleWorker = (reason: string): void => {
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ ok: false, events: [], logs: [], error: `sandbox worker ${reason}` })
  }
  pending.clear()
  if (worker) {
    try {
      worker.terminate()
    } catch {
      /* ignore */
    }
    worker = null
  }
}

const ensureWorker = (): Worker | null => {
  if (worker) return worker
  if (workerBroken) return null
  try {
    const w = new Worker(workerPath())
    w.on('message', (m: { id: number; res: SandboxResult }) => {
      const p = pending.get(m.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(m.id)
        p.resolve(m.res)
      }
    })
    w.on('error', (e) => {
      log('error', 'sandbox worker error', String((e as Error)?.message || e))
      recycleWorker('crashed')
    })
    w.on('exit', () => {
      worker = null
    })
    worker = w
    return w
  } catch (e) {
    // Spawn failed (e.g. the worker bundle is missing) — stick to in-process.
    log('error', 'sandbox worker unavailable; using in-process fallback', String((e as Error)?.message || e))
    workerBroken = true
    return null
  }
}

const inProcess = async (job: SandboxJob): Promise<SandboxResult> => {
  const mod = await getSandbox()
  return runScript(mod, job)
}

/** Run a sandbox job (worker-thread preferred, in-process fallback). Never rejects. */
export const runSandbox = (job: SandboxJob): Promise<SandboxResult> => {
  const w = ensureWorker()
  if (!w) return inProcess(job)

  return new Promise<SandboxResult>((resolve) => {
    const id = ++seq
    // Grace beyond the in-VM deadline; if the worker itself wedged, recycle + fall back.
    const budget = (job.timeoutMs ?? 1000) + 500
    const timer = setTimeout(() => {
      pending.delete(id)
      log('error', 'sandbox worker timed out; recycling + in-process fallback')
      recycleWorker('timed out')
      inProcess(job).then(resolve)
    }, budget)
    pending.set(id, { resolve, timer })
    w.postMessage({ id, job })
  })
}

/** Tear down the worker (app shutdown / tests). */
export const disposeSandbox = (): void => {
  recycleWorker('disposed')
  workerBroken = false
}
