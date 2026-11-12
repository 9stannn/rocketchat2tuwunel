import { AxiosError } from 'axios'
import lineByLine from 'n-readlines'
import { Entity, entities } from '../Entities'
import log from '../helpers/logger'
import {
  getAllMappingsByType,
  getMappingByMatrixId,
  getRoomId,
  getUserId,
  getUserMappingByName,
} from '../helpers/storage'
import {
  axios,
  formatUserSessionOptions,
  getMatrixMembers,
} from '../helpers/tuwunel'
import { RcRoom, RcRoomTypes } from './rooms'

export type DirectChats = { [key: string]: string[] }
export type UserDirectChatMappings = {
  [key: string]: { [key: string]: string[] }
}

/**
 * @param room A Rocket.Chat direct chat
 * @returns The Matrix IDs of its migrated Rocket.Chat participants
 */
async function getParticipants(room: RcRoom): Promise<string[]> {
  const matrixIds = room.uids?.length
    ? await Promise.all([...new Set(room.uids)].map((uid) => getUserId(uid)))
    : await Promise.all(
        [...new Set(room.usernames ?? [])].map(
          async (username) => (await getUserMappingByName(username))?.matrixId
        )
      )
  return matrixIds.filter((matrixId): matrixId is string => !!matrixId)
}

/**
 * Reads the input file for rooms, gets the mappings and members of each direct chat and returns this collection
 * @returns The DirectChats collection with Matrix IDs of rooms and users
 */
export async function getDirectChats(): Promise<DirectChats> {
  const rl = new lineByLine(`./inputs/${entities.rooms.filename}`)

  let line: false | Buffer
  const directChats: DirectChats = {}
  while ((line = rl.next())) {
    const room: RcRoom = JSON.parse(line.toString())

    if (room.t === RcRoomTypes.direct) {
      const matrixRoomId = await getRoomId(room._id)

      if (!matrixRoomId) {
        log.warn(
          `Room ${room._id} has no mapping, skipping to mark it as a direct chat.`
        )
        continue
      }
      // Only its Rocket.Chat participants: the admin is also a member of the
      // direct chats they had to create (creator not migrated), and users
      // who were added to post a message are removed later.
      const participants = await getParticipants(room)
      const members = (await getMatrixMembers(matrixRoomId)).filter((member) =>
        participants.includes(member)
      )

      if ((room.usernames?.length ?? 0) > 1 && members.length < 2) {
        log.warn(
          `Direct chat ${room._id} lost one or more members during migration, skipping.`
        )
        continue
      }

      directChats[matrixRoomId] = members
    }
  }
  return directChats
}

/**
 * Parses direct chats and returns a mapping of users and their direct chat connections
 * @param directChats The object containing direct chats and their members
 * @returns An object containing users and their direct chat connections, as needed for setting their m.direct settings
 */
export function parseDirectChats(
  directChats: DirectChats
): UserDirectChatMappings {
  const result: UserDirectChatMappings = {}

  // Iterate over all direct chats
  for (const chat in directChats) {
    const users = directChats[chat]

    // Iterate over all users in the current chat
    for (const user of users) {
      // If the user is not already in the result, add them
      if (!result[user]) {
        result[user] = {}
      }
      // If only one user in chat (self chatting), add him
      if (users.length == 1) {
        result[user][user] = []
        if (!result[user][user].includes(chat)) {
          result[user][user].push(chat)
        }
      } else {
        // Iterate over all other users in the same chat
        for (const otherUser of users) {
          // Skip the current user
          if (otherUser !== user) {
            // If the other user is not already in the result, add them
            if (!result[user][otherUser]) {
              result[user][otherUser] = []
            }
            // Add the current chat to the list of direct chats between the users
            if (!result[user][otherUser].includes(chat)) {
              result[user][otherUser].push(chat)
            }
          }
        }
      }
    }
  }
  return result
}

/**
 * @param directChats A m.direct setting
 * @returns true if every room it lists was created by this migration
 */
async function onlyListsMigratedRooms(directChats: object): Promise<boolean> {
  for (const roomIds of Object.values(directChats)) {
    if (!Array.isArray(roomIds)) return false
    for (const roomId of roomIds) {
      const mapping = await getMappingByMatrixId(roomId)
      if (mapping?.type !== entities[Entity.Rooms].mappingType) return false
    }
  }
  return true
}

/**
 * Sets the m.direct settings for users.
 * An existing setting that differs is replaced only if it lists nothing but
 * migrated rooms, i.e. it was written by an earlier, interrupted run of the
 * migration; otherwise it is kept and the difference is logged.
 * @param userDirectChatMappings An object containing users and their direct chat connections, to be set in tuwunel
 */
export async function setDirectChats(
  userDirectChatMappings: UserDirectChatMappings
) {
  log.info(
    `Setting direct chat settings for ${
      Object.keys(userDirectChatMappings).length
    } users`
  )

  // Iterate over all users
  for (const [user, chats] of Object.entries(userDirectChatMappings)) {
    const accessToken = (await getMappingByMatrixId(user))?.accessToken
    if (!accessToken) {
      log.warn(
        `User ${user} has no access token, skipping their direct chat settings.`
      )
      continue
    }
    const userSessionOptions = formatUserSessionOptions(accessToken)

    // Check if direct chats are already set
    let currentDirectChats: object | undefined
    try {
      currentDirectChats = (
        await axios.get(
          `/_matrix/client/v3/user/${user}/account_data/m.direct`,
          userSessionOptions
        )
      ).data
    } catch (error) {
      // Catch errors if setting does not exist, yet
      if (
        !(
          error instanceof AxiosError &&
          error.response &&
          error.response.data.errcode === 'M_NOT_FOUND'
        )
      ) {
        throw error
      }
    }
    const settingExists =
      !!currentDirectChats && Object.keys(currentDirectChats).length > 0

    if (!settingExists) {
      if (Object.keys(chats).length === 0) continue
      // Set direct chats if there are non set, yet
      await axios.put(
        `/_matrix/client/v3/user/${user}/account_data/m.direct`,
        chats,
        userSessionOptions
      )
      log.debug(
        `Set ${
          Object.keys(chats).length
        } chats as direct chats for user ${user}`
      )
    } else if (JSON.stringify(currentDirectChats) === JSON.stringify(chats)) {
      // If chats are already set, but equal, log it
      log.debug(
        `User ${user} already has the expected direct chats configured, skipping.`
      )
    } else if (await onlyListsMigratedRooms(currentDirectChats!)) {
      await axios.put(
        `/_matrix/client/v3/user/${user}/account_data/m.direct`,
        chats,
        userSessionOptions
      )
      log.info(
        `Direct chat setting of ${user}, written by an earlier run, corrected`
      )
    } else {
      // If chats are already set, but different, log the difference
      log.debug(`User ${user} already has a different direct chat setting.`)
      log.debug('Expected:', chats)
      log.debug('Actual:', currentDirectChats)
    }
  }
}

/**
 * Handle direct chat settings for all users, marking direct chats as such in the user's personal settings
 */
export async function handleDirectChats() {
  const directChats = await getDirectChats()
  const userDirectChatMappings = parseDirectChats(directChats)
  // Users who have no direct chat (left): an interrupted run may have given
  // them a wrong setting, to be cleared
  for (const mapping of await getAllMappingsByType(
    entities[Entity.Users].mappingType
  )) {
    if (mapping.matrixId && !userDirectChatMappings[mapping.matrixId]) {
      userDirectChatMappings[mapping.matrixId] = {}
    }
  }
  await setDirectChats(userDirectChatMappings)
}
