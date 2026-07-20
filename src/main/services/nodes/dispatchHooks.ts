// Relocated to `generation/dispatchHooks.ts` (execution-plan M5c-1): the pre-dispatch hook registry is
// read by the direct Classic path's `mainSample`, so it lives in `generation/` after the node engine is
// deleted. Re-exported here so the (still-present) node registry imports it from `./dispatchHooks`.
export * from '../generation/dispatchHooks'
