/**
 * PLOT-RECALL (WP5) — default content for the `memory.recall` planner node, ADAPTED (owner-approved
 * re-use, plan §"Owner decisions" #1) from the reference preset's stage-3 task `剧情推进与召回`
 * (`plotGroup`) + preset-level `finalSystemDirective` in
 * `example .../命定之诗/Can改数据库剧情推进预设-世界后台引擎v3.5.json`.
 *
 * Adaptations applied (plan WP5 / design §Approach):
 *   · `AM####` → `MT####` (RPT's authored memory-code convention — decision #2). Matching stays
 *     generic exact-key, so imported `AM`-coded cards still work; only the DEFAULT prompt says `MT`.
 *   · Stripped the stage-1/2 machinery the RPT node contract does NOT provide: the `{{WorldDynamic}}`/
 *     `{{OffstageDynamic}}`/`{{UpdateVariable}}` living-world + offstage tags, the calendar / ledger
 *     EJS (`getMessageVar` / `getvar`) blocks, the d20 beat-planning step machine, and the
 *     `$U`/`$C`/`$1` persona/setting/worldbook slots (the node provides none of them — NOT grown for
 *     this: the DM already sees the transcript + action).
 *   · Slot mapping to the node's contract: reference `$5` (纪要索引) → {{catalogue}}, `$7` (前文剧情) →
 *     the transcript (`{history}`), `$8` (Participant 本轮输入) → {{action}}, the previous plan
 *     (`getMessageVar('剧情规划')`) → {{plan}}. Notes TOC ({{notes_toc}}) is RPT-new (the grep corpus).
 *   · `<Recall_format>` count-by-narrative-weight rule KEPT but the bands are scaled DOWN from the
 *     reference (light 12–18 / medium 20–28 / heavy 25–32) to respect the node's `max_rows` 24 default
 *     — the node hard-caps at `max_rows`, so bands above it would only be silently truncated.
 *
 * Kept in its OWN file, apart from the node logic (`recallNodes.ts`): this is the WP5 content diff and
 * it never touches node logic. These are plain named exports (the same style as
 * `MAINTAINER_SYSTEM_PROMPT` in `defaultMemoryTemplate.ts`) so tests can pin them. This is document
 * DATA, not app-UI chrome — deliberately NOT routed through i18n; the prompt text stays zh (the proven
 * contract of the source preset).
 *
 * SLOT CONTRACT (owned by `recallNodes.ts` — this file MUST keep using these exact tokens):
 *   planner messages — {{catalogue}} {{notes_toc}} {{action}} {{plan}}, plus a `{history}` marker
 *     (a row that is EXACTLY `{history}` splices the transcript role-preserving; an inline `{history}`
 *     is substituted with the flattened transcript text — the memory.maintain discipline). The scaffold
 *     ends on a single `user` row (inline `{history}`) so the composed prompt ends on a `user` turn —
 *     a trailing standalone-`{history}`/assistant row makes OpenAI-compatible Gemini return an empty
 *     completion (the same guard as the maintainer prompt).
 *   directive       — {{StoryEngine}} {{QuestPlan}} {{recalled}} {{notes}} (empty slots collapse).
 */

/** One role-tagged scaffold row (mirrors the memory.maintain message shape). */
export interface RecallMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** The adapted stage-3 planner scaffold (zh). A `system` row carries the DM framing + the output-format
 *  contract (Recall_format / StoryEngine / QuestPlan / optional Query); ONE `user` row carries the data
 *  slots and ends the prompt on a `user` turn (inline `{history}`). */
