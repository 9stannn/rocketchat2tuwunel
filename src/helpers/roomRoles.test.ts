import { expect, test } from '@jest/globals'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getRoomRoles,
  isDirectChat,
  loadRoomRoles,
  rememberDirectChat,
  roomRolesLoaded,
} from './roomRoles'

test('no subscriptions export', () => {
  expect(loadRoomRoles(join(tmpdir(), 'does-not-exist.json'))).toBe(false)
  expect(roomRolesLoaded()).toBe(false)
  expect(getRoomRoles('room')).toStrictEqual({ owners: [], moderators: [] })
})

test('loading owners and moderators', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rc2tw-')), 'subs.json')
  writeFileSync(
    file,
    [
      { rid: 'r1', u: { _id: 'z', username: 'zoe' }, roles: ['owner'] },
      { rid: 'r1', u: { _id: 'a', username: 'alice' }, roles: ['owner'] },
      { rid: 'r1', u: { _id: 'm', username: 'max' }, roles: ['moderator'] },
      { rid: 'r1', u: { _id: 'l', username: 'leo' }, roles: ['leader'] },
      {
        rid: 'r2',
        u: { _id: 'b', username: 'bob' },
        roles: ['owner', 'moderator'],
      },
      { rid: 'r3', u: { _id: 'c', username: 'carl' } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  expect(loadRoomRoles(file)).toBe(true)
  expect(roomRolesLoaded()).toBe(true)
  expect(getRoomRoles('r1')).toStrictEqual({
    owners: ['a', 'z'],
    moderators: ['m'],
  })
  expect(getRoomRoles('r2')).toStrictEqual({ owners: ['b'], moderators: ['b'] })
  expect(getRoomRoles('r3')).toStrictEqual({ owners: [], moderators: [] })
})

test('direct chats', () => {
  rememberDirectChat('dm')
  expect(isDirectChat('dm')).toBe(true)
  expect(isDirectChat('r1')).toBe(false)
})
