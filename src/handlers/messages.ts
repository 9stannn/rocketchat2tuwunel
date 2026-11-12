import { AxiosError } from 'axios'
import * as emoji from 'node-emoji'
import * as showdown from 'showdown'
import { Entity, entities } from '../Entities'
import { IdMapping } from '../entity/IdMapping'
import log from '../helpers/logger'
import {
  getMessageId,
  getRoomId,
  getUserId,
  getUserMappingByName,
  save,
} from '../helpers/storage'
import {
  axios,
  formatUserSessionOptions,
  getServerName,
} from '../helpers/tuwunel'
import emojiMap from '../emojis.json'
import { isE2EE } from '../e2ee/config'
import { getCryptoSession } from '../e2ee/session'
import { executeAndHandleMissingMember } from './rooms'

const applicationServiceToken = process.env.AS_TOKEN || ''
if (!applicationServiceToken) {
  const message = 'No AS_TOKEN found in .env.'
  log.error(message)
  throw new Error(message)
}

/**
 * Type of Rocket.Chat messages
 */
export type RcMessage = {
  _id: string
  t?: string // Event type
  rid: string // The unique id for the room
  msg: string // The content of the message.
  tmid?: string
  ts: {
    $date: string
  }
  mentions?: string[]
  u: {
    _id: string
    username?: string
    name?: string
  }
  // md?: any // The message's content in a markdown format.
  pinned?: boolean
  pinnedBy?: {
    _id?: string
    username?: string
  }
  drid?: string // The direct room id (if belongs to a direct room).
  // attachments?: any[] // An array of attachment objects, available only when the message has at least one attachment.
  reactions?: {
    [key: string]: {
      usernames: string[]
    }
  }
  md?: string
}

/**
 * Type of Matrix message event bodies
 */
export type MatrixMessage = {
  body: string
  msgtype: string
  type: string
  format?: string
  formatted_body?: string
  'm.mentions'?: {
    room?: boolean
    user_ids?: Array<string>
  }
  'm.relates_to'?: {
    rel_type: 'm.thread'
    event_id: string
    is_falling_back: true
    'm.in_reply_to': {
      event_id: string
    }
  }
}

/**
 * Emojis translated from Rocket.Chat to Unicode emojis, which Matrix uses
 */
export type EmojiMappings = {
  [key: string]: string
}

export async function mapTextMessage(
  rcMessage: RcMessage
): Promise<MatrixMessage> {
  let msg = rcMessage.msg

  const serverName = await getServerName()

  const converterOptions: showdown.ConverterOptions = {
    literalMidWordUnderscores: true,
    simpleLineBreaks: true,
  }
  const mentions: MatrixMessage['m.mentions'] = {}

  if (msg.includes('@all')) {
    converterOptions['ghMentions'] = false

    msg = msg.replace('@all', '@room')

    mentions.room = true
  } else if (msg.includes('@here')) {
    converterOptions['ghMentions'] = false
  } else {
    converterOptions['ghMentions'] = true
    converterOptions['ghMentionsLink'] =
      'https://matrix.to/#/@{u}:' + serverName

    for (const mention of msg.matchAll(
      /(^|\s)(\\)?(@([a-z\d]+(?:[a-z\d._-]+?[a-z\d]+)*))/gi
    )) {
      const username = '@' + mention[4] + ':' + serverName

      mentions.user_ids = mentions?.user_ids || []
      mentions.user_ids.push(username)
    }
  }

  const converter = new showdown.Converter(converterOptions)

  const emojified = msg.replace(/:[\w\-+]+:/g, getEmoji)
  const htmled = converter.makeHtml(emojified)
  const matrixMessage: MatrixMessage = {
    type: 'm.room.message',
    msgtype: 'm.text',
    body: emojified,
  }
  if (mentions && (mentions.room || mentions.user_ids)) {
    matrixMessage['m.mentions'] = mentions
  }

  if (htmled.replace(/^<p>/, '').replace(/<\/p>$/, '') === emojified) {
    // markdown adds <p></p> tags, if it only adds this, don't add html part
    return matrixMessage
  } else {
    return {
      ...matrixMessage,
      format: 'org.matrix.custom.html',
      formatted_body: htmled,
    }
  }
}

