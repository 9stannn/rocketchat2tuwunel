import { afterEach, expect, test } from '@jest/globals'
import {
  booleanSetting,
  getServerAdminEntries,
  serverAdminsListed,
  shouldSkipEmptyRooms,
} from './settings'

afterEach(() => {
  delete process.env.SKIP_EMPTY_ROOMS
  delete process.env.SERVER_ADMINS
})

test('boolean settings', () => {
  expect(booleanSetting('SKIP_EMPTY_ROOMS', true)).toBe(true)
  process.env.SKIP_EMPTY_ROOMS = ' Yes '
  expect(shouldSkipEmptyRooms()).toBe(true)
  process.env.SKIP_EMPTY_ROOMS = 'false'
  expect(shouldSkipEmptyRooms()).toBe(false)
  process.env.SKIP_EMPTY_ROOMS = 'oui'
  expect(() => shouldSkipEmptyRooms()).toThrow(
    "SKIP_EMPTY_ROOMS='oui' is not a valid value: use true or false"
  )
})

test('server admin entries', () => {
  expect(getServerAdminEntries()).toStrictEqual([])
  expect(serverAdminsListed()).toBe(false)
  process.env.SERVER_ADMINS = ''
  expect(serverAdminsListed()).toBe(true)
  expect(getServerAdminEntries()).toStrictEqual([])
  process.env.SERVER_ADMINS = ' jdupont, @mmartin:example.org,,'
  expect(getServerAdminEntries()).toStrictEqual([
    'jdupont',
    '@mmartin:example.org',
  ])
})
