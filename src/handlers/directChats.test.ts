import { expect, jest, test } from '@jest/globals'
import {
  AxiosError,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
} from 'axios'
import lineByLine from 'n-readlines'
import { IdMapping } from '../entity/IdMapping'
import log from '../helpers/logger'
import * as storage from '../helpers/storage'
import * as tuwunel from '../helpers/tuwunel'
import {
  DirectChats,
  UserDirectChatMappings,
  getDirectChats,
  handleDirectChats,
  parseDirectChats,
  setDirectChats,
} from './directChats'

jest.mock('n-readlines')
const mockedLineByLine = lineByLine as jest.Mocked<typeof lineByLine>

jest.mock('../helpers/storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

jest.mock('../helpers/tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>

const directChats: DirectChats = {
  abc: ['a', 'b', 'c'],
  ab: ['a', 'b'],
}

const directChatMappings: UserDirectChatMappings = {
  a: { b: ['abc', 'ab'], c: ['abc'] },
  b: { a: ['abc', 'ab'], c: ['abc'] },
  c: { a: ['abc'], b: ['abc'] },
}

test('direct chat parsing', () => {
  expect(parseDirectChats(directChats)).toStrictEqual(directChatMappings)
  expect(parseDirectChats({ ownRoom: ['selfchatter'] })).toStrictEqual({
    selfchatter: { selfchatter: ['ownRoom'] },
  })
})

test('get direct chats', async () => {
  const warn = jest.spyOn(log, 'warn')
  mockedLineByLine.prototype.next
    .mockReturnValueOnce(
      Buffer.from(JSON.stringify({ t: 'c', _id: 'ignored' }))
    )
    .mockReturnValueOnce(
      Buffer.from(JSON.stringify({ t: 'd', _id: 'abc', uids: ['a', 'b', 'c'] }))
    )
    .mockReturnValueOnce(
      Buffer.from(JSON.stringify({ t: 'd', _id: 'ab', uids: ['a', 'b'] }))
    )
    .mockReturnValueOnce(Buffer.from(JSON.stringify({ t: 'd', _id: false })))
    .mockReturnValue(false)

  mockedStorage.getRoomId.mockImplementation(async (id: string) => id)
  mockedStorage.getUserId.mockImplementation(async (id: string) => id)
  mockedTuwunel.getMatrixMembers.mockImplementation(
    async (roomId: string) => directChats[roomId]
  )

  await expect(getDirectChats()).resolves.toStrictEqual(directChats)
  expect(warn).toHaveBeenCalledWith(
    'Room false has no mapping, skipping to mark it as a direct chat.'
  )
})

test('direct chats only list their Rocket.Chat participants', async () => {
  const warn = jest.spyOn(log, 'warn')
  const rooms = [
    // The admin created the rooms whose first participant was not migrated
    {
      t: 'd',
      _id: 'adminCreated',
      uids: ['rcA', 'rcB'],
      usernames: ['a', 'b'],
    },
    {
      t: 'd',
      _id: 'ghostDm',
      uids: ['rcGhost', 'rcA'],
      usernames: ['ghost', 'a'],
    },
    { t: 'd', _id: 'self', uids: ['rcA', 'rcA'], usernames: ['a'] },
    // Old exports have no uids
    { t: 'd', _id: 'noUids', usernames: ['admin', 'b'] },
  ]
  mockedLineByLine.prototype.next.mockReset()
  for (const room of rooms) {
    mockedLineByLine.prototype.next.mockReturnValueOnce(
      Buffer.from(JSON.stringify(room))
    )
  }
  mockedLineByLine.prototype.next.mockReturnValue(false)

  const matrixMembers: { [key: string]: string[] } = {
    adminCreated: ['admin', 'a', 'b'],
    ghostDm: ['admin', 'a'],
    self: ['a'],
    noUids: ['admin', 'b'],
  }
  mockedStorage.getRoomId.mockImplementation(async (id: string) => id)
  mockedStorage.getUserId.mockImplementation(async (id: string) =>
    id === 'rcGhost' ? undefined : id.slice(2).toLowerCase()
  )
  mockedStorage.getUserMappingByName.mockImplementation(
    async (username: string) => ({ matrixId: username }) as IdMapping
  )
  mockedTuwunel.getMatrixMembers.mockImplementation(
    async (roomId: string) => matrixMembers[roomId]
  )

  await expect(getDirectChats()).resolves.toStrictEqual({
    adminCreated: ['a', 'b'],
    self: ['a'],
    noUids: ['admin', 'b'],
  })
  expect(warn).toHaveBeenCalledWith(
    'Direct chat ghostDm lost one or more members during migration, skipping.'
  )
})

test('setting direct chats', async () => {
  const debug = jest.spyOn(log, 'debug')
  mockedStorage.getMappingByMatrixId.mockImplementation(async (id: string) =>
    id === 'migratedRoom'
      ? ({ matrixId: id, type: 1 } as IdMapping)
      : ({ matrixId: id, type: 0, accessToken: 'token' } as IdMapping)
  )
  mockedTuwunel.axios.get
    .mockRejectedValueOnce(new AxiosError('Unauthorized'))
    .mockRejectedValueOnce(
      new AxiosError('Not found', '404', undefined, undefined, {
        data: { errcode: 'M_NOT_FOUND' },
        status: 404,
        statusText: 'Not found',
        headers: {} as AxiosResponseHeaders,
        config: {} as InternalAxiosRequestConfig,
      })
    )
    .mockResolvedValueOnce({ data: { partner: ['same'] } })
    .mockResolvedValueOnce({ data: { partner: ['different'] } })

  await expect(setDirectChats(directChatMappings)).rejects.toThrowError(
    'Unauthorized'
  )
  await expect(
    setDirectChats({
      testerNewSettings: { partner: ['chatname'] },
      testerExistingSameSettings: { partner: ['same'] },
      testerExistingDifferentSettings: { otherPartner: ['d1fferent'] },
    })
  ).resolves.toBeUndefined()
  expect(mockedTuwunel.axios.get).toHaveBeenCalledWith(
    '/_matrix/client/v3/user/a/account_data/m.direct',
    undefined
  )
  expect(mockedTuwunel.axios.put).toHaveBeenLastCalledWith(
    '/_matrix/client/v3/user/testerNewSettings/account_data/m.direct',
    { partner: ['chatname'] },
    undefined
  )

  expect(debug).toHaveBeenCalledWith(
    'User testerExistingSameSettings already has the expected direct chats configured, skipping.'
  )
  expect(debug).toHaveBeenCalledWith(
    'User testerExistingDifferentSettings already has a different direct chat setting.'
  )
})

test('direct chat settings of an interrupted run are corrected', async () => {
  const info = jest.spyOn(log, 'info')
  const warn = jest.spyOn(log, 'warn')
  mockedStorage.getMappingByMatrixId.mockImplementation(async (id: string) => {
    if (id === 'adminWithoutMapping') return null
    if (id.startsWith('!')) return { matrixId: id, type: 1 } as IdMapping
    return { matrixId: id, type: 0, accessToken: 'token' } as IdMapping
  })
  mockedTuwunel.axios.get.mockReset()
  mockedTuwunel.axios.put.mockReset()
  mockedTuwunel.axios.get
    // stale: lists the admin as a partner, migrated rooms only
    .mockResolvedValueOnce({ data: { admin: ['!dm'], b: ['!ab'] } })
    // stale, the user has no direct chat any more
    .mockResolvedValueOnce({ data: { admin: ['!dm'] } })
    .mockRejectedValueOnce(
      new AxiosError('Not found', '404', undefined, undefined, {
        data: { errcode: 'M_NOT_FOUND' },
        status: 404,
        statusText: 'Not found',
        headers: {} as AxiosResponseHeaders,
        config: {} as InternalAxiosRequestConfig,
      })
    )

  await expect(
    setDirectChats({
      adminWithoutMapping: { a: ['!dm'] },
      a: { b: ['!ab'] },
      formerDmUser: {},
      noDirectChat: {},
    })
  ).resolves.toBeUndefined()

  expect(warn).toHaveBeenCalledWith(
    'User adminWithoutMapping has no access token, skipping their direct chat settings.'
  )
  expect(mockedTuwunel.axios.get).toHaveBeenCalledTimes(3)
  expect(mockedTuwunel.axios.put).toHaveBeenCalledTimes(2)
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/user/a/account_data/m.direct',
    { b: ['!ab'] },
    undefined
  )
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/user/formerDmUser/account_data/m.direct',
    {},
    undefined
  )
  expect(info).toHaveBeenCalledWith(
    'Direct chat setting of a, written by an earlier run, corrected'
  )
})

test('handle direct chats', async () => {
  mockedStorage.getAllMappingsByType.mockResolvedValue([])
  await expect(handleDirectChats()).resolves.toBeUndefined()
})
