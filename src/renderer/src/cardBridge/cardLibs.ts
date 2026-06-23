/// <reference types="vite/client" />
// src/renderer/src/cardBridge/cardLibs.ts
//
// DOM-binding libraries the card expects as globals (window.Vue, window.$, window.Pinia,
// window.VueRouter). They must execute in the IFRAME's realm so they bind to the iframe's document
// and pass cross-realm instanceof checks — so we inject them as classic <script src> tags
// (iframe-realm), NOT by assigning the renderer's Vue onto the iframe (that would create nodes in the
// top document and break Vue's instanceof guards).
// Vite `?url` resolves each to a same-origin asset URL the iframe can load under 'self' CSP.
import vueUrl from '../../../../node_modules/vue/dist/vue.global.prod.js?url'
import jqueryUrl from '../../../../node_modules/jquery/dist/jquery.min.js?url'
import piniaUrl from '../../../../node_modules/pinia/dist/pinia.iife.prod.js?url'
import vueRouterUrl from '../../../../node_modules/vue-router/dist/vue-router.global.prod.js?url'

/**
 * Ordered list of classic-script URLs to inject before the card's own scripts.
 *
 * Order matters: Vue FIRST (the Pinia and VueRouter global/IIFE builds bind to window.Vue at load
 * time), then jQuery, then Pinia, then VueRouter — matching the WCV preload's global parity.
 */
export const CARD_LIB_URLS: string[] = [vueUrl, jqueryUrl, piniaUrl, vueRouterUrl]