/**
 * Translate a Rocket.Chat message to a Matrix message event body
 * @param rcMessage The Rocket.Chat message to convert
 * @returns The Matrix event body
 */
export async function mapMessage(rcMessage: RcMessage): Promise<MatrixMessage> {
  // handle other types of messages like pictures and files
  return mapTextMessage(rcMessage)
}

/**
 * Save an ID mapping in the local database
 * @param rcId Rocket.Chat message ID
 * @param matrixId Matrix message ID
 */
export async function createMapping(
  rcId: string,
  matrixId: string
): Promise<void> {
  const messageMapping = new IdMapping()
  messageMapping.rcId = rcId
  messageMapping.matrixId = matrixId
  messageMapping.type = entities[Entity.Messages].mappingType

  await save(messageMapping)
  log.debug('Mapping added:', messageMapping)
}

/**
 * Send a request to Tuwunel, creating the message event
 * @param matrixMessage The Matrix event body to use
 * @param room_id The Matrix room, the message will be posted to
 * @param user_id The user the message will be posted by
 * @param ts The timestamp to which the message will be dated
 * @param transactionId An unique identifier to distinguish identical messages
 * @returns The Matrix Message/event ID
 */
export async function createMessage(
  matrixMessage: MatrixMessage,
  room_id: string,
  user_id: string,
  ts: number,
  transactionId: string
): Promise<string> {
  if (isE2EE()) {
    return createEncryptedMessage(
      matrixMessage,
      room_id,
      user_id,
      ts,
      transactionId
    )
  }
  const parts = splitLongMessage(matrixMessage, MAX_PLAIN_CONTENT_BYTES)
  logSplit(transactionId, matrixMessage, parts)
  let firstEventId = ''
  for (const [index, part] of parts.entries()) {
    const eventId = (
      await axios.put(
        `/_matrix/client/v3/rooms/${room_id}/send/m.room.message/${partTransactionId(transactionId, index)}?user_id=${user_id}&ts=${ts + index}`,
        part,
        formatUserSessionOptions(applicationServiceToken)
      )
    ).data.event_id
    firstEventId ||= eventId
  }
  return firstEventId
}

/**
 * Matrix limits a whole event to 65535 bytes. An encrypted event carries its
 * content encrypted and base64 encoded (one third bigger), plus keys and
 * signatures: the plaintext content of one event is kept well below.
 */
export const MAX_ENCRYPTED_CONTENT_BYTES = 30000
export const MAX_PLAIN_CONTENT_BYTES = 50000

/**
 * @param value Any JSON value
 * @returns Its size once serialised, in bytes
 */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Make a message fit in Matrix events: first without its HTML version, then
 * split into parts ("[1/3] …") cut preferably at line breaks. Every part keeps
 * the relations (thread); the mentions stay on the first part.
 * @param content The message event content
 * @param maxBytes The maximum serialised size of one part
 * @returns The contents to send, in order (the content itself if it fits)
 */
