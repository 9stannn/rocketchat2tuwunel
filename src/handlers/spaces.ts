import lineByLine from 'n-readlines'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { Entity, entities } from '../Entities'
import { isE2EE } from '../e2ee/config'
import { IdMapping } from '../entity/IdMapping'
import log from '../helpers/logger'
import {
  getMapping,
  getMemberships,
  getRoomId,
  getUserId,
  save,
} from '../helpers/storage'
import { axios, getMatrixMembers, getServerName } from '../helpers/tuwunel'
import { chooseHeir } from './e2ee'
import {
  RcRoom,
  RcRoomTypes,
  addMember,
  applyRoomRoles,
  chooseCreator,
  getCreatorSessionOptions,
} from './rooms'

/**
 * Rocket.Chat teams become Matrix spaces: a space named after the team's main
 * room, holding every migrated room of the team, joined by the members of the
 * main room (the team members), with the main room's owners and moderators.
 */

export const SPACE_MAPPING_TYPE = 3

/**
 * @param teamId A Rocket.Chat team ID
 * @returns The Rocket.Chat ID under which the team's space is mapped
 */
export const spaceRcId = (teamId: string) => `team:${teamId}`

export type Team = {
  teamId: string
  main?: RcRoom
  rcRoomIds: string[]
  defaults?: string[] // Rocket.Chat IDs of its default rooms
}

/**
 * @returns The teams found in the rooms export, by team ID
 */
export function readTeams(): Map<string, Team> {
  const teams = new Map<string, Team>()
  const rl = new lineByLine(`./inputs/${entities[Entity.Rooms].filename}`)
  let line: false | Buffer
  while ((line = rl.next())) {
    const room: RcRoom = JSON.parse(line.toString())
    if (!room.teamId || room.t === RcRoomTypes.direct) continue
    if (!teams.has(room.teamId)) {
      teams.set(room.teamId, { teamId: room.teamId, rcRoomIds: [] })
    }
    const team = teams.get(room.teamId)!
    team.rcRoomIds.push(room._id)
    if (room.teamMain) team.main = room
    if (room.teamDefault) team.defaults = [...(team.defaults ?? []), room._id]
  }
  return teams
}

/**
 * Create, or complete on a resumed run, the space of a team
 * @param team The team
 */
export async function handleTeam(team: Team): Promise<void> {
  const main = team.main
  if (!main) {
    log.warn(`Team ${team.teamId} has no main room in the export, no space.`)
    return
  }
  const name = main.fname || main.name || team.teamId
  const mainRoomId = await getRoomId(main._id)
  const children: string[] = []
  const suggested = new Set<string>()
  for (const rcRoomId of team.rcRoomIds) {
    const roomId = await getRoomId(rcRoomId)
    if (!roomId) continue
    children.push(roomId)
    if (rcRoomId === main._id || team.defaults?.includes(rcRoomId)) {
      suggested.add(roomId)
    }
  }
  if (children.length === 0) {
    log.info(`Team ${name} has no migrated room, no space.`)
    return
  }

  const adminId = adminAccessToken.user_id
  // The creator keeps unlimited power over the space: a team member only
  // (without owners, chooseCreator may return a creator who left the team)
  const mainMembers = new Set(await getMemberships(main._id))
  let creatorId = await chooseCreator(main)
  if (creatorId && !mainMembers.has(creatorId)) creatorId = ''
  const creatorSessionOptions = await getCreatorSessionOptions(creatorId)
  const creatorUserId =
    Object.keys(creatorSessionOptions).length > 0
      ? (await getUserId(creatorId)) || adminId
      : adminId

  let spaceId = (await getMapping(spaceRcId(team.teamId), SPACE_MAPPING_TYPE))
    ?.matrixId
  if (!spaceId) {
    spaceId = (
      await axios.post(
        '/_matrix/client/v3/createRoom',
        {
          name,
          ...(main.description ? { topic: main.description } : {}),
          creation_content: { type: 'm.space', 'm.federate': false },
          preset: main.t === RcRoomTypes.chat ? 'public_chat' : 'private_chat',
          visibility: 'private',
          // Only its admins change the space
          power_level_content_override: { events_default: 100 },
        },
        creatorSessionOptions
      )
    ).data.room_id as string
    const mapping = new IdMapping()
    mapping.rcId = spaceRcId(team.teamId)
    mapping.matrixId = spaceId
    mapping.type = SPACE_MAPPING_TYPE
    await save(mapping)
    log.info(`Space ${name} created for team ${team.teamId}: ${spaceId}`)
  } else if (
    creatorUserId === adminId &&
    !(await getMatrixMembers(spaceId)).includes(adminId)
  ) {
    // An earlier E2EE run set it up and the admin left it
    log.debug(`Space ${name} is set up already, skipping.`)
    return
  }
  // Also on a resumed run: only raises the levels still missing
  await applyRoomRoles(main, spaceId, creatorUserId, creatorSessionOptions)

  const state: Array<{ type: string; state_key?: string }> = (
    await axios.get(
      `/_synapse/admin/v1/rooms/${encodeURIComponent(spaceId)}/state`
    )
  ).data.state
  const linked = new Set(
    state
      .filter((event) => event.type === 'm.space.child')
      .map((event) => event.state_key)
  )
  const serverName = await getServerName()
  for (const child of children) {
    if (linked.has(child)) continue
    await axios.put(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(child)}`,
      {
        via: [serverName],
        // The main room first, the team's default rooms suggested
        ...(child === mainRoomId ? { order: '0' } : {}),
        ...(suggested.has(child) ? { suggested: true } : {}),
      },
      creatorSessionOptions
    )
  }

  // The team members are the members of its main room
  const members = new Set<string>()
  for (const rcUserId of mainMembers) {
    const mapping = await getMapping(
      rcUserId,
      entities[Entity.Users].mappingType
    )
    if (!mapping?.matrixId || !mapping.accessToken) continue
    members.add(mapping.matrixId)
    if (mapping.matrixId !== creatorUserId) {
      await addMember(mapping, spaceId, creatorSessionOptions)
    }
  }

  // E2EE mode: the admin does not stay where it was not a member
  if (isE2EE() && creatorUserId === adminId && !members.has(adminId)) {
    const heir = await chooseHeir({
      roomId: spaceId,
      rcRoomId: main._id,
      members,
      joined: await getMatrixMembers(spaceId),
      encrypted: false,
      events: [],
    })
    if (heir) {
      await axios.post(
        `/_synapse/admin/v1/rooms/${encodeURIComponent(spaceId)}/make_room_admin`,
        { user_id: heir }
      )
    } else {
      log.warn(`Space ${name}: nobody gets its admin rights`)
    }
    await axios.post(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/leave`,
      {}
    )
    log.info(
      `${adminId} left space ${name}${heir ? `; ${heir} is now its admin` : ''}`
    )
  }
}

/**
 * Turn every Rocket.Chat team into a Matrix space
 */
export async function handleSpaces(): Promise<void> {
  const teams = readTeams()
  if (teams.size === 0) return
  log.info(`Creating the spaces of ${teams.size} team(s)`)
  for (const team of teams.values()) {
    await handleTeam(team)
  }
}
