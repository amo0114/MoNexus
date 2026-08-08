import { describe, it, expect } from 'vitest'
import { api, createTestUser, createTestMerchant, loginAs } from './helpers.js'
import { loginUser, refreshAccessToken } from '../modules/auth/service.js'
import { prisma } from '../lib/prisma.js'

describe('POST /api/auth/register', () => {
  it('should register a new user and return access token + user', async () => {
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'newuser@test.local', password: 'abcdef' })
      .expect(201)

    expect(res.body.accessToken).toBeDefined()
    expect(res.body.user).toBeDefined()
    expect(res.body.user.email).toBe('newuser@test.local')
    expect(res.body.user.role).toBe('user')
    expect(res.body.user.status).toBeDefined()
    // Registration rewards are now held until email verification and the
    // configured release window complete; the account starts at zero.
    expect(res.body.user.points).toBe(0)
    // refresh token cookie
    const cookies = (res.headers['set-cookie'] as unknown) as string[]
    expect(cookies.some(c => c.startsWith('refreshToken='))).toBe(true)
  })

  it('should reject duplicate email', async () => {
    await createTestUser('dup@test.local')
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'dup@test.local', password: 'abcdef' })
      .expect(409)

    expect(res.body.error.code).toBe('CONFLICT')
  })

  it('should reject invalid email', async () => {
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'notanemail', password: 'abcdef' })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('assigns branded default nickname when omitted', async () => {
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'auto-nick@test.local', password: 'abcdef' })
      .expect(201)

    expect(res.body.user.nickname).toMatch(/^mn_[2-9A-HJ-NP-Z]{8}$/)
    expect(res.body.user.avatarUrl).toBeNull()
  })

  it('accepts optional nickname on register', async () => {
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'custom-nick@test.local', password: 'abcdef', nickname: '  小明同学  ' })
      .expect(201)

    expect(res.body.user.nickname).toBe('小明同学')
  })
})

describe('POST /api/auth/login', () => {
  it('should login with correct credentials', async () => {
    const { user } = await createTestUser('login-test@test.local', 'mypassword')

    const res = await api
      .post('/api/auth/login')
      .send({ email: 'login-test@test.local', password: 'mypassword' })
      .expect(200)

    expect(res.body.accessToken).toBeDefined()
    expect(res.body.user.email).toBe(user.email)
    expect(res.body.user.status).toBeDefined()
    const cookies = (res.headers['set-cookie'] as unknown) as string[]
    expect(cookies.some(c => c.startsWith('refreshToken='))).toBe(true)
  })

  it('should reject wrong password', async () => {
    await createTestUser('wrongpw@test.local', 'correct')
    const res = await api
      .post('/api/auth/login')
      .send({ email: 'wrongpw@test.local', password: 'wrong' })
      .expect(401)

    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })
})

describe('POST /api/auth/refresh', () => {
  it('should issue new access token with valid refresh cookie', async () => {
    await createTestUser('refresh-test@test.local', 'pass123')
    const { cookies } = await loginAs('refresh-test@test.local', 'pass123')

    const res = await api
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.accessToken).toBeDefined()
    expect(typeof res.body.accessToken).toBe('string')
    // new refresh token cookie should be set
    const newCookies = (res.headers['set-cookie'] as unknown) as string[]
    expect(newCookies.some(c => c.startsWith('refreshToken='))).toBe(true)
  })

  it('should reject missing refresh token', async () => {
    const res = await api
      .post('/api/auth/refresh')
      .expect(401)

    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('allows only one concurrent rotation and treats the other use as replay', async () => {
    const { user, password } = await createTestUser('refresh-concurrent@test.local', 'pass123')
    const session = await loginUser(user.email, password)
    if (session.kind !== 'authenticated') throw new Error('Expected non-admin login session')

    const attempts = await Promise.allSettled([
      refreshAccessToken(session.refreshToken),
      refreshAccessToken(session.refreshToken),
    ])

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)

    // The replay policy revokes the whole family, including the one successor
    // that may have been returned to the winning parallel request.
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(2)
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0)
  })
})

describe('POST /api/auth/logout', () => {
  it('should clear refresh token cookie', async () => {
    await createTestUser('logout-test@test.local', 'pass123')
    const { cookies } = await loginAs('logout-test@test.local', 'pass123')

    const res = await api
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .expect(200)

    expect(res.body.ok).toBe(true)
  })
})

describe('GET /api/auth/me', () => {
  it('should return current user profile', async () => {
    const { user } = await createTestUser('me-test@test.local', 'pass123')
    const { accessToken } = await loginAs('me-test@test.local', 'pass123')

    const res = await api
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)

    expect(res.body.email).toBe(user.email)
    expect(res.body.role).toBe(user.role)
    expect(res.body.status).toBeDefined()
    expect(res.body.points).toBeDefined()
  })

  it('should return merchant profile for merchant user', async () => {
    const { user, merchant } = await createTestMerchant('merchant-me@test.local', 'pass123', {
      status: 'active',
      role: 'merchant',
      name: '商家A',
      commissionRate: 0.15,
    })
    const { accessToken } = await loginAs('merchant-me@test.local', 'pass123')

    const res = await api
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)

    expect(res.body.email).toBe(user.email)
    expect(res.body.role).toBe('merchant')
    expect(res.body.merchant.id).toBe(merchant.id)
    expect(res.body.merchant.name).toBe('商家A')
    expect(res.body.merchant.status).toBe('active')
    expect(Number(res.body.merchant.commissionRate)).toBe(0.15)
  })

  it('should reject without token', async () => {
    await api.get('/api/auth/me').expect(401)
  })
})
