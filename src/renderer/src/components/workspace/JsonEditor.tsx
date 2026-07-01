// React wrapper around vanilla-jsoneditor (ISC, https://github.com/josdejong/svelte-jsoneditor).
// Tree mode, debounced whole-doc onChange; external value changes are pushed via updateProps. Since
// vanilla-jsoneditor 0.22.0 a programmatic content update does NOT re-fire onChange (changelog #410), so
// no echo-guard is needed. Uses the public createJSONEditor API (no code copied). Themed via --jse-*→--rpt-*.
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

  // Push external value changes into the editor (the library's documented React pattern). Programmatic
  // updates don't re-fire onChange (vanilla-jsoneditor ≥0.22.0), so this can't echo back as an edit.
  React.useEffect(() => {
    editorRef.current?.updateProps({ content: { json: value } })
  }, [value])

  return <div ref={targetRef} className="rpt-json-editor" />
}
