import { expect, jest, test } from '@jest/globals'
import lineByLine from 'n-readlines'
import { IdMapping } from '../entity/IdMapping'
import { scanRoomActivity, whyEmpty } from './emptyRooms'
import * as storage from './storage'

jest.mock('n-readlines')
const mockedLineByLine = lineByLine as jest.Mocked<typeof lineByLine>

jest.mock('./storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

test('empty rooms', async () => {
  await expect(whyEmpty({ _id: 'x' })).rejects.toThrow(
    'scanRoomActivity() must run before whyEmpty()'
  )
  mockedStorage.getAllMappingsByType.mockResolvedValue([
    { rcId: 'alice' } as IdMapping,
    { rcId: 'bob' } as IdMapping,
  ])
  const users = [
    { _id: 'alice', __rooms: ['active'] },
    // the admin as a Rocket.Chat user: no Membership row outside E2EE mode
    { _id: 'bob', __rooms: ['adminOnly'] },
    { _id: 'ghost', __rooms: ['formerMembers'] },
  ]
  const messages = [
    { _id: 'm1', rid: 'system', t: 'uj', u: { _id: 'alice' } },
    { _id: 'm2', rid: 'ghostOnly', u: { _id: 'ghost' } },
    { _id: 'm3', rid: 'active', u: { _id: 'alice' } },
    { _id: 'm4', rid: 'formerMembers', u: { _id: 'bob' } },
    { _id: 'm5', rid: 'dm', u: { _id: 'bob' } },
    { _id: 'm6', rid: 'adminOnly', u: { _id: 'bob' } },
    // replies to a root that is not migrated, or that comes later
    { _id: 'm7', rid: 'botAlerts', u: { _id: 'rocket.cat' } },
    { _id: 'm8', rid: 'botAlerts', tmid: 'm7', u: { _id: 'alice' } },
    { _id: 'm9', rid: 'lateRoot', tmid: 'm10', u: { _id: 'alice' } },
    { _id: 'm10', rid: 'lateRoot', t: 'discussion-created', u: { _id: 'bob' } },
    // a reply to a migrated root
    { _id: 'm11', rid: 'thread', u: { _id: 'alice' } },
    { _id: 'm12', rid: 'thread', tmid: 'm11', u: { _id: 'bob' } },
  ]
  for (const line of [...users, false, ...messages]) {
    mockedLineByLine.prototype.next.mockReturnValueOnce(
      line === false ? false : Buffer.from(JSON.stringify(line))
    )
  }
  mockedLineByLine.prototype.next.mockReturnValue(false)
  await scanRoomActivity()

  const memberships: { [key: string]: string[] } = {
    active: ['alice', 'ghost'],
    formerMembers: ['ghost'],
  }
  mockedStorage.getMemberships.mockImplementation(
    async (rcRoomId: string) => memberships[rcRoomId] ?? []
  )
  await expect(whyEmpty({ _id: 'never' })).resolves.toBe(
    'no message to migrate'
  )
  await expect(whyEmpty({ _id: 'system' })).resolves.toBe(
    'no message to migrate'
  )
  await expect(whyEmpty({ _id: 'ghostOnly' })).resolves.toBe(
    'no message to migrate'
  )
  await expect(whyEmpty({ _id: 'formerMembers' })).resolves.toBe(
    'no migrated member'
  )
  await expect(whyEmpty({ _id: 'active' })).resolves.toBeUndefined()
  await expect(whyEmpty({ _id: 'adminOnly' })).resolves.toBeUndefined()
  await expect(whyEmpty({ _id: 'botAlerts' })).resolves.toBe(
    'no message to migrate'
  )
  await expect(whyEmpty({ _id: 'lateRoot' })).resolves.toBe(
    'no message to migrate'
  )
  memberships.thread = ['alice']
  await expect(whyEmpty({ _id: 'thread' })).resolves.toBeUndefined()
  // Direct chats: their members are their uids
  await expect(
    whyEmpty({ _id: 'dm', uids: ['bob', 'ghost'] })
  ).resolves.toBeUndefined()
})
