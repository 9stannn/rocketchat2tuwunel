import { AxiosError } from 'axios'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { Entity, entities } from '../Entities'
import { isE2EE } from '../e2ee/config'
import { IdMapping } from '../entity/IdMapping'
import { whyEmpty } from '../helpers/emptyRooms'
import log from '../helpers/logger'
import {
  getRoomRoles,
  rememberDirectChat,
  roomRolesLoaded,
} from '../helpers/roomRoles'
import { shouldSkipEmptyRooms } from '../helpers/settings'
import {
  createMembership,
  getMapping,
  getMappingByMatrixId,
  getMemberships,
  getRoomId,
  getUserId,
  save,
} from '../helpers/storage'
import {
  SessionOptions,
  axios,
  formatUserSessionOptions,
  getUserSessionOptions,
} from '../helpers/tuwunel'
import { RcUser } from './users'

/**
 * Types of Rocket.Chat rooms
 */
export const enum RcRoomTypes {
  direct = 'd',
  chat = 'c',
  private = 'p',
  live = 'l',
}

/**
 * Type of Rocket.Chat rooms
 */
export type RcRoom = {
  _id: string
  t: RcRoomTypes
  usersCount?: number
  lastMessage?: { [key: string]: { [key: string]: string } }
  uids?: string[]
  usernames?: string[]
  name?: string
  u?: RcUser
  topic?: string
  fname?: string
  description?: string
  teamId?: string // the team the room belongs to
  teamMain?: boolean // the main room of the team
  teamDefault?: boolean // joined automatically by new team members
}

/**
 * Presets of Matrix room permission settings
 */
export const enum MatrixRoomPresets {
  private = 'private_chat',
  public = 'public_chat',
  trusted = 'trusted_private_chat',
}

/**
 * Presets of Matrix room visibility settings
 */
export const enum MatrixRoomVisibility {
  private = 'private',
  public = 'public',
}

/**
 * Type of Matrix rooms
 */
export type MatrixRoom = {
  room_id?: string
  name?: string
  creation_content?: object
  room_alias_name?: string
  topic?: string
  is_direct?: boolean
  preset?: MatrixRoomPresets
  visibility?: MatrixRoomVisibility
  initial_state?: Array<{
    type: string
    state_key: string
    content: Record<string, unknown>
  }>
}

/**
 * Translate a Rocket.Chat room to a Matrix room
 * @param rcRoom The Rocket.Chat room to convert
 * @returns The Matrix room event body
 */
export function mapRoom(rcRoom: RcRoom): MatrixRoom {
  const room: MatrixRoom = {
    creation_content: {
      'm.federate': false,
    },
  }

  if (rcRoom.fname || rcRoom.name) {
    room.name = rcRoom.fname || rcRoom.name
    if (rcRoom.name) {
      room.room_alias_name = rcRoom.name
    }
  }

  if (rcRoom.description) {
    room.topic = rcRoom.description
  }

  switch (rcRoom.t) {
    case RcRoomTypes.direct:
      if (rcRoom.usersCount == 1 && rcRoom.lastMessage) {
        room.name = rcRoom.lastMessage.u.name
      }
      room.is_direct = true
      room.preset = MatrixRoomPresets.trusted
      break

    case RcRoomTypes.chat:
      room.preset = MatrixRoomPresets.public
      room.visibility = MatrixRoomVisibility.public
      break

    case RcRoomTypes.private:
      room.preset = MatrixRoomPresets.private
      room.visibility = MatrixRoomVisibility.private
      break

    case RcRoomTypes.live: {
      const messageLivechat = `Room ${
        rcRoom.name || 'with ID: ' + rcRoom._id
      } is a live chat. Migration not implemented`
      log.warn(messageLivechat)
      throw new Error(messageLivechat)
    }

    default: {
      const messageUnknownRoom = `Room ${
        rcRoom.name || 'with ID: ' + rcRoom._id
      } is of type ${rcRoom.t}, which is unknown or unimplemented`
      log.error(messageUnknownRoom)
      throw new Error(messageUnknownRoom)
    }
  }

  if (isE2EE()) {
    // The room is encrypted from its first event: no message of the
    // migrated history can be sent unencrypted.
    room.initial_state = [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ]
  }
  return room
}

