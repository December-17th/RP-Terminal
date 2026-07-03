import React, { useEffect, useRef } from 'react'
import { useComposerStore } from '../stores/composerStore'
import { useChatStore } from '../stores/chatStore'

/**
 * SillyTavern DOM-compat shim. ST-ecosystem message scripts (行动选项-style clickable options and
 * friends) don't always go through APIs — they poke ST's DOM directly from their same-origin
 * message iframe:
 *
 *   window.parent.document.querySelector('#send_textarea').value = text  (+ dispatch 'input')
 *   window.parent.document.querySelector('#send_but').click()            (ST's send button)
 *
 * Inline card/message iframes here are same-origin (`InlineCardFrame` — sandbox="allow-scripts
 * allow-same-origin"), so those lookups reach THIS document. This component provides hidden,
 * UNCONTROLLED stand-ins wired to the composer store:
 *  - `#send_textarea` mirrors `composerStore.text` (so scripts that APPEND read the real current
 *    content); a script-dispatched `input` event injects the element's value into the real box
 *    (`injectInput`, which also focuses the Composer).
 *  - `#send_but` / `#send_butt` (ST's id and the common script variant) click → `requestSubmit()`
 *    — the same "press the send button" verb `/trigger` uses — refused mid-turn like ST.
 *
 * Native listeners + imperative value sync (never React-controlled) so a plain `.value =`
 * assignment followed by `dispatchEvent(new Event('input'))` — the exact pattern these scripts
 * use — behaves like it does on ST's real textarea. WCV cards run in a separate WebContents and
 * cannot reach this document; that transport is API-only (documented in compat-comparison.md).
 */
export function StDomCompat(): React.ReactElement {
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const area = areaRef.current
    if (!area) return

    // Mirror the store → element so scripts reading/appending see the real box content.
    area.value = useComposerStore.getState().text
    const unsub = useComposerStore.subscribe((s) => {
      if (area.value !== s.text) area.value = s.text
    })

    // Script wrote the element (+ dispatched 'input') → inject into the real box.
    const onInput = (): void => {
      if (area.value !== useComposerStore.getState().text) {
        useComposerStore.getState().injectInput(area.value)
      }
    }
    area.addEventListener('input', onInput)
    return () => {
      unsub()
      area.removeEventListener('input', onInput)
    }
  }, [])

  const submit = (): void => {
    if (!useChatStore.getState().isGenerating) useComposerStore.getState().requestSubmit()
  }

  return (
    <div style={{ display: 'none' }} aria-hidden="true">
      <textarea id="send_textarea" ref={areaRef} tabIndex={-1} />
      <button id="send_but" type="button" tabIndex={-1} onClick={submit} />
      <button id="send_butt" type="button" tabIndex={-1} onClick={submit} />
    </div>
  )
}
