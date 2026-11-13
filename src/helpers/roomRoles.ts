import lineByLine from 'n-readlines'
import { existsSync } from 'node:fs'
import log from './logger'

/**
 * Owners, moderators and favorites of the Rocket.Chat rooms, from the
 * optional export of the rocketchat_subscription collection
 */

export const SUBSCRIPTIONS_FILE = 'rocketchat_subscription.json'

/**
 * A Rocket.Chat subscription: the membership of a user in a room
 */
export type RcSubscription = {
  rid?: string
  u?: { _id?: string; username?: string }
  roles?: string[]
  f?: boolean // the room is a favorite of the user
}

/**
 * Rocket.Chat user IDs, sorted by username
 */
export type RoomRoles = { owners: string[]; moderators: string[] }

let roomRoles: Map<string, RoomRoles> | undefined
let favorites: Array<{ rcRoomId: string; rcUserId: string }> = []

/**
 * Load the room roles from the subscriptions export, if there is one
 * @param path The export, by default inputs/rocketchat_subscription.json
 * @returns Whether the roles were loaded
 */
export function loadRoomRoles(
  path = `./inputs/${SUBSCRIPTIONS_FILE}`
): boolean {
  favorites = []
  if (!existsSync(path)) {
    roomRoles = undefined
    return false
  }
  const found = new Map<
    string,
    { owners: Map<string, string>; moderators: Map<string, string> }
  >()
  const rl = new lineByLine(path)
  let line: false | Buffer
  while ((line = rl.next())) {
    const subscription: RcSubscription = JSON.parse(line.toString())
    const rid = subscription.rid
    const userId = subscription.u?._id
    if (!rid || !userId) continue
    if (subscription.f === true)
      favorites.push({ rcRoomId: rid, rcUserId: userId })
    if (!Array.isArray(subscription.roles)) continue
    if (!found.has(rid)) {
      found.set(rid, { owners: new Map(), moderators: new Map() })
    }
    const room = found.get(rid)!
    const username = subscription.u?.username || userId
    if (subscription.roles.includes('owner')) room.owners.set(userId, username)
    if (subscription.roles.includes('moderator')) {
      room.moderators.set(userId, username)
    }
  }
  const byUsername = (users: Map<string, string>) =>
    [...users.entries()]
      .sort(([, a], [, b]) => a.localeCompare(b))
      .map(([userId]) => userId)
  roomRoles = new Map()
  for (const [rid, { owners, moderators }] of found) {
    roomRoles.set(rid, {
      owners: byUsername(owners),
      moderators: byUsername(moderators),
    })
  }
  log.info(
    `Room owners and moderators loaded for ${roomRoles.size} rooms, and ${favorites.length} favorites, from ${path}`
  )
  return true
}

/**
 * @returns The rooms the users marked as favorites, by Rocket.Chat IDs
 */
export function getFavorites(): Array<{ rcRoomId: string; rcUserId: string }> {
  return favorites
}

/**
 * @returns Whether the room roles are known (the subscriptions were exported)
 */
export function roomRolesLoaded(): boolean {
  return roomRoles !== undefined
}

/**
 * @param rcRoomId The Rocket.Chat room ID
 * @returns The Rocket.Chat IDs of its owners and moderators
 */
export function getRoomRoles(rcRoomId: string): RoomRoles {
  return roomRoles?.get(rcRoomId) ?? { owners: [], moderators: [] }
}

/**
 * Rocket.Chat IDs of the direct chats, as seen while parsing the rooms
 */
const directChatIds = new Set<string>()

/**
 * @param rcRoomId The Rocket.Chat ID of a direct chat
 */
export function rememberDirectChat(rcRoomId: string): void {
  directChatIds.add(rcRoomId)
}

/**
 * @param rcRoomId A Rocket.Chat room ID
 * @returns Whether it is a direct chat
 */
export function isDirectChat(rcRoomId: string): boolean {
  return directChatIds.has(rcRoomId)
}
