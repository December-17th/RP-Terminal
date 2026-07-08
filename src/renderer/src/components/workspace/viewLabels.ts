// Non-React module (no JSX imports) so a node-env vitest can import the view→i18n mapping
// and the built-in view id list without pulling the whole React view tree. Panel.tsx and
// viewRegistry.tsx both consume these; the parity test asserts every built-in id is mapped.

/** The built-in view ids hosted by a workspace panel. Kept in sync with `ViewRegistry`
 * (viewRegistry.tsx) via a compile-time check there. */
export const BUILTIN_VIEW_IDS = [
  'chat',
  'status',
  'combat',
  'duel',
  'variables',
  'tables',
  'assets',
  'usage',
  'logs'
] as const

export type BuiltinViewId = (typeof BUILTIN_VIEW_IDS)[number]

/** Maps the built-in view ids to i18n keys; unknown/spike views fall back to their English title. */
export const VIEW_LABEL_KEY: Record<string, string> = {
  chat: 'view.chat',
  status: 'status.heading',
  combat: 'view.combat',
  duel: 'view.duel',
  variables: 'view.variables',
  tables: 'view.tables',
  assets: 'view.assets',
  usage: 'view.usage',
  logs: 'logs.heading'
}
