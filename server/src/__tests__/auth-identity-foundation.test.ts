import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { createTestUser } from './helpers.js'

const M3_MIGRATION_NAME = '20260727110000_identity_security_hardening'
const M3_MIGRATION_SHA256 = 'd7674f9747f7fdfd32e7272d678f45ce3b9e96d35fd59cbcbfab3c5ec441e55a'

describe('identity security schema foundation', () => {
  it('pins the generated M3 migration and its database defaults', async () => {
    const migrationSql = await readFile(
      path.resolve(process.cwd(), 'prisma', 'migrations', M3_MIGRATION_NAME, 'migration.sql'),
      'utf8'
    )

    expect(M3_MIGRATION_NAME > '20260727090000_p6a_subscription_foundation').toBe(true)
    expect(createHash('sha256').update(migrationSql).digest('hex')).toBe(M3_MIGRATION_SHA256)
    expect(migrationSql).toContain('"sessionId" UUID NOT NULL DEFAULT gen_random_uuid()')
    expect(migrationSql).toContain('"sessionStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(migrationSql).toContain('"lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP')

    const columns = await prisma.$queryRaw<Array<{
      column_name: string
      is_nullable: string
      column_default: string | null
    }>>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'RefreshToken'
        AND column_name IN ('sessionId', 'sessionStartedAt', 'lastUsedAt')
    `

    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ column_name: 'sessionId', is_nullable: 'NO', column_default: expect.stringContaining('gen_random_uuid') }),
      expect.objectContaining({ column_name: 'sessionStartedAt', is_nullable: 'NO', column_default: expect.stringContaining('CURRENT_TIMESTAMP') }),
      expect.objectContaining({ column_name: 'lastUsedAt', is_nullable: 'NO', column_default: expect.stringContaining('CURRENT_TIMESTAMP') }),
    ]))

    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'RefreshToken'
    `
    expect(indexes.some(({ indexdef }) => /UNIQUE INDEX.*\("sessionId"\)/.test(indexdef))).toBe(false)
  })

  it('assigns a unique database-generated session family to new refresh tokens', async () => {
    const { user } = await createTestUser('identity-session-default@test.local')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    const [first, second] = await Promise.all([
      prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: 'identity-session-default-first', expiresAt },
      }),
      prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: 'identity-session-default-second', expiresAt },
      }),
    ])

    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(second.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.sessionStartedAt).toBeInstanceOf(Date)
    expect(first.lastUsedAt).toBeInstanceOf(Date)
  })

  it('initializes MFA fields with safe defaults', async () => {
    const { user } = await createTestUser('identity-user-default@test.local')
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    expect(stored.mfaEnabled).toBe(false)
    expect(stored.mfaSecretEncrypted).toBeNull()
    expect(stored.mfaVersion).toBe(0)
  })
})
