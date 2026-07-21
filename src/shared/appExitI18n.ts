export const EXIT_WARNING_KEYS = {
  quitAnyway: 'exit.warning.quitAnyway',
  keepWorking: 'exit.warning.keepWorking',
  message: 'exit.warning.message',
  detail: 'exit.warning.detail'
} as const

export type ExitWarningKey = (typeof EXIT_WARNING_KEYS)[keyof typeof EXIT_WARNING_KEYS]

export const EXIT_WARNING_STRINGS: Record<'en' | 'zh', Record<ExitWarningKey, string>> = {
  en: {
    [EXIT_WARNING_KEYS.quitAnyway]: 'Quit anyway',
    [EXIT_WARNING_KEYS.keepWorking]: 'Keep working',
    [EXIT_WARNING_KEYS.message]: 'Background work is still running',
    [EXIT_WARNING_KEYS.detail]:
      'A turn, a combat or duel narration, an Agent invocation, or a trigger evaluation is still in flight. Quitting now cancels it and discards whatever it has not saved yet.'
  },
  zh: {
    [EXIT_WARNING_KEYS.quitAnyway]: '仍然退出',
    [EXIT_WARNING_KEYS.keepWorking]: '继续运行',
    [EXIT_WARNING_KEYS.message]: '仍有后台任务正在运行',
    [EXIT_WARNING_KEYS.detail]:
      '仍有回合、战斗或决斗叙述、智能体调用或触发器评估正在进行。现在退出会取消该任务，并丢弃尚未保存的内容。'
  }
}

export const translateExitWarning = (locale: string, key: ExitWarningKey): string =>
  EXIT_WARNING_STRINGS[locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'][key]