/**
 * Return the ID of the room creator, depending on room type
 * @param rcRoom The Rocket.Chat room object
 * @returns The Rocket.Chat ID of the creator or empty string
 */
export function getCreator(rcRoom: RcRoom): string {
  if (rcRoom.u && rcRoom.u._id) {
    return rcRoom.u._id
  } else if (rcRoom.uids && rcRoom.uids.length >= 1) {
    return rcRoom.uids[0]
  } else {
    log.warn(
      `Creator ID could not be determined for room ${rcRoom.name} of type ${rcRoom.t}. This is normal for the default room. Using admin user.`
    )
    return ''
  }
}

/**
 * Choose the Rocket.Chat user who creates the Matrix room. With room versions
 * 12 and later, the creator keeps unlimited power over the room, so it is
 * one of the room's Rocket.Chat owners when they are known: its Rocket.Chat
 * creator if they are still an owner, else the first owner by username.
 * @param rcRoom The Rocket.Chat room
 * @returns The Rocket.Chat ID of the creator, or an empty string for the admin
 */
export async function chooseCreator(rcRoom: RcRoom): Promise<string> {
  if (rcRoom.t !== RcRoomTypes.direct && roomRolesLoaded()) {
    const { owners } = getRoomRoles(rcRoom._id)
    if (owners.length > 0) {
      const creatorId = rcRoom.u?._id
      const candidates =
        creatorId && owners.includes(creatorId)
          ? [creatorId, ...owners.filter((owner) => owner !== creatorId)]
          : owners
      for (const owner of candidates) {
        if (await getUserId(owner)) return owner
      }
      log.warn(
        `No owner of room ${rcRoom.name || rcRoom._id} was migrated, the admin creates it.`
      )
      return ''
    }
  }
  return getCreator(rcRoom)
}

/**
 * Give the migrated Rocket.Chat owners of a room the power level 100 and its
 * moderators 50, as the room creator, before anyone is invited
 * @param rcRoom The Rocket.Chat room
 * @param roomId The Matrix room ID
 * @param creatorUserId The Matrix ID of the room creator, who keeps their power
 * @param creatorSessionOptions The credentials of the room creator
 */
