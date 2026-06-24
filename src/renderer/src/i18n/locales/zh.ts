// Simplified Chinese (简体中文). Uses the SillyTavern-ecosystem terms (世界书 = lorebook, 预设 = preset,
// 正则 = regex, 脚本 = scripts) so they read naturally to the card community.
const zh: Record<string, string> = {
  'nav.persona': '用户人设',
  'nav.preset': '预设',
  'nav.lorebook': '世界书',
  'nav.api': 'API',
  'nav.settings': '设置',
  'nav.logs': '日志',
  'nav.backToWorlds': '返回世界列表',
  'nav.switchWorld': '切换世界',
  'nav.switchSession': '切换会话',
  'nav.session': '会话',

  'launcher.worlds': '世界',
  'launcher.chooseWorld': '选择一个世界',
  'launcher.chooseWorldSub': '每个世界都是一张角色卡 —— 其 PNG 图片即为头像。',
  'launcher.importCard': '+ 导入角色卡',
  'launcher.noWorlds': '还没有世界。导入一张角色卡开始吧。',
  'launcher.untitled': '未命名',
  'launcher.sessionsTitle': '{{name}} —— 会话',
  'launcher.sessionsSub': '继续之前的进度，或开启新的会话。',
  'launcher.newSession': '+ 新建会话',
  'launcher.noSessions': '还没有会话 —— 新建一个吧。',
  'launcher.emptySession': '空会话',
  'launcher.sessionOne': '{{count}} 个会话',
  'launcher.sessionMany': '{{count}} 个会话',

  'settings.title': '设置',
  'settings.groupApp': '应用',
  'settings.groupWorld': '世界',
  'settings.preferences': '偏好设置',
  'settings.regex': '正则',
  'settings.scripts': '脚本',
  'settings.language': '语言',

  'chat.sessionMode': '会话模式',
  'chat.modeExplore': '探索',
  'chat.modeDialogue': '对话',
  'chat.modeCombat': '战斗',
  'chat.switchToMode': '切换到「{{mode}}」模式',
  'chat.modeDisabledHint': '在「设置」中将智能体模式设为「手动」或「智能」以切换场景',
  'chat.regenerate': '重新生成',
  'chat.regenerateTitle': '重新生成上一条回复',

  'composer.placeholder': '你要做什么？（输入 / 调用命令）',
  'composer.send': '发送',
  'composer.stop': '停止生成',

  'profile.selectProfile': '选择配置档',
  'profile.newProfileName': '新配置档名称',
  'profile.create': '创建'
}

export default zh