export function splitLongMessage<T extends Record<string, unknown>>(
  content: T,
  maxBytes: number
): Array<Record<string, unknown>> {
  if (jsonBytes(content) <= maxBytes) {
    return [content]
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { format, formatted_body, ...plain } = content
  if (jsonBytes(plain) <= maxBytes) {
    return [plain]
  }

  const { body, 'm.mentions': mentions, ...rest } = plain
  const budget =
    maxBytes -
    jsonBytes({ ...rest, body: '[9999/9999] ', 'm.mentions': mentions }) -
    16
  const parts: string[] = []
  let remaining = String(body ?? '')
  while (remaining.length > 0) {
    let size = Math.min(remaining.length, budget)
    while (size > 1 && jsonBytes(remaining.slice(0, size)) > budget) {
      size = Math.floor(size * 0.9)
    }
    if (size < remaining.length) {
      const lineBreak = remaining.lastIndexOf('\n', size - 1)
      if (lineBreak >= size * 0.8) {
        size = lineBreak + 1
      }
      // never cut an emoji (UTF-16 surrogate pair) in two
      const code = remaining.charCodeAt(size - 1)
      if (code >= 0xd800 && code <= 0xdbff) {
        size--
      }
    }
    parts.push(remaining.slice(0, size))
    remaining = remaining.slice(size)
  }

  return parts.map((part, index) => ({
    ...rest,
    body: `[${index + 1}/${parts.length}] ${part}`,
    ...(index === 0 && mentions ? { 'm.mentions': mentions } : {}),
  }))
}

/**
 * @param transactionId The transaction ID of the message
 * @param index The index of the part
 * @returns A transaction ID unique to this part
 */
function partTransactionId(transactionId: string, index: number): string {
  return index === 0 ? transactionId : `${transactionId}.${index + 1}`
}

/**
 * Log what was done to a message too long for one Matrix event
 * @param transactionId The message transaction ID
 * @param original The original content
 * @param parts The contents that will be sent
 */
function logSplit(
  transactionId: string,
  original: Record<string, unknown>,
  parts: Array<Record<string, unknown>>
): void {
  if (parts.length > 1) {
    log.warn(
      `Message ${transactionId} is too long for one Matrix event, sent in ${parts.length} parts`
    )
  } else if (parts[0] !== original) {
    log.warn(
      `Message ${transactionId} is too long with its formatting, sent as plain text`
    )
  }
}

/**
 * E2EE mode: encrypt the message with the author's device, then send the
 * m.room.encrypted event dated with the original timestamp. The plaintext is
 * never sent to Tuwunel; any encryption error stops the migration.
 * @param matrixMessage The Matrix event body to encrypt
 * @param room_id The Matrix room, the message will be posted to
 * @param user_id The user the message will be posted by
 * @param ts The timestamp to which the message will be dated
 * @param transactionId An unique identifier to distinguish identical messages
 * @returns The Matrix Message/event ID
 */
export async function createEncryptedMessage(
  matrixMessage: MatrixMessage,
  room_id: string,
  user_id: string,
  ts: number,
  transactionId: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, ...content } = matrixMessage
  const session = await getCryptoSession(user_id)
  const parts = splitLongMessage(content, MAX_ENCRYPTED_CONTENT_BYTES)
  logSplit(transactionId, content, parts)
  let firstEventId = ''
  for (const [index, part] of parts.entries()) {
    const encrypted = await session.encrypt(room_id, 'm.room.message', part)
    const eventId = (
      await axios.put(
        `/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.encrypted/${encodeURIComponent(partTransactionId(transactionId, index))}`,
        encrypted,
        {
          ...formatUserSessionOptions(applicationServiceToken),
          // parts keep their order: one millisecond apart
          params: { user_id, ts: ts + index },
        }
      )
    ).data.event_id
    firstEventId ||= eventId
  }
  return firstEventId
}

/**
 * Add reactions to the event
 * @param reactions A Rocket.Chat reactions object
 * @param matrixMessageId The Matrix event reacted to
 * @param matrixRoomId The Matrix room
 */
export async function handleReactions(
  reactions: RcMessage['reactions'],
  matrixMessageId: string,
  matrixRoomId: string
): Promise<void> {
  for (const [reaction, value] of Object.entries(reactions || {})) {
    // Lookup key/emoji
    const reactionEmoji: string = getEmoji(reaction)

    if (reactionEmoji === reaction) {
      log.warn(
        `Could not find an emoji for ${reaction} for message ${matrixMessageId}, skipping`
      )
      continue
    }

    await Promise.all(
      [...new Set(value.usernames)] // Deduplicate users
        .map(async (rcUsername: string) => {
          // generate transaction id
          const transactionId = Buffer.from(
            [matrixMessageId, reactionEmoji, rcUsername].join('\0')
          ).toString('base64url')
          // lookup user access token
          const userMapping = await getUserMappingByName(rcUsername)
          if (!userMapping || !userMapping.accessToken) {
            log.warn(
              `Could not find user mapping for name: ${rcUsername}, skipping reaction ${reactionEmoji} for message ${matrixMessageId}`
            )
            return
          }

          const userSessionOptions = formatUserSessionOptions(
            userMapping.accessToken
          )
          log.http(
            `Adding reaction to message ${matrixMessageId} with symbol ${reactionEmoji} for user ${rcUsername}`
          )
          const reactionContent = {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: matrixMessageId,
              key: reactionEmoji,
            },
          }
          // put reaction
          try {
            await executeAndHandleMissingMember(
              async () => {
                if (isE2EE()) {
                  if (!userMapping.matrixId) {
                    throw new Error(`No Matrix ID for user ${rcUsername}`)
                  }
                  const session = await getCryptoSession(userMapping.matrixId)
                  const encrypted = await session.encrypt(
                    matrixRoomId,
                    'm.reaction',
                    reactionContent
                  )
                  await axios.put(
                    `/_matrix/client/v3/rooms/${encodeURIComponent(matrixRoomId)}/send/m.room.encrypted/${transactionId}`,
                    encrypted,
                    userSessionOptions
                  )
                } else {
                  await axios.put(
                    `/_matrix/client/v3/rooms/${matrixRoomId}/send/m.reaction/${transactionId}`,
                    reactionContent,
                    userSessionOptions
                  )
                }
              },
              userMapping.matrixId
                ? { matrixUserId: userMapping.matrixId, matrixRoomId }
                : undefined
            )
          } catch (error) {
            if (
              error instanceof AxiosError &&
              error.response &&
              error.response.data.errcode === 'M_DUPLICATE_ANNOTATION'
            ) {
              log.debug(
                `Duplicate reaction to message ${matrixMessageId} with symbol ${reactionEmoji} for user ${rcUsername}, skipping.`
              )
            } else {
              throw error
            }
          }
        })
    )
  }
}

