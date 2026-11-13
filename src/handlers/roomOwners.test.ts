import { beforeAll, expect, jest, test } from '@jest/globals'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import adminAccessToken from '../config/tuwunel_access_token.json'
import { ScannedRoom } from '../e2ee/history'
import { loadRoomRoles, rememberDirectChat } from '../helpers/roomRoles'
import * as serverAdmins from '../helpers/serverAdmins'
import * as storage from '../helpers/storage'
import * as tuwunel from '../helpers/tuwunel'
import { chooseHeir } from './e2ee'
import { RcRoom, RcRoomTypes, applyRoomRoles, chooseCreator } from './rooms'

jest.mock('../helpers/storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

jest.mock('../helpers/tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>

jest.mock('../helpers/serverAdmins')
const mockedServerAdmins = serverAdmins as jest.Mocked<typeof serverAdmins>

// Rocket.Chat user IDs: rc<Name>; 'rcGhost' was not migrated
const migrated = ['rcAlice', 'rcBob', 'rcCarl', 'rcDora']
const matrixId = (rcId: string) => `@${rcId.slice(2).toLowerCase()}:matrix`

beforeAll(() => {
  const file = join(mkdtempSync(join(tmpdir(), 'rc2tw-')), 'subs.json')
  const subs = [
    // creator still owner, plus a second owner and a moderator
    ['team', 'rcBob', 'bob', ['owner']],
    ['team', 'rcAlice', 'alice', ['owner']],
    ['team', 'rcCarl', 'carl', ['moderator']],
    // ownership handed over: the creator is not an owner any more
    ['handedOver', 'rcDora', 'dora', ['owner']],
    // the only owner was deleted
    ['orphan', 'rcGhost', 'ghost', ['owner']],
    ['orphan', 'rcCarl', 'carl', ['moderator']],
    // owner deleted, no moderator
    ['ownerless', 'rcGhost', 'ghost', ['owner']],
  ].map(([rid, _id, username, roles]) =>
    JSON.stringify({ rid, u: { _id, username }, roles })
  )
  writeFileSync(file, subs.join('\n') + '\n')
  loadRoomRoles(file)
  mockedStorage.getUserId.mockImplementation(async (rcId: string) =>
    migrated.includes(rcId) ? matrixId(rcId) : undefined
  )
})

const room = (_id: string, creator?: string, t = RcRoomTypes.private): RcRoom =>
  ({ _id, t, name: _id, u: creator ? { _id: creator } : undefined }) as RcRoom

test('an owner creates the room', async () => {
  // the Rocket.Chat creator if they are still an owner
  await expect(chooseCreator(room('team', 'rcBob'))).resolves.toBe('rcBob')
  // else the first owner by username
  await expect(chooseCreator(room('team', 'rcCarl'))).resolves.toBe('rcAlice')
  await expect(chooseCreator(room('handedOver', 'rcAlice'))).resolves.toBe(
    'rcDora'
  )
  // no owner migrated: the admin
  await expect(chooseCreator(room('orphan', 'rcCarl'))).resolves.toBe('')
  // no owner known: the Rocket.Chat creator, as before
  await expect(chooseCreator(room('noRoles', 'rcCarl'))).resolves.toBe('rcCarl')
  // direct chats are not concerned
  await expect(
    chooseCreator({
      _id: 'team',
      t: RcRoomTypes.direct,
      uids: ['rcCarl', 'rcBob'],
    } as RcRoom)
  ).resolves.toBe('rcCarl')
})

test('owners and moderators get their power levels', async () => {
  mockedTuwunel.axios.get.mockResolvedValue({
    data: { users: { '@bob:matrix': 100 }, users_default: 0, ban: 50 },
  })
  mockedTuwunel.axios.put.mockResolvedValue({ data: {} })
  await applyRoomRoles(room('team', 'rcBob'), '!team', '@bob:matrix', {
    headers: { Authorization: 'Bearer bob' },
  })
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/rooms/!team/state/m.room.power_levels/',
    {
      users: { '@bob:matrix': 100, '@alice:matrix': 100, '@carl:matrix': 50 },
      users_default: 0,
      ban: 50,
    },
    { headers: { Authorization: 'Bearer bob' } }
  )

  // The creator is never listed (refused in room versions >= 12)
  mockedTuwunel.axios.put.mockClear()
  mockedTuwunel.axios.get.mockResolvedValue({ data: { users: {} } })
  await applyRoomRoles(room('handedOver'), '!h', '@dora:matrix', {})
  expect(mockedTuwunel.axios.put).not.toHaveBeenCalled()

  // Set already (resumed run): nothing is sent
  mockedTuwunel.axios.get.mockResolvedValue({
    data: { users: { '@alice:matrix': 100, '@carl:matrix': 50 } },
  })
  await applyRoomRoles(room('team', 'rcBob'), '!team', '@bob:matrix', {})
  expect(mockedTuwunel.axios.put).not.toHaveBeenCalled()

  // Nothing to do without roles
  await applyRoomRoles(room('noRoles'), '!n', adminAccessToken.user_id, {})
  expect(mockedTuwunel.axios.put).not.toHaveBeenCalled()
})

const scanned = (rcRoomId: string, joined: string[]): ScannedRoom => ({
  roomId: `!${rcRoomId}`,
  rcRoomId,
  members: new Set(joined),
  joined: [adminAccessToken.user_id, ...joined],
  encrypted: true,
  events: [],
})

test('heir of a room the admin leaves', async () => {
  mockedServerAdmins.getServerAdmins.mockReturnValue(['@dora:matrix'])
  // a moderator, not the first member by name
  await expect(
    chooseHeir(scanned('orphan', ['@alice:matrix', '@carl:matrix']))
  ).resolves.toBe('@carl:matrix')
  // no owner nor moderator: a member listed in SERVER_ADMINS
  await expect(
    chooseHeir(scanned('ownerless', ['@alice:matrix', '@dora:matrix']))
  ).resolves.toBe('@dora:matrix')
  // nobody fits
  await expect(
    chooseHeir(scanned('ownerless', ['@alice:matrix']))
  ).resolves.toBeUndefined()
  // a direct chat goes to its participant
  rememberDirectChat('dmGhost')
  await expect(chooseHeir(scanned('dmGhost', ['@alice:matrix']))).resolves.toBe(
    '@alice:matrix'
  )
})
