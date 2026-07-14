// Pure staging model for the Memory Manager's Structure tab (table-refill WS6 Phase C): structural
// ops STAGE locally (VS Code Source-Control style, per-op undo) and commit as ONE batch through the
// existing `applyTableStructure` IPC — which validates the whole batch all-or-nothing and migrates
// every bound chat, re-baselining its op log (⇒ partial refill disabled for those tables, plan §0b-3).
// Staging replaces the old per-op window.confirm: the ONE confirm happens at Apply, with the fan-out
// preview. React-free, pinned by test/memoryManagerModels.test.ts.

/** One structural op (the `applyTableStructure` wire shape — mirrors tableStructureService). */
export type StructOp =
  | { kind: 'addColumn'; uid: string; name: string; type?: string }
  | { kind: 'renameColumn'; uid: string; from: string; to: string }
  | { kind: 'dropColumn'; uid: string; name: string }
  | { kind: 'renameTable'; uid: string; sqlName: string; displayName?: string }
  | { kind: 'dropTable'; uid: string }

/** The i18n key + params a staged op renders with (the component applies `t`). `table` is the
 *  DISPLAY name the caller resolves from the op's uid. */
export const describeStagedOp = (
  op: StructOp,
  table: string
): { key: string; params: Record<string, string> } => {
  switch (op.kind) {
    case 'renameTable':
      return { key: 'memoryManager.structure.staged.renameTable', params: { from: table, to: op.displayName ?? '' } }
    case 'dropTable':
      return { key: 'memoryManager.structure.staged.dropTable', params: { name: table } }
    case 'addColumn':
      return { key: 'memoryManager.structure.staged.addColumn', params: { table, name: op.name } }
    case 'renameColumn':
      return { key: 'memoryManager.structure.staged.renameColumn', params: { table, from: op.from, to: op.to } }
    case 'dropColumn':
      return { key: 'memoryManager.structure.staged.dropColumn', params: { table, name: op.name } }
  }
}

/** Tables already staged for DROP — further ops on them are meaningless and their rows render
 *  struck-through with actions disabled. */
export const droppedTableUids = (staged: StructOp[]): Set<string> =>
  new Set(staged.filter((o) => o.kind === 'dropTable').map((o) => o.uid))

/** Columns already staged for DROP per table uid (same disable treatment at column level). */
export const droppedColumns = (staged: StructOp[], uid: string): Set<string> =>
  new Set(
    staged.filter((o): o is Extract<StructOp, { kind: 'dropColumn' }> => o.kind === 'dropColumn' && o.uid === uid).map((o) => o.name)
  )

/** Whether a new op may be staged: nothing stages onto a table that is already staged for drop
 *  (except nothing — even a second dropTable is refused as a no-op duplicate). */
export const canStage = (staged: StructOp[], op: StructOp): boolean => {
  const dropped = droppedTableUids(staged)
  if (dropped.has(op.uid)) return false
  if (op.kind === 'dropColumn' && droppedColumns(staged, op.uid).has(op.name)) return false
  return true
}
