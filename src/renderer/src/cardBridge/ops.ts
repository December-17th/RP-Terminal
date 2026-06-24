// src/renderer/src/cardBridge/ops.ts
// Moved to shared/thRuntime/ops.ts (used by both the inline + WCV transports). Re-exported here so
// existing renderer imports keep working.
export * from '../../../shared/thRuntime/ops'
export type { VarOp } from '../../../shared/thRuntime/ops'
