import { expect, jest, test } from '@jest/globals'
import {
  AxiosError,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
} from 'axios'
import log from '../helpers/logger'
import * as storage from '../helpers/storage'
import * as tuwunel from '../helpers/tuwunel'
import { setPinnedMessages } from './pinnedMessages'

jest.mock('../helpers/storage')
const mockedStorage = storage as jest.Mocked<typeof storage>

jest.mock('../helpers/tuwunel')
const mockedTuwunel = tuwunel as jest.Mocked<typeof tuwunel>

const state = (pinned?: string[]) => ({
  data: {
    state: pinned
      ? [{ type: 'm.room.pinned_events', state_key: '', content: { pinned } }]
      : [],
  },
})

test('pinned messages already set are not sent again', async () => {
  // e.g. a run resumed after the E2EE phase, the admin left the room
  mockedTuwunel.axios.get.mockReset()
  mockedTuwunel.axios.put.mockReset()
  mockedTuwunel.axios.get.mockResolvedValueOnce(state(['$a', '$b']))
  await expect(
    setPinnedMessages({ '!room': ['$a', '$b'] })
  ).resolves.toBeUndefined()
  expect(mockedTuwunel.axios.put).not.toHaveBeenCalled()
})

test('pinned messages are set, a refusal does not stop the migration', async () => {
  const warn = jest.spyOn(log, 'warn')
  mockedTuwunel.axios.get.mockReset()
  mockedTuwunel.axios.put.mockReset()
  mockedStorage.getMappingByMatrixId.mockResolvedValue(null)
  mockedTuwunel.axios.get
    .mockResolvedValueOnce(state()) // !new: nothing pinned yet
    .mockResolvedValueOnce({ data: { creator: '@admin:matrix' } })
    .mockResolvedValueOnce(state(['$old'])) // !left: admin has left
    .mockResolvedValueOnce({ data: { creator: '@admin:matrix' } })
  mockedTuwunel.axios.put
    .mockResolvedValueOnce({ data: {} })
    .mockRejectedValueOnce(
      new AxiosError('nah', '403', undefined, undefined, {
        data: { errcode: 'M_FORBIDDEN', error: 'not in room' },
        status: 403,
        statusText: 'nah',
        headers: {} as AxiosResponseHeaders,
        config: {} as InternalAxiosRequestConfig,
      })
    )
  await expect(
    setPinnedMessages({ '!new': ['$a'], '!left': ['$b'] })
  ).resolves.toBeUndefined()
  expect(mockedTuwunel.axios.put).toHaveBeenCalledWith(
    '/_matrix/client/v3/rooms/!new/state/m.room.pinned_events/',
    { pinned: ['$a'] },
    {}
  )
  expect(warn).toHaveBeenCalledWith(
    'Could not pin the messages of room !left (not in room), skipping.'
  )
})