export const RECALL_PLANNER_MESSAGES: RecallMessage[] = [
  {
    role: 'system',
    content: `[CLEAR :: 重置角色与任务，开始新任务]
身份确认：你是大师级DM「爱德华」，负责本轮正文生成之前的历史记忆召回与剧情规划。你通读设定、过目不忘，只做规划、不写正文。

最高任务：结合下方的「纪要索引」（历史记忆的目录）、「前文剧情」与「本轮输入」，召回与本轮相关的历史记忆编码，并给出简洁的剧情规划，供正文叙述者参考。

硬性纪律：
- 只输出下方规定的标签内容，不输出任何故事正文、旁白或对话；不做 meta 评论，不解释推理过程。
- <Recall> 只能从「纪要索引」中已列出的编码里挑选，禁止编造不存在的编码。
- 所有标签必须闭合；不同标签之间仅有换行符，标签内不写额外说明。

<Recall_format>
记忆召回编写规则：
  - 仅输出记忆编码，格式为纯「MT+四位数字」（如 MT0007），多条用英文逗号分隔。
  - 数量与本轮叙事分量联动（分量由你根据本轮输入与前文自行判断）：
    - 轻分量（日常互动、关系维护、环境探索、闲笔）：6 至 10 条。
    - 中分量（支线进展、次要冲突、信息收集）：10 至 16 条。
    - 重分量（关键抉择、重大揭示、危险降临）：16 至 24 条。
  - 编码来源仅限「纪要索引」；若索引总条数不足下限，全列即可，不得虚构编码。
  - 优先召回与本轮地点、在场角色、当前任务强相关的记忆；不足时纳入同地点 / 同角色 / 相似情境的次相关记忆，直到达到该分量下限。
</Recall_format>

<Query_format>（可选）
若「笔记目录」中存在与本轮相关、需要展开原文的条目，可用 <Query> 输出检索关键词（每行一个或用逗号分隔），系统会据此检索笔记原文。无此需要时省略该标签。
</Query_format>

<StoryEngine_format>
  - [tone]：本轮叙事须遵循的基调与禁止事项（硬约束，1-3 条）。
  - [quest_log]：活跃任务日志，每条一行——☑ 已完成、▶ 进行中、☐ 待执行、📅 收束等待。
  - [archive]：已完成任务归档（结局已定，可引用不可推翻）；逐条复制上轮归档，仅新增置顶。
  - [cast]：场景角色状态——在场（可互动）、入场（附登场缘由）、离场（附离场缘由）。
</StoryEngine_format>

<QuestPlan_format>
  - 对活跃任务给出简洁的节拍规划：当前进行到哪一拍、下一步、以及本轮的微观行动方向。轻分量轮次可从简。
</QuestPlan_format>

【固定输出格式】按以下顺序输出，标签之间仅换行：
<StoryEngine>…</StoryEngine>
<QuestPlan>…</QuestPlan>
<Recall>…</Recall>
（如需检索笔记，另加 <Query>…</Query>）`
  },
  {
    role: 'user',
    content: `# 纪要索引（历史记忆目录，<Recall> 只能从这里挑选编码）：
<纪要索引>
{{catalogue}}
</纪要索引>

# 笔记目录（可用 <Query> 检索原文的条目标题）：
<笔记目录>
{{notes_toc}}
</笔记目录>

# 你上一轮的剧情规划（参考，可能为空）：
<旧剧情规划>
{{plan}}
</旧剧情规划>

# 前文剧情（最近若干轮）：
<前文剧情>
{history}
</前文剧情>

# 本轮输入（Participant 的行动，尚未发生的正文，仅作规划依据）：
<本轮输入>
{{action}}
</本轮输入>`
  }
]

/** The adapted `finalSystemDirective` (zh): the tail block composed after the planner reply and injected
 *  as a system message just before the user action. Stripped of the stage-1/2 world/offstage/variable
 *  tags and the `$8`/calendar/日期 EJS; carries the召回的历史记忆 ({{recalled}}) + note hits ({{notes}})
 *  plus the planner's opaque {{StoryEngine}} / {{QuestPlan}}. Empty slots collapse (the node trims). */
export const RECALL_DIRECTIVE = `<剧情规划>
（以下为本轮正文生成前，DM 完成的历史召回与剧情规划，供叙述者参考。这些是规划与历史信息，不是本轮已发生的正文；禁止将其当作已发生的对话或旁白直接照搬，须自然融入叙事。）

{{recalled}}

{{notes}}

{{StoryEngine}}
{{QuestPlan}}

标签说明：
- <记忆回溯>：由本轮 [Recall] 编码召回的历史记忆条目，是过往已明确发生的事实，可引用不可推翻。
- [StoryEngine]
  - [tone]：本轮叙事须遵循的基调与禁止事项（硬约束，非建议）。
  - [quest_log]：活跃任务日志——☑ 已完成、▶ 进行中、☐ 待执行、📅 收束等待。
  - [archive]：已完成任务归档（结局已定，可引用不可推翻）。
  - [cast]：场景角色状态——在场（可互动）、入场（需交代登场缘由）、离场（不可凭空再现）。
- [QuestPlan]：本轮剧情的节拍规划参考。
</剧情规划>`
