import React from 'react'
import { WidgetRegistry } from './WidgetRegistry'
import { useChatStore } from '../stores/chatStore'

interface LayoutRendererProps {
  layoutSchema: any[] // Array of widget definitions
}

const NO_VARS: Record<string, unknown> = {}

export const LayoutRenderer: React.FC<LayoutRendererProps> = ({ layoutSchema }) => {
  // Select just the latest floor's variables (stable reference between floor changes) so this
  // layout doesn't re-render on every chat-store fire — e.g. per-frame streaming flushes.
  const variables = useChatStore((s) =>
    s.floors.length > 0 ? s.floors[s.floors.length - 1].variables : NO_VARS
  )

  // Helper to extract nested values
  const getValue = (path: string): any => {
    return path
      .split('.')
      .reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), variables)
  }

  return (
    <div className="layout-renderer">
      {layoutSchema.map((widgetDef, idx) => {
        const WidgetComponent = WidgetRegistry[widgetDef.type]
        if (!WidgetComponent) {
          return (
            <div key={idx} style={{ color: 'red' }}>
              Unknown widget type: {widgetDef.type}
            </div>
          )
        }

        const value = getValue(widgetDef.path)

        return (
          <WidgetComponent
            key={idx}
            id={widgetDef.id || `widget-${idx}`}
            type={widgetDef.type}
            path={widgetDef.path}
            config={widgetDef.config || {}}
            value={value}
          />
        )
      })}
    </div>
  )
}
