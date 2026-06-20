import path from 'path';
import { getAppDir, ensureDir, writeJsonSyncAtomic, readJsonSync, listDirectoriesSync } from './storageService';
import { RPTerminalCard } from '../types/character';

export const getCharactersDir = (profileId: string) => path.join(getAppDir(), 'profiles', profileId, 'characters');

export const getCharacters = (profileId: string): Array<{ id: string, card: RPTerminalCard }> => {
  const charsDir = getCharactersDir(profileId);
  if (!require('fs').existsSync(charsDir)) return [];
  
  const charIds = listDirectoriesSync(charsDir);
  const characters: Array<{ id: string, card: RPTerminalCard }> = [];
  
  for (const id of charIds) {
    const cardPath = path.join(charsDir, id, 'card.json');
    const card = readJsonSync<RPTerminalCard>(cardPath);
    if (card) {
      characters.push({ id, card });
    }
  }
  
  return characters;
};

export const getCharacter = (profileId: string, characterId: string): RPTerminalCard | null => {
  const cardPath = path.join(getCharactersDir(profileId), characterId, 'card.json');
  return readJsonSync<RPTerminalCard>(cardPath);
};

export const saveCharacter = (profileId: string, characterId: string, card: RPTerminalCard) => {
  const charDir = path.join(getCharactersDir(profileId), characterId);
  ensureDir(charDir);
  writeJsonSyncAtomic(path.join(charDir, 'card.json'), card);
};

export const importCharacterFromFile = (profileId: string, filePath: string): string | null => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    let stData: any = null;

    if (ext === '.png') {
      const { parseStPng } = require('../parsers/stPngParser');
      stData = parseStPng(filePath);
    } else if (ext === '.json') {
      const fs = require('fs');
      stData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    if (!stData) return null;

    // Convert ST card format to RPTerminalCard format if necessary
    const isV2 = stData.spec === 'chara_card_v2' || stData.spec === 'chara_card_v3';
    const cardData = isV2 ? stData.data : stData;

    const rptCard: RPTerminalCard = {
      spec: 'rpterminal',
      spec_version: '1.0',
      data: {
        name: cardData.name || 'Unknown',
        description: cardData.description || '',
        personality: cardData.personality || '',
        scenario: cardData.scenario || '',
        first_mes: cardData.first_mes || '',
        mes_example: cardData.mes_example || '',
        creator_notes: cardData.creator_notes || '',
        system_prompt: cardData.system_prompt || '',
        post_history_instructions: cardData.post_history_instructions || '',
        tags: cardData.tags || [],
        creator: cardData.creator || '',
        character_version: cardData.character_version || ''
      }
    };

    const newId = crypto.randomUUID();
    saveCharacter(profileId, newId, rptCard);
    
    // Copy avatar if it's a PNG
    if (ext === '.png') {
      const fs = require('fs');
      const charDir = path.join(getCharactersDir(profileId), newId);
      fs.copyFileSync(filePath, path.join(charDir, 'avatar.png'));
    }

    return newId;
  } catch (error) {
    console.error('Failed to import character:', error);
    return null;
  }
};
