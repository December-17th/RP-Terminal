import fs from 'fs'
import path from 'path'
import { getChatsDir } from './chatService'
import { readJsonSync, writeJsonSyncAtomic } from './storageService'
import { FloorFile } from '../types/chat'

const getFloorFileName = (floorIndex: number): string =>
  `floor-${String(floorIndex).padStart(3, '0')}.json`

export const getFloorPath = (profileId: string, chatId: string, floorIndex: number): string =>
  path.join(getChatsDir(profileId), chatId, getFloorFileName(floorIndex))

export const getFloor = (
  profileId: string,
  chatId: string,
  floorIndex: number
): FloorFile | null => readJsonSync<FloorFile>(getFloorPath(profileId, chatId, floorIndex))

export const saveFloor = (profileId: string, chatId: string, floor: FloorFile): void => {
  writeJsonSyncAtomic(getFloorPath(profileId, chatId, floor.floor), floor)
}

/** Load every floor 0..count-1 in order, skipping any that fail to read. */
export const getAllFloors = (profileId: string, chatId: string, count: number): FloorFile[] => {
  const floors: FloorFile[] = []
  for (let i = 0; i < count; i++) {
    const f = getFloor(profileId, chatId, i)
    if (f) floors.push(f)
  }
  return floors
}

export const deleteFloorAndSubsequent = (
  profileId: string,
  chatId: string,
  fromFloorIndex: number
): void => {
  const chatDir = path.join(getChatsDir(profileId), chatId)
  if (!fs.existsSync(chatDir)) return

  for (const file of fs.readdirSync(chatDir)) {
    if (file.startsWith('floor-') && file.endsWith('.json')) {
      const idx = parseInt(file.replace('floor-', '').replace('.json', ''), 10)
      if (idx >= fromFloorIndex) fs.unlinkSync(path.join(chatDir, file))
    }
  }
}
