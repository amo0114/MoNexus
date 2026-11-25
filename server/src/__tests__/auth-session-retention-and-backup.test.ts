import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, createTestMerchant, createTestProduct, createTestUser } from './helpers.js'
import { refreshTokenCookieName } from '../lib/cookies.js'
import { hashRefreshToken } from '../modules/auth/sessionIssuance.js'
import {
  lockUserRefreshSessionMutations,
  revokeAllUserRefreshTokens,
} from '../modules/auth/sessionService.js'
import {
  backfillLegacyRefreshTokenAbsoluteExpiry,
  cleanupExpiredRefreshTokenFamilies,
  scrubLegacyFileGrantUserAgents,
  scrubLegacyRefreshTokenMetadata,
} from '../modules/auth/sessionRetentionCron.js'
import { dumpDatabase, filterRestoreTocList } from '../modules/portable-backups/service.js'
import { runProgram } from '../modules/portable-backups/archive.js'
import { config } from '../config/index.js'

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

    // Even with maxRowsScanned=2 and maxFamiliesPerRun=1, persisting the exact
    // last-processed cursor across runs must advance past activeFamilyId's 4 older
    // predecessors and delete deadFamilyId on cycle 3 without cross-run starvation.
    const cycle1 = await cleanupExpiredRefreshTokenFamilies({
      now,
      batchSize: 2,
      maxFamiliesPerRun: 1,
      maxRowsScanned: 2,
    })
    expect(cycle1.rowsScanned).toBe(2)
    expect(cycle1.familiesChecked).toBe(0)
    expect(cycle1.familiesDeleted).toBe(0)
    expect(cycle1.nextCursor).not.toBeNull()

    const cycle2 = await cleanupExpiredRefreshTokenFamilies({
      now,
      batchSize: 2,
      maxFamiliesPerRun: 1,
      maxRowsScanned: 2,
    })
    expect(cycle2.rowsScanned).toBe(2)
    expect(cycle2.familiesChecked).toBe(0)
    expect(cycle2.familiesDeleted).toBe(0)
    expect(cycle2.nextCursor).not.toBeNull()

    const cycle3 = await cleanupExpiredRefreshTokenFamilies({
      now,
      batchSize: 2,
      maxFamiliesPerRun: 1,
      maxRowsScanned: 2,
    })
    expect(cycle3.familiesChecked).toBe(1)
    expect(cycle3.familiesDeleted).toBe(1)
    expect(cycle3.rowsDeleted).toBe(2)

    expect(await prisma.refreshToken.count({ where: { sessionId: deadFamilyId } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: activeFamilyId } })).toBe(5)
    expect(await prisma.refreshToken.count({ where: { sessionId: withinGraceFamilyId } })).toBe(2)

    // Subsequent run reaches the tail and wraps cursor cleanly back to null,
    // allowing a newly aged-out dead family earlier in (expiresAt, id) order to be deleted.
    const earlierDeadFamilyId = crypto.randomUUID()
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: earlierDeadFamilyId,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        revoked: true,
        revokedAt: new Date(now.getTime() - 70 * DAY_MS),
        revokeReason: 'logout',
        expiresAt: new Date(now.getTime() - 70 * DAY_MS),
        deviceLabel: 'Chrome · macOS',
        ipHint: '203.0.113.*',
      },
    })
    const cycle4 = await cleanupExpiredRefreshTokenFamilies({
      now,
      batchSize: 10,
      maxFamiliesPerRun: 5,
      maxRowsScanned: 100,
    })
    expect(cycle4.familiesDeleted).toBe(1)
    expect(cycle4.nextCursor).toBeNull()
    expect(await prisma.refreshToken.count({ where: { sessionId: earlierDeadFamilyId } })).toBe(0)
  })

  it('forces sweep wrap-around at fixed sweepCutoff under continuous daily budget saturation so backfilled families behind cursor are deleted in finite runs', async () => {
    const { user: admin } = await createTestUser('sweep-wrap-admin@test.local', 'Sweep#A2026', 'admin')
    const { user: member } = await createTestUser('sweep-wrap-user@test.local', 'Sweep#U2026')
    const day0 = new Date('2026-11-25T12:00:00.000Z')
    const cutoff0Ms = day0.getTime() - 30 * DAY_MS

    // Legacy admin family whose older rotated row sits before the initial cursor
    // and whose active row is still alive at day0, so it is ineligible on day0.
    // After backfill tightens the active row to sessionStartedAt + 7d (< cutoff0
    // and behind the saved cursor), the entire family becomes eligible.
    const adminBackfilledFamilyId = crypto.randomUUID()
    await prisma.refreshToken.createMany({
      data: [
        {
          userId: admin.id,
          sessionId: adminBackfilledFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          sessionStartedAt: new Date(cutoff0Ms - 25 * DAY_MS),
          revoked: true,
          revokedAt: new Date(cutoff0Ms - 22 * DAY_MS),
          revokeReason: 'refresh_rotation',
          expiresAt: new Date(cutoff0Ms - 20 * DAY_MS),
          absoluteExpiresAt: null,
        },
        {
          userId: admin.id,
          sessionId: adminBackfilledFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          sessionStartedAt: new Date(cutoff0Ms - 25 * DAY_MS),
          revoked: false,
          expiresAt: new Date(day0.getTime() + 5 * DAY_MS),
          absoluteExpiresAt: null,
        },
      ],
    })

    // Two eligible families already past cutoff0 on day0.
    const initialFamily1 = crypto.randomUUID()
    const initialFamily2 = crypto.randomUUID()
    for (const [sessionId, offsetDays] of [
      [initialFamily1, 15],
      [initialFamily2, 10],
    ] as const) {
      await prisma.refreshToken.create({
        data: {
          userId: member.id,
          sessionId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(cutoff0Ms - offsetDays * DAY_MS),
          revokeReason: 'logout',
          expiresAt: new Date(cutoff0Ms - offsetDays * DAY_MS),
        },
      })
    }

    // Day 0: skips adminBackfilledFamilyId (ineligible), deletes initialFamily1,
    // saturates maxFamiliesPerRun=1, and persists fixed sweepCutoff = cutoff0.
    const run0 = await cleanupExpiredRefreshTokenFamilies({
      now: day0,
      batchSize: 1,
      maxFamiliesPerRun: 1,
      maxRowsScanned: 5,
    })
    expect(run0.familiesDeleted).toBe(1)
    expect(run0.nextCursor).not.toBeNull()
    expect(await prisma.refreshToken.count({ where: { sessionId: initialFamily1 } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: adminBackfilledFamilyId } })).toBe(2)

    const savedAfterRun0 = await prisma.authSessionRetentionCursor.findUniqueOrThrow({
      where: { key: 'refresh_token_cleanup' },
    })
    expect(savedAfterRun0.sweepCutoff?.getTime()).toBe(cutoff0Ms)

    // Online admin backfill now tightens adminBackfilledFamilyId's active row to
    // cutoff0 - 18d (strictly behind saved cursor at cutoff0 - 15d).
    expect(await backfillLegacyRefreshTokenAbsoluteExpiry({ now: day0, batchSize: 10, maxBatches: 5 })).toBe(1)

    // Simulate 5 consecutive days where a brand-new family expires past cutoff0
    // every single day (saturating the 1-family/run budget indefinitely if the
    // sweep boundary kept sliding with each day's cutoff).
    const rollingNewFamilies: string[] = []
    for (let day = 1; day <= 5; day += 1) {
      const nowDay = new Date(day0.getTime() + day * DAY_MS)
      const newFamilyId = crypto.randomUUID()
      rollingNewFamilies.push(newFamilyId)
      await prisma.refreshToken.create({
        data: {
          userId: member.id,
          sessionId: newFamilyId,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          revoked: true,
          revokedAt: new Date(cutoff0Ms + (day - 0.5) * DAY_MS),
          revokeReason: 'logout',
          expiresAt: new Date(cutoff0Ms + (day - 0.5) * DAY_MS),
        },
      })

      const run = await cleanupExpiredRefreshTokenFamilies({
        now: nowDay,
        batchSize: 1,
        maxFamiliesPerRun: 1,
        maxRowsScanned: 5,
      })
      expect(run.familiesDeleted).toBe(1)
    }

    // Day 1 deletes initialFamily2 (reaching cutoff0); Day 2 hits empty past cutoff0,
    // wraps to head with new sweepCutoff, and deletes both rows of adminBackfilledFamilyId!
    expect(await prisma.refreshToken.count({ where: { sessionId: initialFamily2 } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: adminBackfilledFamilyId } })).toBe(0)
    // Subsequent days continue draining the newly expired families in order.
    expect(await prisma.refreshToken.count({ where: { sessionId: rollingNewFamilies[0]! } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: rollingNewFamilies[1]! } })).toBe(0)
    expect(await prisma.refreshToken.count({ where: { sessionId: rollingNewFamilies[2]! } })).toBe(0)
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

      // Also verify legacy-dump restore filtering (`pg_restore --use-list`): take
      // an UNFILTERED dump (simulating a pre-upgrade backup that still holds
      // RefreshToken & AuthChallenge rows), filter its TOC, and prove `pg_restore`
      // generates table DDL + User data with ZERO COPY data for either auth table.
      const legacyDumpPath = path.join(tmpDir, 'legacy.dump')
      const url = new URL(config.databaseUrl)
      const password = decodeURIComponent(url.password)
      url.password = ''
      url.searchParams.delete('schema')
      const pgEnv = { ...process.env, ...(password ? { PGPASSWORD: password } : {}) }
      await runProgram('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file', legacyDumpPath,
        '--dbname', url.toString(),
      ], { env: pgEnv })

      const legacyToc = await runProgram('pg_restore', ['--list', legacyDumpPath], { env: pgEnv })
      expect(legacyToc).toMatch(/TABLE DATA public RefreshToken/)
      expect(legacyToc).toMatch(/TABLE DATA public AuthChallenge/)

      const filteredToc = filterRestoreTocList(legacyToc)
      expect(filteredToc).toMatch(/TABLE public RefreshToken/)
      expect(filteredToc).toMatch(/TABLE public AuthChallenge/)
      expect(filteredToc).toMatch(/TABLE DATA public User/)
      expect(filteredToc).not.toMatch(/TABLE DATA public RefreshToken/)
      expect(filteredToc).not.toMatch(/TABLE DATA public AuthChallenge/)

      const listPath = path.join(tmpDir, 'restore.list')
      const sqlPath = path.join(tmpDir, 'restore.sql')
      await fsp.writeFile(listPath, filteredToc, { mode: 0o600 })
      await runProgram('pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--use-list', listPath,
        '--file', sqlPath,
        legacyDumpPath,
      ], { env: pgEnv })
      const restoreSql = await fsp.readFile(sqlPath, 'utf8')
      expect(restoreSql).toMatch(/CREATE TABLE public\."RefreshToken"/)
      expect(restoreSql).toMatch(/CREATE TABLE public\."AuthChallenge"/)
      expect(restoreSql).toMatch(/COPY public\."User"/)
      expect(restoreSql).not.toMatch(/COPY public\."RefreshToken"/)
      expect(restoreSql).not.toMatch(/COPY public\."AuthChallenge"/)
      expect(restoreSql).not.toContain('backup-canary-secret-ciphertext')
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps DDL migration free of table-locking UPDATEs and backfills legacy active rows online in PK batches', async () => {
    const migrationSqlPath = path.resolve(
      __dirname,
      '../../prisma/migrations/20261125100000_refresh_token_session_hardening/migration.sql',
    )
    const migrationSql = await fsp.readFile(migrationSqlPath, 'utf8')
    const nonCommentSql = migrationSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
    expect(nonCommentSql).toMatch(/ALTER TABLE "RefreshToken"/)
    expect(nonCommentSql).not.toMatch(/\bUPDATE\b/i)

    const { user: normalUser } = await createTestUser('backfill-user@test.local', 'Backfill#U2026')
    const { user: adminUser } = await createTestUser('backfill-admin@test.local', 'Backfill#A2026', 'admin')
    const now = new Date('2026-11-25T12:00:00.000Z')
    const nowMs = now.getTime()

    const userStandard = await prisma.refreshToken.create({
      data: {
        userId: normalUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(nowMs - 5 * DAY_MS),
        expiresAt: new Date(nowMs + 2 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })
    const userLongExpiry = await prisma.refreshToken.create({
      data: {
        userId: normalUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(nowMs - 5 * DAY_MS),
        expiresAt: new Date(nowMs + 40 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })
    const userAlreadyExpired = await prisma.refreshToken.create({
      data: {
        userId: normalUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(nowMs - 20 * DAY_MS),
        expiresAt: new Date(nowMs - 1 * DAY_MS),
        revoked: false,
        absoluteExpiresAt: null,
      },
    })
    const adminOverCap = await prisma.refreshToken.create({
      data: {
        userId: adminUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(nowMs - 8 * DAY_MS),
        expiresAt: new Date(nowMs + 3 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })
    const adminWithinCap = await prisma.refreshToken.create({
      data: {
        userId: adminUser.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        sessionStartedAt: new Date(nowMs - 2 * DAY_MS),
        expiresAt: new Date(nowMs + 20 * DAY_MS),
        absoluteExpiresAt: null,
      },
    })

    // Run in small PK batches; already-expired legacy rows are skipped (4 active rows updated).
    expect(await backfillLegacyRefreshTokenAbsoluteExpiry({ now, batchSize: 1, maxBatches: 10 })).toBe(4)
    expect(await backfillLegacyRefreshTokenAbsoluteExpiry({ now, batchSize: 1, maxBatches: 10 })).toBe(0)

    const [u1, u2, uExpired, aOver, aWithin] = await Promise.all([
      prisma.refreshToken.findUniqueOrThrow({ where: { id: userStandard.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: userLongExpiry.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: userAlreadyExpired.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: adminOverCap.id } }),
      prisma.refreshToken.findUniqueOrThrow({ where: { id: adminWithinCap.id } }),
    ])

    expect(u1.absoluteExpiresAt?.getTime()).toBe(userStandard.sessionStartedAt.getTime() + 30 * DAY_MS)
    expect(u1.expiresAt.getTime()).toBe(userStandard.expiresAt.getTime())

    expect(u2.absoluteExpiresAt?.getTime()).toBe(userLongExpiry.expiresAt.getTime())
    expect(u2.expiresAt.getTime()).toBe(userLongExpiry.expiresAt.getTime())

    expect(uExpired.absoluteExpiresAt).toBeNull()

    const expectedOverCap = adminOverCap.sessionStartedAt.getTime() + 7 * DAY_MS
    expect(aOver.absoluteExpiresAt?.getTime()).toBe(expectedOverCap)
    expect(aOver.expiresAt.getTime()).toBe(expectedOverCap)
    expect(aOver.revoked).toBe(true)
    expect(aOver.revokeReason).toBe('expired')

    const expectedWithinCap = adminWithinCap.sessionStartedAt.getTime() + 7 * DAY_MS
    expect(aWithin.absoluteExpiresAt?.getTime()).toBe(expectedWithinCap)
    expect(aWithin.expiresAt.getTime()).toBe(expectedWithinCap)
    expect(aWithin.revoked).toBe(false)
  })

  it('produces identical refresh outcomes for legacy non-admin and admin sessions regardless of whether refresh or backfill runs first', async () => {
    const { user: userBefore } = await createTestUser('legacy-order-a@test.local', 'Order#A2026')
    const { user: userAfter } = await createTestUser('legacy-order-b@test.local', 'Order#B2026')
    const nowMs = Date.now()
    const started40dAgo = new Date(nowMs - 40 * DAY_MS)
    const expiresIn3d = new Date(nowMs + 3 * DAY_MS)

    const rawBefore = crypto.randomBytes(40).toString('hex')
    const rawAfter = crypto.randomBytes(40).toString('hex')
    await prisma.refreshToken.create({
      data: {
        userId: userBefore.id,
        tokenHash: hashRefreshToken(rawBefore),
        sessionStartedAt: started40dAgo,
        expiresAt: expiresIn3d,
        absoluteExpiresAt: null,
      },
    })
    await prisma.refreshToken.create({
      data: {
        userId: userAfter.id,
        tokenHash: hashRefreshToken(rawAfter),
        sessionStartedAt: started40dAgo,
        expiresAt: expiresIn3d,
        absoluteExpiresAt: null,
      },
    })

    // Order 1: refresh BEFORE backfill must still succeed (preserving existing 3d expiresAt).
    await api
      .post('/api/auth/refresh')
      .set('Cookie', [`${refreshTokenCookieName}=${rawBefore}`])
      .expect(200)
    const rotatedBefore = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: userBefore.id, revoked: false },
    })
    expect(rotatedBefore.absoluteExpiresAt?.getTime()).toBe(expiresIn3d.getTime())

    // Order 2: backfill FIRST, then refresh -> identical absoluteExpiresAt.
    expect(await backfillLegacyRefreshTokenAbsoluteExpiry({ batchSize: 10, maxBatches: 5 })).toBe(1)
    await api
      .post('/api/auth/refresh')
      .set('Cookie', [`${refreshTokenCookieName}=${rawAfter}`])
      .expect(200)
    const rotatedAfter = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: userAfter.id, revoked: false },
    })
    expect(rotatedAfter.absoluteExpiresAt?.getTime()).toBe(expiresIn3d.getTime())
  })

  it('serializes online backfill on the per-user advisory lock without deadlocking against revokeAllUserRefreshTokens', async () => {
    const { user: admin } = await createTestUser('backfill-lock-admin@test.local', 'Lock#A2026', 'admin')
    const nowMs = Date.now()

    await prisma.refreshToken.createMany({
      data: [
        {
          userId: admin.id,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          sessionStartedAt: new Date(nowMs - 8 * DAY_MS),
          expiresAt: new Date(nowMs + 3 * DAY_MS),
          absoluteExpiresAt: null,
        },
        {
          userId: admin.id,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          sessionStartedAt: new Date(nowMs - 1 * 60 * 60 * 1000),
          expiresAt: new Date(nowMs + 6 * DAY_MS),
          absoluteExpiresAt: new Date(nowMs + 7 * DAY_MS),
        },
      ],
    })

    // Hold the user's advisory lock while launching backfill; verify backfill waits
    // on the advisory lock (not row locks) before writing, then completes cleanly
    // alongside revokeAllUserRefreshTokens with zero deadlocks.
    let releaseLock!: () => void
    let lockAcquired!: () => void
    const lockHeld = new Promise<void>(resolve => { lockAcquired = resolve })
    const allowRelease = new Promise<void>(resolve => { releaseLock = resolve })

    const holder = prisma.$transaction(async tx => {
      await lockUserRefreshSessionMutations(tx, admin.id)
      lockAcquired()
      await allowRelease
    })
    await lockHeld

    const pendingBackfill = backfillLegacyRefreshTokenAbsoluteExpiry({ batchSize: 10, maxBatches: 5 })
    const pendingRevoke = revokeAllUserRefreshTokens(admin.id, undefined, 'revoke_all')

    let queuedLocks = 0
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${admin.id}::int4 AND NOT granted
      `
      queuedLocks = row?.count ?? 0
      if (queuedLocks >= 2) break
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    expect(queuedLocks).toBeGreaterThanOrEqual(2)

    releaseLock()
    await holder
    const [backfilledCount, revokedCount] = await Promise.all([pendingBackfill, pendingRevoke])
    expect(backfilledCount).toBeGreaterThanOrEqual(0)
    expect(revokedCount).toBe(1)
    expect(await prisma.refreshToken.count({ where: { userId: admin.id, revoked: false } })).toBe(0)
  })
})
