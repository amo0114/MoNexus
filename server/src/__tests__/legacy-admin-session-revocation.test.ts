import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { createTestUser } from './helpers.js'
import {
  LEGACY_ADMIN_SESSION_REVOKE_REASON,
  revokeLegacyAdminRefreshSessions,
} from '../modules/auth/legacyAdminSessionRevocation.js'

describe('revokeLegacyAdminRefreshSessions', () => {
  it('revokes only admin sessions created before the deployment cutoff and is idempotent', async () => {
    const { user: legacyAdmin } = await createTestUser('legacy-admin@test.local', 'testpass123', 'admin')
    const { user: newerAdmin } = await createTestUser('new-admin@test.local', 'testpass123', 'admin')
    const { user: normalUser } = await createTestUser('normal-user@test.local')
    const cutoff = new Date('2026-07-27T00:00:00.000Z')
    const expiresAt = new Date('2026-08-01T00:00:00.000Z')

    const [legacy, newer, normal] = await Promise.all([
      prisma.refreshToken.create({
        data: {
          userId: legacyAdmin.id,
          tokenHash: 'legacy-admin-refresh',
          expiresAt,
          createdAt: new Date('2026-07-26T23:59:59.000Z'),
        },
      }),
      prisma.refreshToken.create({
        data: {
          userId: newerAdmin.id,
          tokenHash: 'new-admin-refresh',
          expiresAt,
          createdAt: cutoff,
        },
      }),
      prisma.refreshToken.create({
        data: {
          userId: normalUser.id,
          tokenHash: 'normal-user-refresh',
          expiresAt,
          createdAt: new Date('2026-07-26T23:59:59.000Z'),
        },
      }),
    ])

    // A one-row batch proves the command is safe to run against a large
    // legacy population without depending on a single bulk update.
    expect(await revokeLegacyAdminRefreshSessions({ before: cutoff, now: cutoff, batchSize: 1 })).toBe(1)
    expect(await revokeLegacyAdminRefreshSessions({ before: cutoff, now: cutoff })).toBe(0)

    const tokens = await prisma.refreshToken.findMany({
      where: { id: { in: [legacy.id, newer.id, normal.id] } },
      orderBy: { id: 'asc' },
    })

    expect(tokens.find(token => token.id === legacy.id)).toMatchObject({
      revoked: true,
      revokeReason: LEGACY_ADMIN_SESSION_REVOKE_REASON,
      revokedAt: cutoff,
    })
    expect(tokens.find(token => token.id === newer.id)).toMatchObject({ revoked: false, revokedAt: null })
    expect(tokens.find(token => token.id === normal.id)).toMatchObject({ revoked: false, revokedAt: null })
  })

  it('rejects an invalid batch size before it can issue a database query', async () => {
    await expect(revokeLegacyAdminRefreshSessions({ before: new Date(), batchSize: 0 }))
      .rejects.toThrow('batchSize must be a positive integer')
  })

  it('refuses a future cutoff so an operator cannot revoke a later deployment session', async () => {
    const now = new Date('2026-07-27T00:00:00.000Z')
    await expect(revokeLegacyAdminRefreshSessions({ before: new Date('2026-07-27T00:00:01.000Z'), now }))
      .rejects.toThrow('before must not be in the future')
  })
})
