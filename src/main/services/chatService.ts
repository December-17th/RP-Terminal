import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getAppDir, ensureDir, writeJsonSyncAtomic, readJsonSync, listDirectoriesSync } from './storageService'
import { ChatSession, FloorFile } from '../types/chat'
import { getCharacter } from './characterService'
import { saveFloor } from './floorService'

export const getChatsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'chats')

const getChatJsonPath = (profileId: string, chatId: string): string =>
  path.join(getChatsDir(profileId), chatId, 'chat.json')

const preview = (text: string, len = 80): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, len)

export const getChat = (profileId: string, chatId: string): ChatSession | null =>
  readJsonSync<ChatSession>(getChatJsonPath(profileId, chatId))

const saveChat = (profileId: string, chat: ChatSession): void => {
  writeJsonSyncAtomic(getChatJsonPath(profileId, chat.id), chat)
}

export const getChats = (profileId: string): ChatSession[] => {
  const chatsDir = getChatsDir(profileId)
  if (!fs.existsSync(chatsDir)) return []

  const sessions: ChatSession[] = []
  for (const id of listDirectoriesSync(chatsDir)) {
    const session = readJsonSync<ChatSession>(path.join(chatsDir, id, 'chat.json'))
    if (session) sessions.push(session)
  }
  return sessions.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )
}

export const createChat = (profileId: string, characterId: string): ChatSession => {
  const now = new Date().toISOString()
  const session: ChatSession = {
    id: uuidv4(),
    character_id: characterId,
    created_at: now,
    updated_at: now,
    floor_count: 0,
    floor_index: []
  }

  ensureDir(path.join(getChatsDir(profileId), session.id))
  saveChat(profileId, session)

  // Seed the opening greeting (first_mes) as floor 0 so resuming a fresh chat
  // shows the character's intro. It has no user message.
  const card = getCharacter(profileId, characterId)
  if (card?.data.first_mes) {
    const greeting: FloorFile = {
      floor: 0,
      chat_id: session.id,
      timestamp: now,
      user_message: { content: '', timestamp: now },
      response: { content: card.data.first_mes, model: '', provider: 'greeting' },
      events: [],
      variables: {}
    }
    appendFloor(profileId, session.id, greeting)
    return getChat(profileId, session.id) ?? session
  }

  return session
}

/**
 * Persist a floor file and update the owning chat's index in one place. This is
 * the only sanctioned way to add a floor — it keeps floor_count, floor_index
 * and updated_at consistent (no more clobbering chat.json with a partial).
 */
export const appendFloor = (profileId: string, chatId: string, floor: FloorFile): void => {
  saveFloor(profileId, chatId, floor)

  const chat = getChat(profileId, chatId)
  if (!chat) return

  chat.floor_index = chat.floor_index.filter((e) => e.floor !== floor.floor)
  chat.floor_index.push({
    floor: floor.floor,
    timestamp: floor.timestamp,
    user_preview: preview(floor.user_message.content),
    response_preview: preview(floor.response.content)
  })
  chat.floor_index.sort((a, b) => a.floor - b.floor)
  chat.floor_count = chat.floor_index.length
  chat.updated_at = new Date().toISOString()
  saveChat(profileId, chat)
}
