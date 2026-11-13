import { beforeEach, expect, jest, test } from '@jest/globals'
import lineByLine from 'n-readlines'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { IdMapping } from '../entity/IdMapping'
import * as storage from '../helpers/storage'
import * as tuwunel from '../helpers/tuwunel'
import * as rooms from './rooms'
import { RcRoom, RcRoomTypes } from './rooms'
import { handleTeam, readTeams } from './spaces'

jest.mock('n-readlines')
const mockedLineByLine = lineByLine as jest.Mocked<typeof lineByLine>
jest.mock('../helpers/storage')
const mockedStorage = storage as jest.Mocked<typeof storage>
jest.mock('../helpers/tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>
jest.mock('./e2ee')
jest.mock('./rooms', () => ({
  ...(jest.requireActual('./rooms') as object),
  addMember: jest.fn(),
  applyRoomRoles: jest.fn(),
  chooseCreator: jest.fn(),
  getCreatorSessionOptions: jest.fn(),
}))
const mockedRooms = rooms as jest.Mocked<typeof rooms>

const main = {
  _id: 'dev',
  t: RcRoomTypes.chat,
  name: 'dev',
  fname: 'Développement',
  teamId: 'T1',
  teamMain: true,
} as RcRoom

test('teams are read from the rooms export', () => {
  const lines = [
    main,
    { _id: 'team', t: 'p', teamId: 'T1' },
    { _id: 'alone', t: 'c' },
    { _id: 'dm', t: 'd', teamId: 'T1' },
  ]
  for (const room of lines) {
    mockedLineByLine.prototype.next.mockReturnValueOnce(
      Buffer.from(JSON.stringify(room))
    )
  }
  mockedLineByLine.prototype.next.mockReturnValue(false)
  expect(readTeams()).toStrictEqual(
    new Map([['T1', { teamId: 'T1', main, rcRoomIds: ['dev', 'team'] }]])
  )
})

beforeEach(() => {
  jest.clearAllMocks()
  mockedStorage.getRoomId.mockImplementation(async (rid: string) =>
    rid === 'empty' ? undefined : `!${rid}`
  )
  mockedStorage.getUserId.mockImplementation(
    async (rcId: string) => `@${rcId}:matrix`
  )
  mockedStorage.getMemberships.mockResolvedValue(['alice', 'bob'])
  mockedStorage.getMapping.mockImplementation(async (rcId: string) =>
    rcId.startsWith('team:')
      ? null
      : ({ rcId, matrixId: `@${rcId}:matrix`, accessToken: rcId } as IdMapping)
  )
  mockedTuwunel.getServerName.mockResolvedValue('matrix')
  mockedTuwunel.axios.post.mockResolvedValue({ data: { room_id: '!space' } })
  mockedTuwunel.axios.get.mockResolvedValue({ data: { state: [] } })
  mockedTuwunel.getMatrixMembers.mockResolvedValue([
    adminAccessToken.user_id,
    '@alice:matrix',
    '@bob:matrix',
  ])
})

test('an owner creates the space of a team', async () => {
  const alice = { headers: { Authorization: 'Bearer alice' } }
  mockedRooms.chooseCreator.mockResolvedValue('alice')
  mockedRooms.getCreatorSessionOptions.mockResolvedValue(alice)
  await handleTeam({
    teamId: 'T1',
    main,
    rcRoomIds: ['dev', 'team', 'empty'],
  })
  expect(mockedTuwunel.axios.post).toHaveBeenCalledWith(
    '/_matrix/client/v3/createRoom',
    expect.objectContaining({
      name: 'Développement',
      creation_content: { type: 'm.space', 'm.federate': false },
      preset: 'public_chat',
    }),
    alice
  )
  expect(mockedStorage.save).toHaveBeenCalledWith(
    expect.objectContaining({ rcId: 'team:T1', matrixId: '!space', type: 3 })
  )
  expect(mockedRooms.applyRoomRoles).toHaveBeenCalledWith(
    main,
    '!space',
    '@alice:matrix',
    alice
  )
  // the migrated rooms, the main one suggested
  expect(mockedTuwunel.axios.put).toHaveBeenCalledTimes(2)
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/rooms/!space/state/m.space.child/!dev',
    { via: ['matrix'], order: '0', suggested: true },
    alice
  )
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/rooms/!space/state/m.space.child/!team',
    { via: ['matrix'] },
    alice
  )
  // the team members, but not the creator
  expect(mockedRooms.addMember).toHaveBeenCalledTimes(1)
  expect(mockedRooms.addMember.mock.calls[0][0].matrixId).toBe('@bob:matrix')
})

test('a resumed run only adds what is missing', async () => {
  mockedRooms.chooseCreator.mockResolvedValue('alice')
  const alice = { headers: { Authorization: 'Bearer alice' } }
  mockedRooms.getCreatorSessionOptions.mockResolvedValue(alice)
  mockedStorage.getMapping.mockImplementation(
    async (rcId: string) =>
      ({
        rcId,
        matrixId: rcId.startsWith('team:') ? '!space' : `@${rcId}:matrix`,
        accessToken: rcId,
      }) as IdMapping
  )
  mockedTuwunel.axios.get.mockResolvedValue({
    data: { state: [{ type: 'm.space.child', state_key: '!dev' }] },
  })
  await handleTeam({ teamId: 'T1', main, rcRoomIds: ['dev', 'team'] })
  expect(mockedTuwunel.axios.post).not.toHaveBeenCalledWith(
    '/_matrix/client/v3/createRoom',
    expect.anything(),
    expect.anything()
  )
  expect(mockedTuwunel.axios.put).toHaveBeenCalledTimes(1)
  // power levels possibly missing from an interrupted run
  expect(mockedRooms.applyRoomRoles).toHaveBeenCalledWith(
    main,
    '!space',
    '@alice:matrix',
    alice
  )
})

test('a creator who left the team does not create its space', async () => {
  // without owners, chooseCreator falls back to the Rocket.Chat creator
  mockedRooms.chooseCreator.mockResolvedValue('formerMember')
  mockedRooms.getCreatorSessionOptions.mockResolvedValue({})
  await handleTeam({ teamId: 'T1', main, rcRoomIds: ['dev'] })
  expect(mockedRooms.getCreatorSessionOptions).toHaveBeenCalledWith('')
  expect(mockedRooms.applyRoomRoles).toHaveBeenCalledWith(
    main,
    '!space',
    adminAccessToken.user_id,
    {}
  )
})
