import { Client } from 'pg'
import type { Response } from 'supertest'
import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { lockUserRefreshSessionMutations } from '../modules/auth/sessionService.js'

function decodeSessionId(accessToken: string): string {
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'))
  if (typeof claims.sid !== 'string') throw new Error('Missing test access-token session identity')
  return claims.sid
}

function createGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function waitForAnnouncementLockWaiters(requiredCount: number) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const [result] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Announcement"%'
        AND cardinality(pg_blocking_pids(pid)) > 0
    `
    if (result.count >= requiredCount) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Announcement requests did not reach real PostgreSQL lock waiting')
}

async function waitForSessionLockWaiters(userId: number, requiredCount: number) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const [result] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${userId}::int4 AND NOT granted
    `
    if (result.count >= requiredCount) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Session requests did not reach real PostgreSQL advisory lock waiting')
}

async function createAnnouncementFixture() {
  const account = await createTestUser('announcement-concurrency@test.local', 'concurrency-password')
  const session = await loginAs(account.user.email, account.password)
  const announcement = await prisma.announcement.create({
    data: {
      title: 'Concurrency fixture',
      content: 'Displayed version one',
      audience: 'user',
      presentation: 'acknowledgement_required',
      status: 'published',
      startsAt: new Date(Date.now() - 60_000),
      version: 1,
    },
  })
  return { userId: account.user.id, accessToken: session.accessToken, announcement }
}

describe('notification remediation announcement concurrency gates', () => {
  it.each(['read', 'acknowledge'])('rejects stale %s after waiting for an uncommitted new version', async (operation) => {
    const fixture = await createAnnouncementFixture()
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    let requestPromise: Promise<Response> | undefined
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('UPDATE "Announcement" SET "version" = 2, "content" = $2 WHERE "id" = $1', [fixture.announcement.id, 'Updated version two'])
      requestPromise = api.post(`/api/announcements/${fixture.announcement.id}/${operation}`)
        .set(authHeader(fixture.accessToken)).send({ version: 1 }).then((response) => response)
      await waitForAnnouncementLockWaiters(1)
      await blocker.query('COMMIT')
      const response = await requestPromise
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('ANNOUNCEMENT_VERSION_CHANGED')
      expect(await prisma.announcementReceipt.count({ where: { announcementId: fixture.announcement.id } })).toBe(0)
      expect((await prisma.announcement.findUniqueOrThrow({ where: { id: fixture.announcement.id } })).version).toBe(2)
    } finally {
      try {
        await blocker.query('ROLLBACK')
        if (requestPromise) await Promise.allSettled([requestPromise])
      } finally {
        await blocker.end()
      }
    }
  })

  it.each(['archive', 'expire'])('rechecks visibility after waiting for an uncommitted %s', async (operation) => {
    const fixture = await createAnnouncementFixture()
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    let requestPromise: Promise<Response> | undefined
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      if (operation === 'archive') {
        await blocker.query('UPDATE "Announcement" SET "status" = $2 WHERE "id" = $1', [fixture.announcement.id, 'archived'])
      } else {
        await blocker.query('UPDATE "Announcement" SET "endsAt" = $2 WHERE "id" = $1', [fixture.announcement.id, new Date(Date.now() - 1_000)])
      }
      requestPromise = api.post(`/api/announcements/${fixture.announcement.id}/acknowledge`)
        .set(authHeader(fixture.accessToken)).send({ version: 1 }).then((response) => response)
      await waitForAnnouncementLockWaiters(1)
      await blocker.query('COMMIT')
      const response = await requestPromise
      expect(response.status).toBe(404)
      expect(await prisma.announcementReceipt.count({ where: { announcementId: fixture.announcement.id } })).toBe(0)
    } finally {
      try {
        await blocker.query('ROLLBACK')
        if (requestPromise) await Promise.allSettled([requestPromise])
      } finally {
        await blocker.end()
      }
    }
  })

  it('serializes concurrent confirmations into one receipt with one first timestamp', async () => {
    const fixture = await createAnnouncementFixture()
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    const requests: Array<Promise<Response>> = []
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT "id" FROM "Announcement" WHERE "id" = $1 FOR UPDATE', [fixture.announcement.id])
      for (let requestIndex = 0; requestIndex < 4; requestIndex++) {
        requests.push(api.post(`/api/announcements/${fixture.announcement.id}/acknowledge`)
          .set(authHeader(fixture.accessToken)).send({ version: 1 }).then((response) => response))
      }
      await waitForAnnouncementLockWaiters(4)
      await blocker.query('COMMIT')
      const responses = await Promise.all(requests)
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
      expect(new Set(responses.map((response) => response.body.acknowledgedAt)).size).toBe(1)
      expect(new Set(responses.map((response) => response.body.readAt)).size).toBe(1)
      const receipts = await prisma.announcementReceipt.findMany({ where: { announcementId: fixture.announcement.id, userId: fixture.userId } })
      expect(receipts).toHaveLength(1)
      expect(receipts[0].version).toBe(1)
      expect(receipts[0].acknowledgedAt?.toISOString()).toBe(responses[0].body.acknowledgedAt)
    } finally {
      try {
        await blocker.query('ROLLBACK')
        await Promise.allSettled(requests)
      } finally {
        await blocker.end()
      }
    }
  })

  it('does not erase an acknowledgement when read and acknowledge compete', async () => {
    const fixture = await createAnnouncementFixture()
    const responses = await Promise.all(['read', 'acknowledge', 'read', 'acknowledge'].map((operation) => (
      api.post(`/api/announcements/${fixture.announcement.id}/${operation}`)
        .set(authHeader(fixture.accessToken)).send({ version: 1 }).then((response) => response)
    )))
    expect(responses.every((response) => response.status === 200)).toBe(true)
    const receipts = await prisma.announcementReceipt.findMany({ where: { announcementId: fixture.announcement.id } })
    expect(receipts).toHaveLength(1)
    expect(receipts[0].readAt).not.toBeNull()
    expect(receipts[0].acknowledgedAt).not.toBeNull()
    const acknowledgedAt = receipts[0].acknowledgedAt!.toISOString()
    const repeated = await api.post(`/api/announcements/${fixture.announcement.id}/acknowledge`)
      .set(authHeader(fixture.accessToken)).send({ version: 1 })
    expect(repeated.status).toBe(200)
    expect(repeated.body.acknowledgedAt).toBe(acknowledgedAt)
  })
})

