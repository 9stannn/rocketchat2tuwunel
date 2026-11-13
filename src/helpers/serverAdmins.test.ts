import { afterEach, beforeEach, expect, jest, test } from '@jest/globals'
import {
  AxiosError,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
} from 'axios'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { IdMapping } from '../entity/IdMapping'
import {
  getServerAdmins,
  grantServerAdmins,
  resolveServerAdmins,
} from './serverAdmins'
import * as storage from './storage'
import * as tuwunel from './tuwunel'

jest.mock('./storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

jest.mock('./tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>

const notFound = new AxiosError('nah', '404', undefined, undefined, {
  data: { errcode: 'M_NOT_FOUND' },
  status: 404,
  statusText: 'Not found',
  headers: {} as AxiosResponseHeaders,
  config: {} as InternalAxiosRequestConfig,
})

// Migrated users; 'jean_d' must not match 'jeanxd'
const migrated = ['@jdupont:matrix', '@jeanxd:matrix', '@rcadmin:matrix']
let admins: Set<string>
let commands: string[]

beforeEach(() => {
  admins = new Set([adminAccessToken.user_id, '@rcadmin:matrix'])
  commands = []
  mockedTuwunel.axios.get.mockReset()
  mockedTuwunel.axios.put.mockReset()
  mockedTuwunel.getServerName.mockResolvedValue('matrix')
  mockedStorage.getMappingByMatrixId.mockImplementation(
    async (matrixId: string) =>
      migrated.includes(matrixId)
        ? ({ matrixId, type: 0, accessToken: 't' } as IdMapping)
        : null
  )
  mockedStorage.getAllMappingsByType.mockResolvedValue(
    [adminAccessToken.user_id, ...migrated].map(
      (matrixId) => ({ matrixId, type: 0 }) as IdMapping
    )
  )
  mockedTuwunel.axios.get.mockImplementation((async (url: string) => {
    if (url.startsWith('/_synapse/admin/v2/users/')) {
      if (decodeURIComponent(url).endsWith('@sso:matrix')) return { data: {} }
      throw notFound
    }
    if (url.endsWith('/admin')) {
      const userId = decodeURIComponent(url.split('/')[5])
      return { data: { admin: admins.has(userId) } }
    }
    if (url.startsWith('/_matrix/client/v3/directory/room/')) {
      return { data: { room_id: '!admins:matrix' } }
    }
    throw new Error(`unexpected GET ${url}`)
  }) as never)
  // Tuwunel runs the commands sent to its admin room
  mockedTuwunel.axios.put.mockImplementation((async (
    url: string,
    body: unknown
  ) => {
    expect(url).toMatch(
      /^\/_matrix\/client\/v3\/rooms\/!admins%3Amatrix\/send\/m\.room\.message\//
    )
    const command = (body as { body: string }).body
    commands.push(command)
    const [, , action, userId] = command.split(' ')
    if (userId === '@sso:matrix') return { data: { event_id: '$e' } } // refused
    if (action === 'make-user-admin') admins.add(userId)
    else admins.delete(userId)
    return { data: { event_id: '$e' } }
  }) as never)
})

afterEach(() => {
  delete process.env.SERVER_ADMINS
})

test('resolving SERVER_ADMINS', async () => {
  process.env.SERVER_ADMINS = 'JDupont,@sso:matrix,jdupont'
  await expect(resolveServerAdmins()).resolves.toStrictEqual([
    '@jdupont:matrix',
    '@sso:matrix',
  ])
  process.env.SERVER_ADMINS = 'jdupont,jean_d'
  await expect(resolveServerAdmins()).rejects.toThrow(
    'SERVER_ADMINS: jean_d is neither a migrated Rocket.Chat user nor an existing Matrix account'
  )
  process.env.SERVER_ADMINS = '@nobody:matrix'
  await expect(resolveServerAdmins()).rejects.toThrow(
    'SERVER_ADMINS: @nobody:matrix is neither'
  )
  // another server: refused without asking Tuwunel
  mockedTuwunel.axios.get.mockClear()
  process.env.SERVER_ADMINS = '@sso:other.org'
  await expect(resolveServerAdmins()).rejects.toThrow(
    'SERVER_ADMINS: @sso:other.org is neither'
  )
  expect(mockedTuwunel.axios.get).not.toHaveBeenCalled()
})

test('without SERVER_ADMINS nothing changes', async () => {
  await expect(grantServerAdmins(0)).resolves.toBeUndefined()
  expect(commands).toStrictEqual([])
})

test('only the listed users are server administrators', async () => {
  process.env.SERVER_ADMINS = 'jdupont'
  await expect(grantServerAdmins(0)).resolves.toBeUndefined()
  expect(commands).toStrictEqual([
    '!admin users make-user-admin @jdupont:matrix',
    // a Rocket.Chat admin made server admin by an earlier run
    '!admin users revoke-admin @rcadmin:matrix',
  ])
  expect(getServerAdmins()).toStrictEqual(['@jdupont:matrix'])
  expect(admins).toStrictEqual(
    new Set([adminAccessToken.user_id, '@jdupont:matrix'])
  )

  // Nothing to do on a second run
  commands = []
  await expect(grantServerAdmins(0)).resolves.toBeUndefined()
  expect(commands).toStrictEqual([])
})

test('an empty SERVER_ADMINS leaves only the migration admin', async () => {
  process.env.SERVER_ADMINS = ''
  await expect(grantServerAdmins(0)).resolves.toBeUndefined()
  expect(commands).toStrictEqual(['!admin users revoke-admin @rcadmin:matrix'])
})

test('a refused grant stops the migration', async () => {
  process.env.SERVER_ADMINS = '@sso:matrix'
  await expect(grantServerAdmins(0)).rejects.toThrow(
    "SERVER_ADMINS: 'make-user-admin @sso:matrix' had no effect"
  )
})