export async function applyRoomRoles(
  rcRoom: RcRoom,
  roomId: string,
  creatorUserId: string,
  creatorSessionOptions: SessionOptions | object
): Promise<void> {
  if (rcRoom.t === RcRoomTypes.direct || !roomRolesLoaded()) return
  const { owners, moderators } = getRoomRoles(rcRoom._id)
  const levels = new Map<string, number>()
  for (const [rcUserIds, level] of [
    [moderators, 50],
    [owners, 100],
  ] as const) {
    for (const rcUserId of rcUserIds) {
      const userId = await getUserId(rcUserId)
      // Room versions >= 12 refuse the creator in the power levels
      if (userId && userId !== creatorUserId) levels.set(userId, level)
    }
  }
  if (levels.size === 0) return

  const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`
  const powerLevels = (await axios.get(path, creatorSessionOptions)).data
  const users: Record<string, number> = { ...(powerLevels.users ?? {}) }
  let changed = false
  for (const [userId, level] of levels) {
    if ((users[userId] ?? powerLevels.users_default ?? 0) < level) {
      users[userId] = level
      changed = true
    }
  }
  // Set already, e.g. by an earlier run
  if (!changed) return
  await axios.put(path, { ...powerLevels, users }, creatorSessionOptions)
  log.info(
    `Power levels of the owners and moderators of room ${rcRoom.name || rcRoom._id}:`,
    Object.fromEntries(levels)
  )
}

/**
 * Wrapper function for membership creations for direct chats
 * @param rcRoom The Rocket.Chat room object
 */
export async function createDirectChatMemberships(
  rcRoom: RcRoom
): Promise<void> {
  if (rcRoom.t == RcRoomTypes.direct && rcRoom.uids) {
    await Promise.all(
      [...new Set(rcRoom.uids)] // Deduplicate users
        .map(async (uid) => {
          await createMembership(rcRoom._id, uid)
          log.debug(`${uid} membership in direct chat ${rcRoom._id} created`)
        })
    )
  }
}

/**
 * Get user credentials for Axios
 * @param creatorId The Rocket.Chat ID of the room creator
 * @returns A SessionOptions or empty object
 * @deprecated This has a high similarity with other functions, it might be replaced
 */
export async function getCreatorSessionOptions(
  creatorId: string
): Promise<SessionOptions | object> {
  if (creatorId) {
    try {
      const creatorSessionOptions = await getUserSessionOptions(creatorId)
      log.debug(
        `Room owner session generated for Rocket.Chat user ${creatorId}`
      )
      return creatorSessionOptions
    } catch (error) {
      log.warn(error)
    }
  }
  return {}
}

/**
 * Send a request to Tuwunel, creating the room
 * @param matrixRoom The Matrix room object to create
 * @param creatorSessionOptions The credentials of the room creator
 * @returns The Matrix room ID
 */
export async function registerRoom(
  matrixRoom: MatrixRoom,
  creatorSessionOptions: SessionOptions | object
): Promise<string> {
  return (
    await axios.post(
      '/_matrix/client/v3/createRoom',
      matrixRoom,
      creatorSessionOptions
    )
  ).data.room_id
}

/**
 * Send events to Tuwunel, inviting users to a room. Already participating users will not cause problems.
 * @param inviteeId The Matrix ID of the invited user
 * @param roomId The Matrix ID of the room
 * @param creatorSessionOptions The credentials of the room creator
 */
export async function inviteMember(
  inviteeId: string,
  roomId: string,
  creatorSessionOptions: SessionOptions | object
): Promise<void> {
  log.http(`Invite member ${inviteeId}`)
  try {
    await axios.post(
      `/_matrix/client/v3/rooms/${roomId}/invite`,
      { user_id: inviteeId },
      creatorSessionOptions
    )
  } catch (error) {
    if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      (error.response.data.error === `${inviteeId} is already in the room.` ||
        // Tuwunel's wording
        error.response.data.error?.includes(
          'cannot invite user that is joined'
        ))
    ) {
      log.debug(
        `User ${inviteeId} is already in room ${roomId}, probably because this user created the room as a fallback.`
      )
    } else if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      error.response.data.error.includes(`not in room ${roomId}.`)
    ) {
      log.warn(
        `Creator is not in room ${roomId}, skipping invitation for ${inviteeId}.`
      )
    } else {
      throw error
    }
  }
}

/**
 * Send events to Tuwunel, accepting an invitation to a room
 * @param inviteeMapping The IDMapping of the invited user
 * @param roomId The Matrix ID of the room
 */
export async function acceptInvitation(
  inviteeMapping: IdMapping,
  roomId: string
): Promise<void> {
  log.http(
    `Accepting invitation for member ${inviteeMapping.rcId} aka. ${inviteeMapping.matrixId}`
  )
  await axios.post(
    `/_matrix/client/v3/join/${roomId}`,
    {},
    formatUserSessionOptions(inviteeMapping.accessToken || '')
  )
}

/**
 * Filter out the room creator and non-existent users.
 * Users are non-existent, if they have no mapping, like when they are
 * excluded or have been deleted.
 * @param rcMemberIds An array of Rocket.Chat user IDs
 * @param creatorId The Rocket.Chat user ID of the room creator
 * @returns A filtered array of IdMappings
 */
export async function getFilteredMembers(
  rcMemberIds: string[],
  creatorId: string
): Promise<IdMapping[]> {
  const memberMappings = (
    await Promise.all(
      rcMemberIds
        .filter((rcMemberId) => rcMemberId != creatorId)
        .map(async (rcMemberId) => await getMapping(rcMemberId, 0))
    )
  ).filter((memberMapping): memberMapping is IdMapping => memberMapping != null)
  return memberMappings
}

/**
 * Save an ID mapping in the local database
 * @param rcId Rocket.Chat room ID
 * @param matrixId Matrix room ID
 */
export async function createMapping(
  rcId: string,
  matrixId: string
): Promise<void> {
  const roomMapping = new IdMapping()
  roomMapping.rcId = rcId
  roomMapping.matrixId = matrixId
  roomMapping.type = entities[Entity.Rooms].mappingType

  await save(roomMapping)
  log.debug('Mapping added:', roomMapping)
}

/**
 * E2EE mode: make sure Tuwunel really created the room encrypted. A server
 * with `allow_encryption = false` silently drops m.room.encryption.
 * @param roomId The Matrix room ID
 * @param sessionOptions The credentials of a member of the room
 */
export async function assertRoomEncrypted(
  roomId: string,
  sessionOptions: SessionOptions | object
): Promise<void> {
  let algorithm: string | undefined
  try {
    algorithm = (
      await axios.get(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        sessionOptions
      )
    ).data?.algorithm
  } catch (error) {
    if (!(error instanceof AxiosError && error.response?.status === 404)) {
      throw error
    }
  }
  if (algorithm !== 'm.megolm.v1.aes-sha2') {
    throw new Error(
      `Room ${roomId} was created unencrypted: check that allow_encryption is not disabled in tuwunel.toml`
    )
  }
}

/**
 * Create a Matrix room from a Rocket.Chat room object and handle it's memberships
 * @param rcRoom The Rocket.Chat room object
 * @returns The Matrix room object, including it's ID
 */
export async function createRoom(rcRoom: RcRoom): Promise<MatrixRoom> {
  const room: MatrixRoom = mapRoom(rcRoom)
  const creatorId = await chooseCreator(rcRoom)
  await createDirectChatMemberships(rcRoom)
  const creatorSessionOptions = await getCreatorSessionOptions(creatorId)
  log.debug('Creating room:', room)

  room.room_id = await registerRoom(room, creatorSessionOptions)
  if (isE2EE()) {
    await assertRoomEncrypted(room.room_id, creatorSessionOptions)
  }
  const creatorUserId =
    Object.keys(creatorSessionOptions).length > 0
      ? (await getUserId(creatorId)) || adminAccessToken.user_id
      : adminAccessToken.user_id
  await applyRoomRoles(
    rcRoom,
    room.room_id,
    creatorUserId,
    creatorSessionOptions
  )

  await handleMemberships(rcRoom._id, room, creatorId, creatorSessionOptions)

  return room
}

/**
 * Create memberships for a room
 * @param rcRoomId The Rocket.Chat room ID
 * @param room The Matrix room object
 * @param creatorId The Rocket.Chat room creator ID
 * @param creatorSessionOptions The credentials of the room creator
 */
async function handleMemberships(
  rcRoomId: string,
  room: MatrixRoom,
  creatorId: string,
  creatorSessionOptions: object | SessionOptions
) {
  const rcMemberIds = await getMemberships(rcRoomId)
  const memberMappings = await getFilteredMembers(rcMemberIds, creatorId)
  log.info(
    `Inviting members to room ${
      room.room_alias_name || room.name || room.room_id
    }:`,
    memberMappings.map((mapping) => mapping.matrixId)
  )
  log.debug(
    'Excluded members:',
    rcMemberIds.filter(
      (x) => !memberMappings.map((mapping) => mapping.rcId).includes(x)
    )
  )

  await Promise.all(
    memberMappings.map(async (memberMapping) => {
      await addMember(memberMapping, room.room_id || '', creatorSessionOptions)
    })
  )
}

/**
 * Wrapper function to invite users to a room and make them join
 * @param memberMapping The IdMapping of the user to join
 * @param matrixRoomId The Matrix room ID
 * @param creatorSessionOptions The credentials of the inviting user
 */
export async function addMember(
  memberMapping: IdMapping,
  matrixRoomId: string,
  creatorSessionOptions: object | SessionOptions
) {
  await inviteMember(
    memberMapping.matrixId || '',
    matrixRoomId,
    creatorSessionOptions
  )
  await acceptInvitation(memberMapping, matrixRoomId)
}

/**
 * Execute the wrapped function, handling errors of members missing in rooms by adding them and repeating the function.
 * @param fn The function to execute, preferably wrapped
 * @returns void
 * @throws Other errors than "User not in room"
 * @example executeAndHandleMissingMember(() => myFunc('parameter1', 'parameter2'))
 */
export async function executeAndHandleMissingMember(
  fn: () => Promise<void>,
  hint?: { matrixUserId: string; matrixRoomId: string }
): Promise<void> {
  const regEx: RegExp =
    /^User (?<matrixUserId>@.+) not in room (?<matrixRoomId>!.+)$/
  // Tuwunel's wording, which does not name the user nor the room
  const authCheckRegEx: RegExp = /sender's membership `[a-z]+` is not `join`/
  try {
    await fn()
  } catch (error) {
    const message: string | undefined =
      error instanceof AxiosError ? error.response?.data?.error : undefined
    const ids =
      message?.match(regEx)?.groups ||
      (hint && message && authCheckRegEx.test(message) ? hint : undefined)
    if (
      error instanceof AxiosError &&
      error.response &&
      error.response.data.errcode === 'M_FORBIDDEN' &&
      ids
    ) {
      log.info(`${error.response.data.error}, adding.`)

      const { matrixUserId, matrixRoomId } = ids

      const userMapping = await getMappingByMatrixId(matrixUserId)
      if (!userMapping || !userMapping.matrixId || !userMapping.accessToken) {
        log.warn(`Could not determine joining user ${matrixUserId}, skipping.`)
        return
      }

      // Get room creator session or use empty axios options
      let userSessionOptions = {}
      const roomCreatorId = (
        await axios.get(`/_synapse/admin/v1/rooms/${matrixRoomId}`)
      ).data.creator
      if (!roomCreatorId) {
        log.warn(
          `Could not determine room creator for room ${matrixRoomId}, using admin credentials.`
        )
      } else {
        const creatorMapping = await getMappingByMatrixId(roomCreatorId)
        if (creatorMapping?.accessToken) {
          userSessionOptions = formatUserSessionOptions(
            creatorMapping.accessToken
          )
        } else if (roomCreatorId !== adminAccessToken.user_id) {
          log.warn(`Could not get access token for ${roomCreatorId}, skipping.`)
          return
        }
        // Otherwise the admin created the room (its Rocket.Chat creator was
        // not migrated) without being a Rocket.Chat user: their credentials
        // are the default ones.
      }

      await addMember(userMapping, matrixRoomId, userSessionOptions)
      await fn()
    } else {
      throw error
    }
  }
}

/**
 * Handle a line of a Rocket.Chat room JSON export
 * @param rcRoom A Rocket.Chat room object
 */
export async function handle(rcRoom: RcRoom): Promise<void> {
  log.info(`Parsing room ${rcRoom.name || 'with ID: ' + rcRoom._id}`)
  if (rcRoom.t === RcRoomTypes.direct) rememberDirectChat(rcRoom._id)

  const matrixRoomId = await getRoomId(rcRoom._id)
  if (matrixRoomId) {
    log.debug(`Mapping exists: ${rcRoom._id} -> ${matrixRoomId}`)
    return
  }
  if (shouldSkipEmptyRooms()) {
    const reason = await whyEmpty(rcRoom)
    if (reason) {
      emptyRoomsSkipped++
      log.info(
        `Room ${rcRoom.name || rcRoom._id} is empty (${reason}), not created.`
      )
      return
    }
  }
  const matrixRoom = await createRoom(rcRoom)
  await createMapping(rcRoom._id, matrixRoom.room_id!)
}

let emptyRoomsSkipped = 0

/**
 * @returns The number of empty rooms left out by this run (SKIP_EMPTY_ROOMS)
 */
export function getEmptyRoomsSkipped(): number {
  return emptyRoomsSkipped
}
