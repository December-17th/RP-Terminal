import path from 'path';
import { getChatsDir } from './chatService';
import { readJsonSync, writeJsonSyncAtomic } from './storageService';
import { FloorFile } from '../types/chat';

const getFloorFileName = (floorIndex: number) => `floor-${String(floorIndex).padStart(3, '0')}.json`;

export const getFloorPath = (profileId: string, chatId: string, floorIndex: number) => {
  return path.join(getChatsDir(profileId), chatId, getFloorFileName(floorIndex));
};

export const getFloor = (profileId: string, chatId: string, floorIndex: number): FloorFile | null => {
  return readJsonSync<FloorFile>(getFloorPath(profileId, chatId, floorIndex));
};

export const saveFloor = (profileId: string, chatId: string, floor: FloorFile) => {
  writeJsonSyncAtomic(getFloorPath(profileId, chatId, floor.floor), floor);
};

export const deleteFloorAndSubsequent = (profileId: string, chatId: string, fromFloorIndex: number) => {
  const fs = require('fs');
  const chatDir = path.join(getChatsDir(profileId), chatId);
  if (!fs.existsSync(chatDir)) return;
  
  const files = fs.readdirSync(chatDir);
  for (const file of files) {
    if (file.startsWith('floor-') && file.endsWith('.json')) {
      const idx = parseInt(file.replace('floor-', '').replace('.json', ''), 10);
      if (idx >= fromFloorIndex) {
        fs.unlinkSync(path.join(chatDir, file));
      }
    }
  }
};
