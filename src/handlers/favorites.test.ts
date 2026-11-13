import { expect, jest, test } from '@jest/globals'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdMapping } from '../entity/IdMapping'
import { getFavorites, loadRoomRoles } from '../helpers/roomRoles'
import * as storage from '../helpers/storage'
import * as tuwunel from '../helpers/tuwunel'
import { handleFavorites } from './favorites'

jest.mock('../helpers/storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

jest.mock('../helpers/tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>

test('favorites become m.favourite tags', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rc2tw-')), 'subs.json')
  writeFileSync(
    file,
    [
      { rid: 'dev', u: { _id: 'alice' }, f: true },
      { rid: 'dev', u: { _id: 'bob' }, f: false, roles: ['owner'] },
      { rid: 'left', u: { _id: 'alice' }, f: true }, // no longer a member
      { rid: 'empty', u: { _id: 'alice' }, f: true }, // room not created
      { rid: 'dev', u: { _id: 'ghost' }, f: true }, // user not migrated
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
  )
  expect(loadRoomRoles(file)).toBe(true)
  expect(getFavorites()).toHaveLength(4)

  mockedStorage.getRoomId.mockImplementation(async (rid: string) =>
    rid === 'empty' ? undefined : `!${rid}`
  )
  mockedStorage.getMapping.mockImplementation(async (rcId: string) =>
    rcId === 'ghost'
      ? null
      : ({ matrixId: `@${rcId}:matrix`, accessToken: rcId } as IdMapping)
  )
  mockedStorage.getMemberships.mockImplementation(async (rid: string) =>
    rid === 'dev' ? ['alice', 'bob', 'ghost'] : []
  )
  mockedTuwunel.formatUserSessionOptions.mockImplementation(
    (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
    })
  )
  await handleFavorites()
  expect(mockedTuwunel.axios.put).toHaveBeenCalledTimes(1)
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/user/%40alice%3Amatrix/rooms/!dev/tags/m.favourite',
    {},
    { headers: { Authorization: 'Bearer alice' } }
  )
})
