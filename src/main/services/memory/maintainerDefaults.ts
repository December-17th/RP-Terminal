import type { MemoryMaintainConfig } from './maintainerCompose'

/**
 * The BUILT-IN default maintainer config for the converted Memory Maintenance Agent (execution-plan
 * M5c-1, scaffold re-home part 1).
 *
 * Before M5c-1 the bridge read the maintainer SCAFFOLD (system prompt + `{history}` user row),
 * `lastNFloors`, `max_rows`, retries, and `advance_progress` off the still-live workflow doc via
 * `resolveEffectiveDoc`. The bridge no longer touches the doc: these values are the config that
 * `buildDefaultMemoryDocV2` ships on its `memory.maintain` node, lifted here as the built-in default so
 * the bridge composes byte-identically to a pristine seeded profile with NO doc dependency. Profile-local
 * NON-DEFAULT overrides ride the Agent's `invocation_config.maintain` (seeded once in
 * `memoryMaintenanceSettingsSeed.ts`); the bridge computes `DEFAULT ⊕ invocation_config.maintain`.
 *
 * `MAINTAINER_SYSTEM_PROMPT` is defined HERE (not in the node template) as the single source of truth;
 * `defaultMemoryTemplate.ts` imports it so the seeded doc and the built-in default can never drift.
 */

/** The maintainer framing system prompt — the verbatim proven prompt shared by the seeded doc's
 *  `memory.maintain` node and this built-in default. `{{input}}` is the tables-block placeholder. */
export const MAINTAINER_SYSTEM_PROMPT =
  '你是数据库表格维护AI（database-table maintenance AI）。下面是记忆表格，每个表附带其定义与可执行的操作，随后是自上次维护以来的剧情。请根据这段剧情更新表格。\n\n将【本批剧情】整体视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。\n\n【表格与规则】\n{{input}}\n\n规则：\n1. 只输出 SQL 语句，全部包裹在一个 <TableEdit>…</TableEdit> 标签内。标签内不要写任何解释或注释。\n2. 仅允许对上面列出的表执行 INSERT / UPDATE / DELETE，禁止其它操作。\n3. 严格遵循每个表的【插入规则】【更新规则】【删除规则】（表为空时遵循【初始化规则】）。\n4. 只在确有变化时更新；若本批没有任何需要写入的变化，输出一个空的 <TableEdit></TableEdit>。\n5. 表格是历史档案，不是创作工具：只记录剧情中已经明确发生的事实。禁止编造、推测、预告或推进任何新剧情、新事件、新对话；禁止把"计划""预测""可能发生的事"写入任何表；没有把握的内容一律不写。'

/**
 * The built-in default `MemoryMaintainConfig` — the maintain-node config `buildDefaultMemoryDocV2` ships
 * (defaultMemoryTemplate.ts, the `maintain` node): full retry budget (5), `advance_progress`, 6 trailing
 * floors, 30-row cap, and the two-row scaffold ending on an inline-`{history}` user turn.
 */
export const DEFAULT_MEMORY_MAINTAIN_CONFIG: MemoryMaintainConfig = {
  stream: false,
  retries: 5,
  advance_progress: true,
  lastNFloors: 6,
  max_rows: 30,
  messages: [
    { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
    { role: 'user', content: '【本批剧情】\n{history}' }
  ]
}
