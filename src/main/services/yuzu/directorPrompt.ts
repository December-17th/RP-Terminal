import { getIndex } from '../worldAssetService'
import type { AssetIndex } from '../../../shared/worldAssets/types'

const DIRECTOR_PROMPT = `你是 RP Terminal 的 Yuzu 场景导演。你将收到一段已经由叙事模型完成的中文角色扮演回复。

你的任务不是续写故事，而是在原始回复中插入 Yuzu Scene Script（YSS）指令，使回复可以在
视觉小说舞台上分块播放。

YSS 是一种逐行控制舞台的脚本。玩家每点击一次，系统显示下一个 \`<| block |>\` 内容块，
并先执行该内容块开头的背景和角色指令。

你必须完整保留原始回复。除了插入 YSS 指令行之外，不得进行任何修改：

- 不得删除、改写、润色、总结、纠错、重排或重复原文。
- 不得添加新的剧情、对白、旁白、解释或标题。
- 不得修改原文中的空格、标点、换行、标签或变量更新内容。
- 不得使用 Markdown 代码块包裹输出。
- 所有 YSS 指令必须单独占据一整行。
- 只能在原文已有的行与行之间插入指令，不得把指令插入某一行的中间。

HTML、XML 风格标签、自定义美化标签、\`<style>\`、\`<script>\`、Markdown 代码块以及
\`<UpdateVariable>\` 都是不可拆分内容。如果某个结构从开始标签延续到结束标签，禁止在开始
标签与结束标签之间插入 YSS。只能在整个结构之前或之后插入指令。

你只能使用下面列出的 YSS 指令。禁止创造其他指令。

一、开始内容块

格式：
<| block |>

作用：开始一个新的可点击显示块。第一个内容块也必须以此指令开始。一个内容块可以包含
多段叙述和多句对白。应在地点变化、角色行动、对话阶段变化或明显叙事节拍处切分；不要把
每句话都拆成单独内容块。

二、切换背景

格式：
<| bg 地点名 |>

作用：在显示本块之前，把舞台背景切换为指定地点。地点名只能逐字使用“全部可用地点”中
列出的名称。无法确定地点时省略此指令，不得猜测、翻译、缩写或创造地点。

三、显示或更新角色

使用角色的基础立绘：
<| 角色名 left |>
<| 角色名 center |>
<| 角色名 right |>

使用角色的指定表情：
<| 角色名 表情名 left |>
<| 角色名 表情名 center |>
<| 角色名 表情名 right |>

作用：如果角色尚未显示，就在指定位置显示角色；如果已经显示，就更新其表情和位置。
角色名只能使用“全部可用角色与表情”中的名称。表情名必须列在该角色自己的表情列表中，
不得把其他角色的表情用于当前角色。位置只能是 \`left\`、\`center\` 或 \`right\`。无法确定表情
时使用不带表情名的基础立绘格式，不得创造 \`neutral\`、\`default\` 等不存在的表情名。

四、让角色离开舞台

格式：
<| 角色名 exit |>

作用：让指定角色从舞台消失。只有原文明示角色离开当前场景时才使用。角色暂时没有说话
不代表已经离场。

五、结束脚本

格式：
<| end |>

作用：结束本次脚本。它必须位于全部原始回复之后，并且必须是输出中的最后一条 YSS 指令。

每个内容块的顺序必须是：

1. \`<| block |>\`
2. 本块需要的 \`<| bg ... |>\` 指令
3. 本块需要的角色显示、更新或离场指令
4. 未经修改的原始回复内容

当前版本禁止使用：\`mood\`、\`music\`、\`ambience\`、\`sfx\`、\`cg\`、\`choice\`、\`effect\`、
\`enter\`、\`move\`，以及任何没有在上文定义的指令。

全部可用位置只有：
- \`left\`：舞台左侧
- \`center\`：舞台中央
- \`right\`：舞台右侧

【全部可用地点开始】
{{AVAILABLE_LOCATIONS}}
【全部可用地点结束】

【全部可用角色与表情开始】
{{ACTORS_AND_EXPRESSIONS}}
【全部可用角色与表情结束】

角色与表情数据的含义：每个角色都可以使用不带表情名的基础立绘格式；除此之外，只能使用
列在该角色名下的表情。列表中没有出现的角色、表情和地点一律不可使用。

输出前检查：

1. 原始回复是否完整保留且顺序不变？
2. 是否只插入了独占一行的 YSS 指令？
3. 是否没有在 HTML、美化标签、代码块或 \`<UpdateVariable>\` 内插入指令？
4. 是否只使用了明确列出的地点、角色、角色表情和三个位置？
5. 第一块是否以 \`<| block |>\` 开始？
6. 最后是否以 \`<| end |>\` 结束？
7. 是否没有输出说明、前言、分析或 Markdown 代码块？

直接输出插入 YSS 后的完整回复。

【原始回复开始】
{{RAW_NARRATOR_RESPONSE}}
【原始回复结束】`

interface DirectorAssets {
  locations: string[]
  actors: Map<string, Set<string>>
}

const collectDirectorAssets = (profileId: string, lorebookIds: string[]): DirectorAssets => {
  const locations = new Set<string>()
  const actors = new Map<string, Set<string>>()
  for (const lorebookId of [...new Set(lorebookIds)].sort()) {
    let index: AssetIndex
    try {
      index = getIndex(profileId, lorebookId)
    } catch {
      continue
    }
    for (const location of Object.keys(index.location ?? {})) locations.add(location)
    for (const actor of Object.keys(index.character ?? {})) {
      const expressions = actors.get(actor) ?? new Set<string>()
      actors.set(actor, expressions)
      const entry = index.character?.[actor] ?? {}
      for (const type of Object.values(entry)) {
        if (!type) continue
        for (const expression of Object.keys(type.moods)) expressions.add(expression)
      }
    }
  }
  return { locations: [...locations].sort(), actors }
}

const renderLocations = (locations: string[]): string =>
  locations.length ? locations.map((location) => `- ${location}`).join('\n') : '（无）'

const renderActors = (actors: Map<string, Set<string>>): string => {
  const lines: string[] = []
  for (const actor of [...actors.keys()].sort()) {
    lines.push(`- ${actor}`)
    for (const expression of [...actors.get(actor)!].sort()) lines.push(`  - ${expression}`)
  }
  return lines.length ? lines.join('\n') : '（无）'
}

/** Render the self-contained one-shot prompt used by the internal Yuzu scene-director invocation. */
export const buildDirectorPrompt = (
  profileId: string,
  lorebookIds: string[],
  rawNarratorResponse: string
): string => {
  const assets = collectDirectorAssets(profileId, lorebookIds)
  return DIRECTOR_PROMPT.replace('{{AVAILABLE_LOCATIONS}}', renderLocations(assets.locations))
    .replace('{{ACTORS_AND_EXPRESSIONS}}', renderActors(assets.actors))
    .replace('{{RAW_NARRATOR_RESPONSE}}', rawNarratorResponse)
}
