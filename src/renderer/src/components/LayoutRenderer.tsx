import React from 'react';
import { WidgetRegistry } from './WidgetRegistry';
import { useChatStore } from '../stores/chatStore';

interface LayoutRendererProps {
  layoutSchema: any[]; // Array of widget definitions
}

export const LayoutRenderer: React.FC<LayoutRendererProps> = ({ layoutSchema }) => {
  const { floors } = useChatStore();
  
  // Get variables from the latest floor, or default to empty
  const variables = floors.length > 0 ? floors[floors.length - 1].variables : {};

  // Helper to extract nested values
  const getValue = (path: string) => {
    return path.split('.').reduce((obj, key) => (obj && obj[key] !== undefined) ? obj[key] : undefined, variables);
  };

  return (
    <div className="layout-renderer">
      {layoutSchema.map((widgetDef, idx) => {
        const WidgetComponent = WidgetRegistry[widgetDef.type];
        if (!WidgetComponent) {
          return <div key={idx} style={{ color: 'red' }}>Unknown widget type: {widgetDef.type}</div>;
        }

        const value = getValue(widgetDef.path);

        return (
          <WidgetComponent 
            key={idx}
            id={widgetDef.id || `widget-${idx}`}
            type={widgetDef.type}
            path={widgetDef.path}
            config={widgetDef.config || {}}
            value={value}
          />
        );
      })}
    </div>
  );
};
