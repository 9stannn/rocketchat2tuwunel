import { AxiosError } from 'axios'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { Entity, entities } from '../Entities'
import log from './logger'
import { getServerAdminEntries, serverAdminsListed } from './settings'
import { getAllMappingsByType, getMappingByMatrixId } from './storage'
import { axios, getServerName } from './tuwunel'

/**
 * Tuwunel server administrators listed in SERVER_ADMINS, by Matrix ID,
 * once resolved by grantServerAdmins()
 */
let serverAdmins: string[] = []

/**
 * @returns The Matrix IDs of the users listed in SERVER_ADMINS
 */
export function getServerAdmins(): string[] {
  return serverAdmins
}

/**
 * @param userId A Matrix user ID
 * @returns Whether a local account with this ID exists
 */
async function accountExists(userId: string): Promise<boolean> {
  try {
    await axios.get(`/_synapse/admin/v2/users/${encodeURIComponent(userId)}`)
    return true
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return false
    }
    throw error
  }
}

/**
 * @param userId A Matrix user ID
 * @returns Whether the user is a Tuwunel server administrator
 */
async function isServerAdmin(userId: string): Promise<boolean> {
  return (
    (
      await axios.get(
        `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/admin`
      )
    ).data?.admin === true
  )
}

/**
 * Resolve the entries of SERVER_ADMINS to Matrix IDs: a Rocket.Chat username
 * is a migrated user, a Matrix ID (@user:server) an existing account
 * @returns The Matrix IDs
 * @throws If an entry is neither
 */
export async function resolveServerAdmins(): Promise<string[]> {
  const userIds: string[] = []
  const serverName = await getServerName()
  for (const entry of getServerAdminEntries()) {
    let userId: string | undefined
    if (entry.startsWith('@')) {
      // Only local accounts can be server administrators
      const server = entry.slice(entry.indexOf(':') + 1)
      if (server === serverName && (await accountExists(entry))) {
        userId = entry
      }
    } else {
      // Exact match: a migrated user's ID is @<lowercased username>:<server>
      const mapping = await getMappingByMatrixId(
        `@${entry.toLowerCase()}:${serverName}`
      )
      if (mapping?.type === entities[Entity.Users].mappingType) {
        userId = mapping.matrixId
      }
    }
    if (!userId) {
      throw new Error(
        `SERVER_ADMINS: ${entry} is neither a migrated Rocket.Chat user nor an existing Matrix account`
      )
    }
    if (!userIds.includes(userId)) userIds.push(userId)
  }
  return userIds
}

/**
 * @returns The Matrix ID of Tuwunel's admin room, where admin commands are run
 */
async function getAdminRoomId(): Promise<string> {
  const alias = `#admins:${await getServerName()}`
  try {
    return (
      await axios.get(
        `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`
      )
    ).data.room_id
  } catch (error) {
    throw new Error(
      `SERVER_ADMINS: the Tuwunel admin room ${alias} was not found (${error})`
    )
  }
}

/**
 * Send an admin command to Tuwunel's admin room, as the migration admin, and
 * wait until the user's server administrator status is the expected one
 * @param command `make-user-admin` or `revoke-admin`
 * @param userId The Matrix ID of the user
 * @param pollIntervalMs The delay between two checks
 */
async function runAdminCommand(
  command: 'make-user-admin' | 'revoke-admin',
  userId: string,
  pollIntervalMs: number
): Promise<void> {
  adminRoomId ??= await getAdminRoomId()
  await axios.put(
    `/_matrix/client/v3/rooms/${encodeURIComponent(adminRoomId)}/send/m.room.message/${encodeURIComponent(`rc2tuwunel-${command}-${Date.now()}-${userId}`)}`,
    { msgtype: 'm.text', body: `!admin users ${command} ${userId}` }
  )
  const expected = command === 'make-user-admin'
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    if ((await isServerAdmin(userId)) === expected) return
  }
  throw new Error(
    `SERVER_ADMINS: '${command} ${userId}' had no effect, see Tuwunel's answer in the admin room`
  )
}

let adminRoomId: string | undefined

/**
 * Make the users listed in SERVER_ADMINS Tuwunel server administrators,
 * with Tuwunel's `users make-user-admin` command, sent to the admin room by
 * the migration admin. The other migrated users lose this status, e.g. when
 * an earlier run made the Rocket.Chat admins server administrators.
 * Does nothing when SERVER_ADMINS is not set.
 * @param pollIntervalMs The delay between two checks of a user's status
 */
export async function grantServerAdmins(pollIntervalMs = 500): Promise<void> {
  if (!serverAdminsListed()) return
  serverAdmins = await resolveServerAdmins()
  for (const userId of serverAdmins) {
    if (await isServerAdmin(userId)) {
      log.info(`${userId} is a Tuwunel server administrator already`)
      continue
    }
    await runAdminCommand('make-user-admin', userId, pollIntervalMs)
    log.info(`${userId} is now a Tuwunel server administrator`)
  }
  for (const mapping of await getAllMappingsByType(
    entities[Entity.Users].mappingType
  )) {
    const userId = mapping.matrixId
    if (
      !userId ||
      userId === adminAccessToken.user_id ||
      serverAdmins.includes(userId) ||
      !(await isServerAdmin(userId))
    ) {
      continue
    }
    await runAdminCommand('revoke-admin', userId, pollIntervalMs)
    log.warn(
      `${userId} is not listed in SERVER_ADMINS: no longer a Tuwunel server administrator`
    )
  }
}