describe('notification remediation session mismatch concurrency gates', () => {
  it.each([
    { operation: 'refresh', sameUser: true },
    { operation: 'refresh', sameUser: false },
    { operation: 'logout', sameUser: true },
    { operation: 'logout', sameUser: false },
  ])('does not let mismatched $operation affect a valid concurrent rotation (sameUser=$sameUser)', async ({ operation, sameUser }) => {
    const firstAccount = await createTestUser('session-owner-a@test.local', 'concurrency-password')
    const secondAccount = sameUser ? firstAccount : await createTestUser('session-owner-b@test.local', 'concurrency-password')
    const firstSession = await loginAs(firstAccount.user.email, firstAccount.password)
    const secondSession = await loginAs(secondAccount.user.email, secondAccount.password)
    const firstSessionId = decodeSessionId(firstSession.accessToken)
    const secondSessionId = decodeSessionId(secondSession.accessToken)
    const firstRowsBefore = await prisma.refreshToken.findMany({ where: { sessionId: firstSessionId }, orderBy: { id: 'asc' } })
    const holderReady = createGate()
    const releaseHolder = createGate()
    const holder = prisma.$transaction(async (transaction) => {
      await lockUserRefreshSessionMutations(transaction, secondAccount.user.id)
      holderReady.release()
      await releaseHolder.promise
    }, { timeout: 15_000 })
    const requests: Array<Promise<Response>> = []
    try {
      await holderReady.promise
      requests.push(api.post(`/api/auth/${operation}`).set('Cookie', secondSession.cookies)
        .send({ expectedSessionId: firstSessionId }).then((response) => response))
      requests.push(api.post('/api/auth/refresh').set('Cookie', secondSession.cookies)
        .send({ expectedSessionId: secondSessionId }).then((response) => response))
      await waitForSessionLockWaiters(secondAccount.user.id, 2)
      releaseHolder.release()
      await holder
      const [mismatched, rotated] = await Promise.all(requests)
      expect(mismatched.status).toBe(409)
      expect(mismatched.body.error.code).toBe('SESSION_CHANGED')
      expect(mismatched.headers['set-cookie']).toBeUndefined()
      expect(rotated.status).toBe(200)
      expect(rotated.headers['set-cookie']).toBeDefined()
      expect(decodeSessionId(rotated.body.accessToken)).toBe(secondSessionId)
      expect(await prisma.refreshToken.findMany({ where: { sessionId: firstSessionId }, orderBy: { id: 'asc' } })).toEqual(firstRowsBefore)
      const secondRows = await prisma.refreshToken.findMany({ where: { sessionId: secondSessionId } })
      expect(secondRows).toHaveLength(2)
      expect(secondRows.filter((row) => !row.revoked)).toHaveLength(1)
      expect(await prisma.securityEvent.count({ where: { userId: secondAccount.user.id, type: 'session_replay_detected' } })).toBe(0)
    } finally {
      releaseHolder.release()
      await Promise.allSettled([holder, ...requests])
    }
  })
})
