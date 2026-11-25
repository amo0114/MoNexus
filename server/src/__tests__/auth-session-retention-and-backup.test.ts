import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { createTestMerchant, createTestProduct, createTestUser } from './helpers.js'
import { hashRefreshToken } from '../modules/auth/sessionIssuance.js'
import {
  cleanupExpiredRefreshTokenFamilies,
  scrubLegacyFileGrantUserAgents,
  scrubLegacyRefreshTokenMetadata,
} from '../modules/auth/sessionRetentionCron.js'
import { dumpDatabase } from '../modules/portable-backups/service.js'
import { runProgram } from '../modules/portable-backups/archive.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('session retention, legacy PII scrub, and portable backup exclusion', () => {
  it('deletes only fully expired families past 30d grace and advances cursor past active families', async () => {
    const { user } = await createTestUser('retention-family@test.local', 'Ret#Pass-2026')
    const now = new Date('2026-11-25T12:00:00.000Z')
    const activeFamilyId = crypto.randomUUID()
    const deadFamilyId = crypto.randomUUID()
    const withinGraceFamilyId = crypto.randomUUID()

    // Active family has 4 ancient rotated predecessors (older than the dead family!)
    // plus one still-active successor. With batchSize=2, cleanup must advance past
    // those predecessors and still delete deadFamilyId without deleting any row of activeFamilyId.
    for (let i = 0; i < 4; i += 1) {
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          sessionId: activeFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(now.getTime() - (60 - i) * DAY_MS),
          revokeReason: 'refresh_rotation',
          expiresAt: new Date(now.getTime() - (55 - i) * DAY_MS),
          deviceLabel: 'Chrome · macOS',
          ipHint: '203.0.113.*',
        },
      })
    }
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: activeFamilyId,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        revoked: false,
        expiresAt: new Date(now.getTime() + 5 * DAY_MS),
        absoluteExpiresAt: new Date(now.getTime() + 20 * DAY_MS),
        deviceLabel: 'Chrome · macOS',
        ipHint: '203.0.113.*',
      },
    })

    // Dead family: every row expired > 30 days ago.
    await prisma.refreshToken.createMany({
      data: [
        {
          userId: user.id,
          sessionId: deadFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(now.getTime() - 45 * DAY_MS),
          revokeReason: 'refresh_rotation',
          expiresAt: new Date(now.getTime() - 40 * DAY_MS),
          deviceLabel: 'Firefox · Windows',
          ipHint: '198.51.100.*',
        },
        {
          userId: user.id,
          sessionId: deadFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(now.getTime() - 35 * DAY_MS),
          revokeReason: 'logout',
          expiresAt: new Date(now.getTime() - 31 * DAY_MS),
          deviceLabel: 'Firefox · Windows',
          ipHint: '198.51.100.*',
        },
      ],
    })

    // Family within 30d grace: predecessor expired 35d ago, latest row expired 10d ago -> must stay!
    await prisma.refreshToken.createMany({
      data: [
        {
          userId: user.id,
          sessionId: withinGraceFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(now.getTime() - 35 * DAY_MS),
          revokeReason: 'refresh_rotation',
          expiresAt: new Date(now.getTime() - 35 * DAY_MS),
          deviceLabel: 'Safari · iOS',
          ipHint: 'IPv6 地址',
        },
        {
          userId: user.id,
          sessionId: withinGraceFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(now.getTime() - 10 * DAY_MS),
          revokeReason: 'expired',
          expiresAt: new Date(now.getTime() - 10 * DAY_MS),
          deviceLabel: 'Safari · iOS',
          ipHint: 'IPv6 地址',
        },
      ],
    })

    const result = await cleanupExpiredRefreshTokenFamilies({ now, batchSize: 2 })
    expect(result.familiesDeleted).toBe(1)
    expect(result.rowsDeleted).toBe(2)

    expect(await prisma.refreshToken.count({ where: { sessionId: deadFamilyId } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: activeFamilyId } })).toBe(5)
    expect(await prisma.refreshToken.count({ where: { sessionId: withinGraceFamilyId } })).toBe(2)
  })

  it('scrubs legacy RefreshToken raw IP/UA and FileGrantLog raw UA in idempotent primary-key batches', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('scrub-m@test.local', 'Scrub#Pass-2026', {
      role: 'merchant',
      status: 'active',
    })
    const product = await createTestProduct('脱敏测试商品', 100, 1, ['inv-s1'], merchant.id)
    const file = await prisma.deliveryFile.create({
      data: {
        key: 'delivery/scrub/test-1',
        fileName: 'scrub.zip',
        size: 128,
        mimeType: 'application/zip',
        sha256: 'b'.repeat(64),
        merchantId: merchant.id,
      },
    })
    const order = await prisma.order.create({
      data: { userId: merchantUser.id, productId: product.id, price: 100, status: 'delivered', merchantId: merchant.id },
    })

    const legacyToken = await prisma.refreshToken.create({
      data: {
        userId: merchantUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        expiresAt: new Date(Date.now() + DAY_MS),
        ip: '::ffff:203.0.113.88',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.48',
        deviceLabel: null,
        ipHint: null,
      },
    })

    // Seed several already-whitelisted FileGrantLog rows ahead of legacy raw rows to prove
    // bounded batching still skips clean rows in SQL and reaches the legacy tail.
    for (let i = 0; i < 4; i += 1) {
      await prisma.fileGrantLog.create({
        data: {
          fileId: file.id,
          orderId: order.id,
          userId: merchantUser.id,
          role: 'buyer',
          outcome: 'granted',
          ipHash: 'h-clean',
          userAgent: 'Chrome · macOS',
        },
      })
    }
    const legacyGrantKnown = await prisma.fileGrantLog.create({
      data: {
        fileId: file.id,
        orderId: order.id,
        userId: merchantUser.id,
        role: 'buyer',
        outcome: 'granted',
        ipHash: 'h-legacy-1',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0',
      },
    })
    const legacyGrantUnknown = await prisma.fileGrantLog.create({
      data: {
        fileId: file.id,
        orderId: order.id,
        userId: merchantUser.id,
        role: 'buyer',
        outcome: 'denied_window',
        ipHash: 'h-legacy-2',
        userAgent: 'CustomDownloader/2.1',
      },
    })

    expect(await scrubLegacyRefreshTokenMetadata({ batchSize: 1, maxBatches: 10 })).toBe(1)
    expect(await scrubLegacyRefreshTokenMetadata({ batchSize: 1, maxBatches: 10 })).toBe(0)

    const scrubbedToken = await prisma.refreshToken.findUniqueOrThrow({ where: { id: legacyToken.id } })
    expect(scrubbedToken.ip).toBeNull()
    expect(scrubbedToken.userAgent).toBeNull()
    expect(scrubbedToken.deviceLabel).toBe('WeChat · iOS')
    expect(scrubbedToken.ipHint).toBe('203.0.113.*')

    expect(await scrubLegacyFileGrantUserAgents({ batchSize: 1, maxBatches: 5 })).toBe(2)
    expect(await scrubLegacyFileGrantUserAgents({ batchSize: 1, maxBatches: 5 })).toBe(0)

    const [grant1, grant2] = await Promise.all([
      prisma.fileGrantLog.findUniqueOrThrow({ where: { id: legacyGrantKnown.id } }),
      prisma.fileGrantLog.findUniqueOrThrow({ where: { id: legacyGrantUnknown.id } }),
    ])
    expect(grant1.userAgent).toBe('Firefox · Windows')
    expect(grant2.userAgent).toBe('浏览器会话')
  })

  it('excludes RefreshToken and AuthChallenge table data from pg_dump while preserving their schema DDL', async () => {
    const { user } = await createTestUser('backup-exclude@test.local', 'Backup#Pass-2026')
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken('backup-canary-refresh-token'),
        expiresAt: new Date(Date.now() + DAY_MS),
        deviceLabel: 'Chrome · macOS',
        ipHint: '203.0.113.*',
      },
    })
    await prisma.authChallenge.create({
      data: {
        userId: user.id,
        purpose: 'admin_enroll',
        secretEncrypted: 'backup-canary-secret-ciphertext',
        expiresAt: new Date(Date.now() + 300_000),
      },
    })

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'monexus-backup-exclude-'))
    const dumpPath = path.join(tmpDir, 'database.dump')
    try {
      await dumpDatabase(dumpPath)
      const toc = await runProgram('pg_restore', ['--list', dumpPath])

      // Schema DDL for both tables must remain present so restore creates the tables cleanly.
      expect(toc).toMatch(/TABLE public RefreshToken/)
      expect(toc).toMatch(/TABLE public AuthChallenge/)
      // Business data like User must still be exported.
      expect(toc).toMatch(/TABLE DATA public User/)
      // Ephemeral auth credentials must NOT have TABLE DATA entries in the dump.
      expect(toc).not.toMatch(/TABLE DATA public RefreshToken/)
      expect(toc).not.toMatch(/TABLE DATA public AuthChallenge/)
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('backfill SQL tightens legacy active admin sessions to 7d absolute cap without evicting non-admin active sessions', async () => {
    const { user: normalUser } = await createTestUser('backfill-user@test.local', 'Backfill#U2026')
    const { user: adminUser } = await createTestUser('backfill-admin@test.local', 'Backfill#A2026', 'admin')
    const now = Date.now()

    const userStandard = await prisma.refreshToken.create({
      data: {
        userId: normalUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(now - 5 * DAY_MS),
        expiresAt: new Date(now + 2 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })
    const userLongExpiry = await prisma.refreshToken.create({
      data: {
        userId: normalUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(now - 5 * DAY_MS),
        expiresAt: new Date(now + 40 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })
    const adminOverCap = await prisma.refreshToken.create({
      data: {
        userId: adminUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(now - 8 * DAY_MS),
        expiresAt: new Date(now + 3 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })

    const migrationSqlPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20261125100000_refresh_token_session_hardening/migration.sql',
    )
    const migrationSql = await fsp.readFile(migrationSqlPath, 'utf8')
    const updateStatements = migrationSql
      .split(';')
      .map(chunk => chunk
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n')
        .trim())
      .filter(statement => /^UPDATE\b/i.test(statement))
    expect(updateStatements).toHaveLength(2)
    for (const statement of updateStatements) {
      await prisma.$executeRawUnsafe(statement)
    }

    const [u1, u2, a1] = await Promise.all([
      prisma.refreshToken.findUniqueOrThrow({ where: { id: userStandard.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: userLongExpiry.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: adminOverCap.id } }),
    ])

    expect(u1.absoluteExpiresAt?.getTime()).toBe(userStandard.sessionStartedAt.getTime() + 30 * DAY_MS)
    expect(u1.expiresAt.getTime()).toBe(userStandard.expiresAt.getTime())

    expect(u2.absoluteExpiresAt?.getTime()).toBe(userLongExpiry.expiresAt.getTime())
    expect(u2.expiresAt.getTime()).toBe(userLongExpiry.expiresAt.getTime())

    const expectedAdminCap = adminOverCap.sessionStartedAt.getTime() + 7 * DAY_MS
    expect(a1.absoluteExpiresAt?.getTime()).toBe(expectedAdminCap)
    expect(a1.expiresAt.getTime()).toBe(expectedAdminCap)
    expect(a1.expiresAt.getTime()).toBeLessThan(now)
  })
})
