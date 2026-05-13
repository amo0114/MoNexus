import { describe, expect, it } from 'vitest'
import { api, createTestUser } from './helpers.js'
import { config } from '../config/index.js'
import { refreshTokenCookieName } from '../lib/cookies.js'
import { prisma } from '../lib/prisma.js'

const oneDayMs = 24 * 60 * 60 * 1000

async function setRefreshTokenMaxAgeDays(days: number) {
  await prisma.systemConfig.upsert({
    where: { key: 'refreshTokenMaxAgeDays' },
    create: {
      key: 'refreshTokenMaxAgeDays',
      value: days,
      description: 'Refresh Token 有效天数',
    },
    update: { value: days },
  })
}

async function clearRefreshTokenMaxAgeConfig() {
  await prisma.systemConfig.deleteMany({ where: { key: 'refreshTokenMaxAgeDays' } })
}

function refreshCookieFrom(res: { headers: Record<string, unknown> }) {
  const cookies = res.headers['set-cookie'] as string[] | undefined
  const cookie = cookies?.find(item => item.startsWith(`${refreshTokenCookieName}=`))
  expect(cookie).toBeDefined()
  return cookie!
}

function expectCookieMaxAge(cookie: string, seconds: number) {
  expect(cookie).toContain(`Max-Age=${seconds}`)
}

function expectExpiresAround(expiresAt: Date, beforeMs: number, afterMs: number, maxAgeMs: number) {
  expect(expiresAt.getTime()).toBeGreaterThanOrEqual(beforeMs + maxAgeMs - 1500)
  expect(expiresAt.getTime()).toBeLessThanOrEqual(afterMs + maxAgeMs + 1500)
}

async function latestRefreshToken(userId: number) {
  return prisma.refreshToken.findFirstOrThrow({
    where: { userId },
    orderBy: { id: 'desc' },
  })
}

describe('refreshTokenMaxAgeDays runtime wiring', () => {
  it('uses the static refresh-token max age when no SystemConfig row exists', async () => {
    await clearRefreshTokenMaxAgeConfig()
    const { user, password } = await createTestUser('refresh-default@test.local', 'pass123')

    const before = Date.now()
    await api.post('/api/auth/login').send({ email: user.email, password }).expect(200)
    const after = Date.now()

    const token = await latestRefreshToken(user.id)
    expectExpiresAround(token.expiresAt, before, after, config.refreshTokenMaxAgeMs)
  })

  it('uses refreshTokenMaxAgeDays for new refresh-token DB expiry', async () => {
    await setRefreshTokenMaxAgeDays(1)
    const { user, password } = await createTestUser('refresh-config@test.local', 'pass123')

    const before = Date.now()
    await api.post('/api/auth/login').send({ email: user.email, password }).expect(200)
    const after = Date.now()

    const token = await latestRefreshToken(user.id)
    expectExpiresAround(token.expiresAt, before, after, oneDayMs)
  })

  it('uses refreshTokenMaxAgeDays for the refresh-token cookie Max-Age', async () => {
    await setRefreshTokenMaxAgeDays(1)
    const { user, password } = await createTestUser('refresh-cookie@test.local', 'pass123')

    const res = await api.post('/api/auth/login').send({ email: user.email, password }).expect(200)

    expectCookieMaxAge(refreshCookieFrom(res), 86_400)
  })

  it('does not retroactively change existing token expiry after config changes', async () => {
    await clearRefreshTokenMaxAgeConfig()
    const { user, password } = await createTestUser('refresh-existing@test.local', 'pass123')

    await api.post('/api/auth/login').send({ email: user.email, password }).expect(200)
    const originalToken = await latestRefreshToken(user.id)
    const originalExpiry = originalToken.expiresAt.getTime()

    await setRefreshTokenMaxAgeDays(1)

    const unchanged = await prisma.refreshToken.findUniqueOrThrow({ where: { id: originalToken.id } })
    expect(unchanged.expiresAt.getTime()).toBe(originalExpiry)
  })

  it('uses the current config when rotating a refresh token', async () => {
    await clearRefreshTokenMaxAgeConfig()
    const { user, password } = await createTestUser('refresh-rotate@test.local', 'pass123')

    const login = await api.post('/api/auth/login').send({ email: user.email, password }).expect(200)
    const originalToken = await latestRefreshToken(user.id)
    await setRefreshTokenMaxAgeDays(1)

    const before = Date.now()
    const refresh = await api
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookieFrom(login))
      .expect(200)
    const after = Date.now()

    const rotatedToken = await latestRefreshToken(user.id)
    expect(rotatedToken.id).not.toBe(originalToken.id)
    expectExpiresAround(rotatedToken.expiresAt, before, after, oneDayMs)
    expectCookieMaxAge(refreshCookieFrom(refresh), 86_400)
  })
})
