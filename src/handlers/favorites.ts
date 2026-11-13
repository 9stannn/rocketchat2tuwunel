import { Entity, entities } from '../Entities'
import log from '../helpers/logger'
import { getFavorites } from '../helpers/roomRoles'
import { getMapping, getMemberships, getRoomId } from '../helpers/storage'
import { axios, formatUserSessionOptions } from '../helpers/tuwunel'

/**
 * Mark the rooms the users had as favorites in Rocket.Chat with the Matrix
 * m.favourite tag (Element's "Favourites"). Tags are private to each user.
 * Runs before the E2EE phase, which logs the migration devices out.
 */
export async function handleFavorites(): Promise<void> {
  let tagged = 0
  for (const { rcRoomId, rcUserId } of getFavorites()) {
    const roomId = await getRoomId(rcRoomId)
    const user = await getMapping(rcUserId, entities[Entity.Users].mappingType)
    // Not migrated (empty room, excluded user), or no longer a member
    if (
      !roomId ||
      !user?.matrixId ||
      !user.accessToken ||
      !(await getMemberships(rcRoomId)).includes(rcUserId)
    ) {
      continue
    }
    await axios.put(
      `/_matrix/client/v3/user/${encodeURIComponent(user.matrixId)}/rooms/${encodeURIComponent(roomId)}/tags/m.favourite`,
      {},
      formatUserSessionOptions(user.accessToken)
    )
    tagged++
  }
  if (getFavorites().length > 0) {
    log.info(`${tagged} favorite room(s) marked as such`)
  }
}
