// Relocated to `generation/promptArtifact.ts` (execution-plan M5c-1): the dispatch/artifact model is a
// pure generation module the direct Classic path needs after the node engine is deleted. Re-exported
// here so the (still-present, deleted in M5c-2) node registry keeps importing it from `./promptArtifact`.
export * from '../generation/promptArtifact'
