import { getQuickJS, QuickJSWASMModule } from 'quickjs-emscripten'

/**
 * Sandbox harness core (Track 3 T3.2). Runs untrusted JS in an isolated quickjs
 * WASM VM — no Node, DOM, network, or filesystem; the only bindings are a JSON
 * `input`, a deterministic `rng`, and `emit`/`log` collectors. Deterministic
 * relative to (module, job): the same seed + input yields the same result, so
 * combat math (Phase I) and MVU schema validation (Track R / R4) are reproducible
 * and unit-testable.
 *
 * This module is shared by the worker entry (`workers/sandboxWorker`) and the
 * in-process fallback in `sandboxService` — it never touches `worker_threads`
 * itself, so it runs anywhere (including plain Node under Vitest).
 */

export interface SandboxJob {
  /** A function body run as `(input, rng, emit, log) => result`. Its return value
   * (JSON round-tripped) becomes `result`. `return` and `throw` both work. */
  code: string
  /** JSON-serializable input exposed to the script as `input`. */
  input?: unknown
  /** Seed for the deterministic RNG (also overrides `Math.random`). Default 0. */
  seed?: number
  /** Wall-clock budget; the VM is interrupted past it. Default 1000ms. */
  timeoutMs?: number
}

export interface SandboxResult<T = unknown> {
  ok: boolean
  result?: T
  /** Values passed to `emit(...)` inside the script, in order. */
  events: unknown[]
  /** Lines passed to `log(...)` inside the script, in order. */
  logs: string[]
  error?: string
}

let modPromise: Promise<QuickJSWASMModule> | null = null
/** Load (once) and cache the quickjs WASM module. */
export const getSandbox = (): Promise<QuickJSWASMModule> => {
  if (!modPromise) modPromise = getQuickJS()
  return modPromise
}

/** Deterministic PRNG (mulberry32) so sandbox runs are reproducible + testable. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v ?? null)
  } catch {
    return 'null'
  }
}

const errText = (e: unknown): string =>
  e && typeof e === 'object'
    ? (e as { message?: string }).message
      ? String((e as { message?: string }).message)
      : JSON.stringify(e)
    : String(e)

/**
 * Execute a sandbox job synchronously against a loaded quickjs module. A fresh
 * runtime + context is created per job (so jobs can't observe each other) with a
 * deadline-based interrupt handler enforcing the timeout. Never throws — failures
 * come back as `{ ok: false, error }`.
 */
export const runScript = <T = unknown>(
  mod: QuickJSWASMModule,
  job: SandboxJob
): SandboxResult<T> => {
  const events: unknown[] = []
  const logs: string[] = []
  const rng = mulberry32(job.seed ?? 0)
  const deadline = Date.now() + (job.timeoutMs ?? 1000)

  const runtime = mod.newRuntime()
  runtime.setInterruptHandler(() => Date.now() > deadline)
  const vm = runtime.newContext()
  try {
    const rngFn = vm.newFunction('__rng', () => vm.newNumber(rng()))
    vm.setProp(vm.global, '__rng', rngFn)
    rngFn.dispose()

    const emitFn = vm.newFunction('__emit', (h) => {
      try {
        events.push(vm.dump(h))
      } catch {
        /* skip unserializable */
      }
      return vm.undefined
    })
    vm.setProp(vm.global, '__emit', emitFn)
    emitFn.dispose()

    const logFn = vm.newFunction('__log', (...hs) => {
      logs.push(
        hs
          .map((h) => {
            try {
              return String(vm.dump(h))
            } catch {
              return ''
            }
          })
          .join(' ')
      )
      return vm.undefined
    })
    vm.setProp(vm.global, '__log', logFn)
    logFn.dispose()

    // Wrap the user code so its return value is captured and the helpers are in
    // scope. `Math.random` is overridden with the seeded rng for determinism.
    const program =
      `(function(){` +
      `var input=${safeJson(job.input)};` +
      `var rng=function(){return __rng();};` +
      `Math.random=rng;` +
      `var emit=function(e){__emit(e);};` +
      `var log=function(){__log.apply(null,Array.prototype.slice.call(arguments));};` +
      `var __r=(function(input,rng,emit,log){\n${job.code}\n})(input,rng,emit,log);` +
      `return JSON.stringify(__r===undefined?null:__r);` +
      `})()`

    const res = vm.evalCode(program)
    if (res.error) {
      const err = vm.dump(res.error)
      res.error.dispose()
      return { ok: false, events, logs, error: errText(err) }
    }
    const out = vm.getString(res.value)
    res.value.dispose()
    let result: unknown = null
    try {
      result = JSON.parse(out)
    } catch {
      result = out
    }
    return { ok: true, result: result as T, events, logs }
  } catch (e) {
    return { ok: false, events, logs, error: errText(e) }
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}
