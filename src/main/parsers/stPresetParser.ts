import fs from 'fs';
import path from 'path';

/**
 * Parses SillyTavern JSON files (Lorebooks, Presets) and extracts prompts/variables.
 * For MVP, we're just extracting World Info / Lorebook keywords and content.
 */
export const parseStPreset = (filePath: string): any | null => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // If it's a lorebook/world info file:
    if (data.entries || data.entries?.length > 0) {
      // It's a ST Lorebook (World Info)
      return {
        type: 'lorebook',
        name: path.basename(filePath, '.json'),
        entries: Object.values(data.entries).map((entry: any) => ({
          keys: entry.key || [],
          content: entry.content || '',
          enabled: entry.enabled !== false,
          priority: entry.insertion_order || 0
        }))
      };
    }

    // If it's an advanced character preset (like the world background engine)
    if (data.prompts) {
      return {
        type: 'preset',
        name: data.name || path.basename(filePath, '.json'),
        prompts: data.prompts.map((p: any) => ({
          name: p.name,
          role: p.role || 'system',
          content: p.content,
          enabled: p.enabled !== false
        }))
      };
    }

    // Fallback: Return raw parsed data
    return data;
  } catch (error) {
    console.error('Failed to parse ST Preset:', error);
    return null;
  }
};