/**
 * Lookup an emoji first by its name representation and return a unicode emoji.
 *
 * First the emojis.json is looked up, then the emoji library. If no emoji is found, the search string is returned.
 * @param searchString Name of the emoji, possibly surrounded by colons
 * @returns The found emoji or `searchString`
 */
export function getEmoji(searchString: string): string {
  return (
    (emojiMap as EmojiMappings)[searchString] ||
    emoji.get(searchString.replaceAll(':', '')) ||
    searchString
  )
}

/**
 * Handle a line of a Rocket.Chat message JSON export
 * @param rcMessage A Rocket.Chat message object
 */
export async function handle(rcMessage: RcMessage): Promise<void> {
  log.info(`Parsing message with ID: ${rcMessage._id}`)

  const matrixId = await getMessageId(rcMessage._id)
  if (matrixId) {
    log.debug(`Mapping exists: ${rcMessage._id} -> ${matrixId}`)
    return
  }

  const room_id = await getRoomId(rcMessage.rid)
  if (!room_id) {
    log.warn(
      `Could not find room ${rcMessage.rid} for message ${rcMessage._id}, skipping.`
    )
    return
  }

  if (rcMessage.t) {
    log.warn(
      `Message ${rcMessage._id} is of unhandled type ${rcMessage.t}, skipping.`
    )
    return
  }

  const user_id = await getUserId(rcMessage.u._id)
  if (!user_id) {
    log.warn(
      `Could not find author ${rcMessage.u.username} for message ${rcMessage._id}, skipping.`
    )
    return
  }
  const matrixMessage = await mapMessage(rcMessage)
  const ts = new Date(rcMessage.ts.$date).valueOf()

  if (rcMessage.tmid) {
    const event_id = await getMessageId(rcMessage.tmid)
    if (!event_id) {
      log.warn(`Related message ${rcMessage.tmid} missing, skipping.`)
      return
    } else {
      matrixMessage['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id,
        is_falling_back: true,
        'm.in_reply_to': {
          event_id,
        },
      }
    }
  }
  await executeAndHandleMissingMember(
    () =>
      createEventsAndMapping(matrixMessage, room_id, user_id, ts, rcMessage),
    { matrixUserId: user_id, matrixRoomId: room_id }
  )
}

/**
 * Wrapper function to combine the creation of a message, the reactions, adding of authors and the database mapping
 * @param matrixMessage The Matrix message event body
 * @param room_id The Matrix room ID
 * @param user_id The Matrix ID of the author
 * @param ts The Timestamp the message was originally created
 * @param rcMessage The originam Rocket.Chat message object
 */
async function createEventsAndMapping(
  matrixMessage: MatrixMessage,
  room_id: string,
  user_id: string,
  ts: number,
  rcMessage: RcMessage
): Promise<void> {
  const event_id = await createMessage(
    matrixMessage,
    room_id,
    user_id,
    ts,
    rcMessage._id
  )
  if (rcMessage.reactions) {
    log.info(
      `Parsing reactions for message ${rcMessage._id}`,
      rcMessage.reactions
    )
    await handleReactions(rcMessage.reactions, event_id, room_id)
  }
  await createMapping(rcMessage._id, event_id)
}
