// Minimal app-UI i18n: a tiny `t()` over per-locale string maps + a zustand store for the active locale
// (so components re-render on change). Clean-room, no dependency. Locale persists via settings.ui.locale
// (App syncs it into this store). App-UI only — NOT card content, which carries its own staticLocale.
import { create } from 'zustand'
import en from './locales/en'
import zh from './locales/zh'

const LOCALES: Record<string, Record<string, string>> = { en, zh }

export const LOCALE_LIST: { id: string; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'zh', name: '简体中文' }
]
export const DEFAULT_LOCALE = 'en'

interface I18nState {
  locale: string
  setLocale: (locale: string) => void
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) => set({ locale: LOCALES[locale] ? locale : DEFAULT_LOCALE })
}))

/** Look up `key` in `locale`, falling back to English then the raw key; interpolate `{{var}}`. */
export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>
): string {
  const dict = LOCALES[locale] || LOCALES[DEFAULT_LOCALE]
  let s = dict[key] ?? LOCALES[DEFAULT_LOCALE][key] ?? key
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split(`{{${k}}}`).join(String(vars[k]))
  }
  return s
}

/** Hook: a `t(key, vars?)` bound to the current locale (re-renders subscribers when it changes). */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const locale = useI18nStore((s) => s.locale)
  return (key, vars) => translate(locale, key, vars)
}

/** Hook: like useT but returns '' for a key missing in every locale — for OPTIONAL strings
 *  (e.g. per-node/per-port documentation) where the caller hides an absent entry instead of
 *  rendering the raw key. */
export function useOptionalT(): (key: string) => string {
  const locale = useI18nStore((s) => s.locale)
  return (key) => {
    const s = translate(locale, key)
    return s === key ? '' : s
  }
}
