// React wrapper around vanilla-jsoneditor (ISC, https://github.com/josdejong/svelte-jsoneditor).
// Tree mode, debounced whole-doc onChange, guarded external updates (mirrors JSR's Vue wrapper pattern;
// no code copied — this uses the public createJSONEditor API). Themed via --jse-*→--rpt-* in index.css.
import React from 'react'
import { createJSONEditor, Mode, type Content } from 'vanilla-jsoneditor'

const parseText = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined // invalid JSON mid-typing → don't persist
  }
}

export interface JsonEditorProps {
  value: unknown
  onChange?: (json: unknown) => void
  readOnly?: boolean
}

export const JsonEditor: React.FC<JsonEditorProps> = ({ value, onChange, readOnly }) => {
  const targetRef = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<ReturnType<typeof createJSONEditor> | null>(null)
  const applyingExternal = React.useRef(false)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Create the editor once for this component instance.
  React.useEffect(() => {
    if (!targetRef.current) return
    const editor = createJSONEditor({
      target: targetRef.current,
      props: {
        content: { json: value },
        mode: Mode.tree,
        readOnly: !!readOnly,
        onChange: (updated: Content) => {
          if (applyingExternal.current) return
          const json = 'json' in updated ? updated.json : parseText((updated as { text?: string }).text)
          if (json === undefined) return
          if (debounceRef.current) clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => onChangeRef.current?.(json), 300)
        }
      }
    })
    editorRef.current = editor
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      editorRef.current = null
      void editor.destroy()
    }
    // Create-once: external value changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push external value changes into the editor, guarded so the resulting onChange doesn't echo back.
  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    applyingExternal.current = true
    void editor.update({ json: value })
    const id = setTimeout(() => {
      applyingExternal.current = false
    }, 0)
    return () => clearTimeout(id)
  }, [value])

  return <div ref={targetRef} className="rpt-json-editor" />
}
