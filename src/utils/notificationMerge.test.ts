import { describe, expect, it } from 'vitest'
import { appendUniqueNotifications, mergeNotificationFirstPage } from './notificationMerge'

describe('notification pagination merge', () => {
  it('puts first-page updates first, replaces same ids, and preserves history order', () => {
    expect(mergeNotificationFirstPage(
      [{ id: 3, value: 'new' }, { id: 2, value: 'replacement' }],
      [{ id: 2, value: 'old' }, { id: 1, value: 'history' }],
    )).toEqual([
      { id: 3, value: 'new' }, { id: 2, value: 'replacement' }, { id: 1, value: 'history' },
    ])
  })

  it('dedupes load-more pages without changing existing order', () => {
    expect(appendUniqueNotifications(
      [{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }],
    )).toEqual([{ id: 3 }, { id: 2 }, { id: 1 }])
  })
})
