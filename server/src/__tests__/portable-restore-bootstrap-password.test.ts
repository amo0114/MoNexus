import { describe, expect, it } from 'vitest'
import { api } from './helpers.js'
import { prisma } from '../lib/prisma.js'

// The restore bootstrap creates an admin; it must use the same password policy as every other password write.
describe('portable restore bootstrap admin password policy', () => {
  it('rejects a long but weak password with a field reason before any other check', async () => {
    const res = await api
      .post('/api/portable-restore/bootstrap/admin')
      .send({ token: 'not-a-real-token', email: 'restore-admin@test.local', password: 'password1234' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.details).toContainEqual(expect.objectContaining({ field: 'body.password' }))
    expect(await prisma.user.count()).toBe(0)
  })
})
