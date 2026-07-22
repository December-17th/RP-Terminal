export interface DuplicateImportDetails {
  installedName: string
  installedCreator: string
  installedVersion: string
  incomingName: string
  incomingCreator: string
  incomingVersion: string
  matchCount: number
}

export interface CharacterImportText {
  worldCards: string
  assetZip: string
  chooseZip: string
  skip: string
  importAssets: string
  importAssetsDetail: string
  duplicateButtons: string[]
  duplicateMessage: (name: string) => string
  duplicateDetail: (details: DuplicateImportDetails) => string
  install: string
  cancel: string
  importMessage: (name: string) => string
  bundleIntro: (isWorldCard: boolean) => string
  bundleItem: (count: number, kind: BundleKind) => string
}

export type BundleKind =
  | 'loreEntries'
  | 'lorebooks'
  | 'regexScripts'
  | 'presets'
  | 'scripts'
  | 'cardCodeSurfaces'
  | 'uiWidgets'
  | 'tableTemplates'
  | 'pluginsSkipped'
  | 'scriptedAgents'

const englishKinds: Record<BundleKind, string> = {
  loreEntries: 'lore entries',
  lorebooks: 'extra lorebooks',
  regexScripts: 'regex scripts',
  presets: 'presets',
  scripts: 'card scripts',
  cardCodeSurfaces: 'card-code UI surfaces',
  uiWidgets: 'UI widgets',
  tableTemplates: 'memory table templates',
  pluginsSkipped: 'plugins (skipped — not yet supported)',
  scriptedAgents: 'scripted Agents'
}

const english: CharacterImportText = {
  worldCards: 'World Cards',
  assetZip: 'Asset Zip',
  chooseZip: 'Choose zip…',
  skip: 'Skip',
  importAssets: 'Import assets?',
  importAssetsDetail:
    'Optionally pick a .zip of images (character/ and location/ folders) to import with this world.',
  duplicateButtons: ['Update & keep saves', 'Import as new', 'Replace (delete saves)', 'Cancel'],
  duplicateMessage: (name) => `"${name}" is already installed`,
  duplicateDetail: (details) => {
    const installedCreator = details.installedCreator ? ` by ${details.installedCreator}` : ''
    const installedVersion = details.installedVersion ? ` (v${details.installedVersion})` : ''
    const incomingCreator = details.incomingCreator ? ` by ${details.incomingCreator}` : ''
    const incomingVersion = details.incomingVersion ? ` (v${details.incomingVersion})` : ''
    const duplicateNote =
      details.matchCount > 1
        ? `\n\n${details.matchCount} copies are already installed — Update/Replace act on the most recent.`
        : ''
    return (
      `Installed: ${details.installedName}${installedCreator}${installedVersion}\n` +
      `Importing: ${details.incomingName}${incomingCreator}${incomingVersion}\n\n` +
      '• Update & keep saves — refresh this world’s card, scripts and lore; keep all sessions.\n' +
      '• Import as new — install a separate copy.\n' +
      '• Replace — import the new world first, then delete the installed world and its saved sessions.' +
      duplicateNote
    )
  },
  install: 'Install',
  cancel: 'Cancel',
  importMessage: (name) => `Import "${name}"`,
  bundleIntro: (isWorldCard) =>
    isWorldCard ? 'This World Card bundles:\n' : 'This card bundles:\n',
  bundleItem: (count, kind) => `${count} ${englishKinds[kind]}`
}

const chineseKinds: Record<BundleKind, string> = {
  cardCodeSurfaces: '个卡片代码界面',
  loreEntries: '条世界书条目',
  lorebooks: '本额外世界书',
  regexScripts: '个正则脚本',
  presets: '个预设',
  scripts: '个角色卡脚本',
  uiWidgets: '个界面组件',
  tableTemplates: '个记忆表模板',
  pluginsSkipped: '个插件（已跳过，暂不支持）',
  scriptedAgents: '个带处理脚本的智能体'
}

const chinese: CharacterImportText = {
  worldCards: '世界卡',
  assetZip: '资源压缩包',
  chooseZip: '选择 zip…',
  skip: '跳过',
  importAssets: '导入资源？',
  importAssetsDetail: '可选择包含图片的 .zip（character/ 和 location/ 文件夹）随世界一起导入。',
  duplicateButtons: ['更新并保留存档', '作为新世界导入', '替换（删除存档）', '取消'],
  duplicateMessage: (name) => `“${name}”已安装`,
  duplicateDetail: (details) => {
    const installedCreator = details.installedCreator ? `，作者 ${details.installedCreator}` : ''
    const installedVersion = details.installedVersion ? `（v${details.installedVersion}）` : ''
    const incomingCreator = details.incomingCreator ? `，作者 ${details.incomingCreator}` : ''
    const incomingVersion = details.incomingVersion ? `（v${details.incomingVersion}）` : ''
    const duplicateNote =
      details.matchCount > 1
        ? `\n\n已安装 ${details.matchCount} 个副本；更新或替换将作用于最近安装的副本。`
        : ''
    return (
      `已安装：${details.installedName}${installedCreator}${installedVersion}\n` +
      `将导入：${details.incomingName}${incomingCreator}${incomingVersion}\n\n` +
      '• 更新并保留存档——刷新角色卡、脚本和世界书，保留所有会话。\n' +
      '• 作为新世界导入——安装一个独立副本。\n' +
      '• 替换——先完整导入新世界，再删除已安装的世界及其存档。' +
      duplicateNote
    )
  },
  install: '安装',
  cancel: '取消',
  importMessage: (name) => `导入“${name}”`,
  bundleIntro: (isWorldCard) => (isWorldCard ? '此世界卡包含：\n' : '此角色卡包含：\n'),
  bundleItem: (count, kind) => `${count} ${chineseKinds[kind]}`
}

export const getCharacterImportText = (locale: string): CharacterImportText =>
  locale.toLowerCase().startsWith('zh') ? chinese : english
