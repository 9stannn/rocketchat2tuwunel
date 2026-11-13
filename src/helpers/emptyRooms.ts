import lineByLine from 'n-readlines'
import { Entity, entities } from '../Entities'
import { getAllMappingsByType, getMemberships } from './storage'

/**
 * Detection of the empty Rocket.Chat rooms, which are not created when
 * SKIP_EMPTY_ROOMS=true
 */

type ScannedMessage = {
  _id?: string
  rid?: string
  t?: string
  tmid?: string
  u?: { _id?: string }
}
type ScannedUser = { _id?: string; __rooms?: string[] }
type ScannedRoom = { _id: string; uids?: string[] }

let roomsWithMessages: Set<string> | undefined
let roomsWithMembers = new Set<string>()
let migratedUsers = new Set<string>()

/**
 * Read the users and messages exports once, after the users are migrated, to
 * know the rooms that have a migrated member, and those that have at least
 * one message to migrate, as the messages phase decides it: not a system
 * message, written by a migrated user, and for a thread reply, its thread
 * root is migrated too and comes before it
 */
export async function scanRoomActivity(): Promise<void> {
  migratedUsers = new Set(
    (await getAllMappingsByType(entities[Entity.Users].mappingType)).map(
      (mapping) => mapping.rcId
    )
  )
  // The users' rooms, including the admin's when it is a Rocket.Chat user
  // (its memberships are only recorded in E2EE mode)
  roomsWithMembers = new Set()
  const users = new lineByLine(`./inputs/${entities[Entity.Users].filename}`)
  let line: false | Buffer
  while ((line = users.next())) {
    const user: ScannedUser = JSON.parse(line.toString())
    if (user._id && migratedUsers.has(user._id)) {
      for (const rid of user.__rooms ?? []) roomsWithMembers.add(rid)
    }
  }

  roomsWithMessages = new Set()
  const migrated = new Set<string>()
  const messages = new lineByLine(
    `./inputs/${entities[Entity.Messages].filename}`
  )
  while ((line = messages.next())) {
    const message: ScannedMessage = JSON.parse(line.toString())
    if (
      message._id &&
      message.rid &&
      !message.t &&
      message.u?._id &&
      migratedUsers.has(message.u._id) &&
      (!message.tmid || migrated.has(message.tmid))
    ) {
      migrated.add(message._id)
      roomsWithMessages.add(message.rid)
    }
  }
}

/**
 * @param rcRoom A Rocket.Chat room
 * @returns Why the room is empty, or undefined if it is not
 */
export async function whyEmpty(
  rcRoom: ScannedRoom
): Promise<string | undefined> {
  if (!roomsWithMessages) {
    throw new Error('scanRoomActivity() must run before whyEmpty()')
  }
  if (!roomsWithMessages.has(rcRoom._id)) {
    return 'no message to migrate'
  }
  const members = [
    ...(await getMemberships(rcRoom._id)),
    ...(rcRoom.uids ?? []),
  ]
  if (
    !roomsWithMembers.has(rcRoom._id) &&
    !members.some((rcUserId) => migratedUsers.has(rcUserId))
  ) {
    return 'no migrated member'
  }
  return undefined
}
