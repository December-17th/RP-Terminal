/// <reference types="vite/client" />
// src/renderer/src/cardBridge/cardLibs.ts
//
// DOM-binding libraries the card expects as globals (window.Vue, window.$, window.Pinia,
// window.VueRouter, plus the SP2 additions: jQuery-UI, touch-punch, FontAwesome, Tailwind). They must
// execute in the IFRAME's realm so they bind to the iframe's document and pass cross-realm instanceof
// checks — so we inject them as classic <script src>/<link> tags (iframe-realm), NOT by assigning the
// renderer's Vue onto the iframe (that would create nodes in the top document and break Vue's instanceof
// guards). Vite `?url` resolves each vendored asset to a same-origin URL the iframe can load.
import vueUrl from '../../../../node_modules/vue/dist/vue.global.prod.js?url'
import jqueryUrl from '../../../../node_modules/jquery/dist/jquery.min.js?url'
import piniaUrl from '../../../../node_modules/pinia/dist/pinia.iife.prod.js?url'
import vueRouterUrl from '../../../../node_modules/vue-router/dist/vue-router.global.prod.js?url'
// Tailwind is vendored (the Play CDN is "not for production" / rate-limited) — see resources/cardlibs/.
import tailwindUrl from '../../../../resources/cardlibs/tailwind.min.js?url'
import {
  FONTAWESOME_CSS_URL,
  JQUERY_UI_JS_URL,
  JQUERY_UI_THEME_CSS_URL,
  JQUERY_UI_TOUCH_PUNCH_URL,
  MOTION_JS_URL
} from '../../../shared/cardEnv'

const cssTag = (href: string): string => `<link rel="stylesheet" href="${href}">`
const jsTag = (src: string): string => `<script src="${src}"></script>`

/**
 * The full ordered set of assumed-lib tags for an INLINE card, matching JS-Slash-Runner's `third_party`
 * env. CSS as <link>, JS as classic <script src>. Intra-family order is load-bearing: jQuery → jQuery-UI
 * → touch-punch (touch-punch patches jQuery-UI, which extends jQuery); Vue → Vue-Router/Pinia (they bind
 * window.Vue). Tailwind is the vendored same-origin asset; FontAwesome / jQuery-UI / touch-punch are CDN.
 */
export function buildInlineLibTags(): string {
  return [
    cssTag(FONTAWESOME_CSS_URL),
    cssTag(JQUERY_UI_THEME_CSS_URL),
    jsTag(tailwindUrl),
    jsTag(jqueryUrl),
    jsTag(JQUERY_UI_JS_URL),
    jsTag(JQUERY_UI_TOUCH_PUNCH_URL),
    jsTag(vueUrl),
    jsTag(vueRouterUrl),
    jsTag(piniaUrl),
    jsTag(MOTION_JS_URL)
  ].join('')
}
