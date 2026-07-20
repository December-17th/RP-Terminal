// Relocated to `services/memory/memoryCore.ts` (execution-plan M5c-1): the SQL-table memory cores are
// shared by the converted Memory Maintenance Agent bridge and the memory IPC, none of which may import
// the node engine. Re-exported here so the (still-present, deleted in M5c-2) node files keep importing
// them from `./memoryCore`.
export * from '../../memory/memoryCore'
