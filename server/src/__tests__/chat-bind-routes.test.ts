import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

describe('website chat-bind routes', () => {
  it('requires a signed-in user', async () => {
    await api.get('/api/points/chat-bind/status').expect(401)
    await api.delete('/api/points/chat-bind').expect(401)
  })

  it('reaches the bind controller for the current user', async () => {
    await createTestUser('chat-bind-routes@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs('chat-bind-routes@test.local', 'pass123')

    const status = await api.get('/api/points/chat-bind/status').set(authHeader(accessToken)).expect(200)
    expect(status.body).toMatchObject({ bound: false, platform: null })
    // An unbound user gets the controller's business 404, not an unmatched route.
    const removed = await api.delete('/api/points/chat-bind').set(authHeader(accessToken)).expect(404)
    expect(JSON.stringify(removed.body)).toContain('尚未绑定')
  })
})
