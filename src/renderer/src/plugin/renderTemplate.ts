import { evalTemplate, stripTags, TemplateContext } from '../../../shared/templateEngine'
import { initRendererEngine } from './rendererEngine'
import { useCharacterStore } from '../stores/characterStore'
import { useSettingsStore } from '../stores/settingsStore'

// Start the quickjs WASM load at app start so the engine is ready before the first
// message renders. Until it's ready, evalTemplate strips tags gracefully (fail-safe).
void initRendererEngine()

/**
 * Assemble a render-time TemplateContext from the current stores + a floor's variables.
 * Mirrors the build-time context (generationService): vars = the message's variables,
 * constants userName/charName, data.charData = the active card.
 */
export function buildRenderContext(vars: Record<string, unknown>): TemplateContext {
  const card = useCharacterStore.getState().activeCharacter?.card
  const persona = useSettingsStore.getState().settings?.persona
  return {
    vars,
    globals: {},
    constants: {
      userName: persona?.name || 'User',
      charName: card?.data?.name || 'Character'
    },
    data: { charData: card?.data },
    enabled: true
  }
}

/**
 * Render-time EJS eval of message text for display, gated by the settings toggles:
 * - master engine off → strip tags (matches build-time behavior),
 * - render-time off / this mode off → leave the text raw (unprocessed),
 * - otherwise → evaluate against the floor's variables.
 * `mode` selects the per-mode toggle (final pass on complete vs live during streaming).
 */
export function renderTemplate(
  text: string,
  vars: Record<string, unknown>,
  mode: 'final' | 'live'
): string {
  if (!text || !text.includes('<%')) return text
  const t = useSettingsStore.getState().settings?.templates
  if (t?.enabled === false) return stripTags(text)
  const r = t?.render
  const modeOn = mode === 'final' ? r?.final_pass !== false : r?.live !== false
  if (r?.enabled === false || !modeOn) return text
  return evalTemplate(text, buildRenderContext(vars))
}
