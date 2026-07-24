import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'

describe('portable backup admin routes', () => {
  it('requires an authenticated active administrator before any backup operation', async () => {
    await api
      .post('/api/admin/portable-backups/export')
      .send({ passphrase: 'correct horse battery staple' })
      .expect(401)

    await createTestUser('portable-backup-user@test.local', 'user-password', 'user')
    const userLogin = await loginAs('portable-backup-user@test.local', 'user-password')
    await api
      .post('/api/admin/portable-backups/export')
      .set(authHeader(userLogin.accessToken))
      .send({ passphrase: 'correct horse battery staple' })
      .expect(403)
  })

  it('validates the export passphrase before any backup process starts', async () => {
    await createTestUser('portable-backup-admin@test.local', 'admin-password', 'admin')
    const adminLogin = await loginAs('portable-backup-admin@test.local', 'admin-password')

    const response = await api
      .post('/api/admin/portable-backups/export')
      .set(authHeader(adminLogin.accessToken))
      .send({ passphrase: 'short' })
      .expect(400)

    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })
})
