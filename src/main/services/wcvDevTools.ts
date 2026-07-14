/**
 * Detached DevTools windows are deliberately opt-in: one is created for every
 * isolated card panel, which is overwhelming during normal app use.
 */
export const shouldOpenWcvDevTools = (environment: NodeJS.ProcessEnv): boolean =>
  environment.RPT_OPEN_WCV_DEVTOOLS === '1'
