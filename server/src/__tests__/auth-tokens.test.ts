import { describe, it, expect, beforeEach } from 'vitest'
import bcrypt from 'bcryptjs'
import { api, createTestUser, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'

describe('Auth token flows (P0-D)', () => {
  let mailer: CaptureMailer

  beforeEach(() => {
    mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
  })

  describe('POST /api/auth/forgot-password', () => {
    it('should return 200 with a generic message for unknown email (no enumeration)', async () => {
      const res = await api
        .post('/api/auth/forgot-password')
        .send({ email: 'nonexistent@test.local' })
        .expect(200)

      expect(res.body.message).toBeTruthy()
      expect(mailer.sent).toHaveLength(0)
    })

    it('should create a token and email a link for a known user', async () => {
      const { user } = await createTestUser('reset-known@test.local')

      await api
        .post('/api/auth/forgot-password')
        .send({ email: user.email })
        .expect(200)

      const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } })
      expect(tokens).toHaveLength(1)
      expect(tokens[0].used).toBe(false)
      expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now())

      const mail = mailer.lastTo(user.email)
      expect(mail).toBeDefined()
      expect(mail!.subject).toMatch(/密码/)
      // Link must include a token; we don't assert the token value
      // since it's only ever held in plaintext on the request path.
      expect(mail!.text).toMatch(/\/reset-password\/[a-f0-9]+/)
    })

    it('invalidates an earlier unused reset link when a new one is requested', async () => {
      const { user } = await createTestUser('reset-reissue@test.local')

      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const firstRawToken = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)![1]

      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const secondRawToken = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)![1]

      expect(firstRawToken).not.toBe(secondRawToken)
      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      })
      expect(tokens).toHaveLength(2)
      expect(tokens.map(token => token.used)).toEqual([true, false])

      await api
        .post('/api/auth/reset-password')
        .send({ token: firstRawToken, password: 'old-link-password' })
        .expect(400)
      await api
        .post('/api/auth/reset-password')
        .send({ token: secondRawToken, password: 'new-link-password' })
        .expect(200)
    })
  })

  describe('POST /api/auth/reset-password', () => {
    it('should reject an unknown token with 400', async () => {
      const res = await api
        .post('/api/auth/reset-password')
        .send({ token: 'not-a-real-token', password: 'newpassword' })
        .expect(400)

      expect(res.body.error.code).toBe('BAD_REQUEST')
    })

    it('should reject an expired token with 400', async () => {
      const { user } = await createTestUser('reset-expired@test.local')
      const raw = 'expired-test-token-' + Date.now()
      const tokenHash = require('crypto').createHash('sha256').update(raw).digest('hex')
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() - 1000),
        },
      })

      const res = await api
        .post('/api/auth/reset-password')
        .send({ token: raw, password: 'newpassword' })
        .expect(400)

      expect(res.body.error.message).toMatch(/过期/)
    })

    it('should reset the password and revoke all refresh tokens', async () => {
      const { user, password } = await createTestUser('reset-ok@test.local')
      // Log in to establish a refresh token cookie we expect to be revoked.
      await loginAs('reset-ok@test.local', password)
      const tokensBefore = await prisma.refreshToken.count({
        where: { userId: user.id, revoked: false },
      })
      expect(tokensBefore).toBeGreaterThan(0)

      // Request a real reset token via the public endpoint so we don't
      // duplicate the token-hashing code in the test.
      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const stored = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      })
      expect(stored).toBeTruthy()
      // Recover the raw token from the captured mail (link contains it).
      const link = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)!
      const rawToken = link[1]

      await api
        .post('/api/auth/reset-password')
        .send({ token: rawToken, password: 'brand-new-password' })
        .expect(200)

      // New password works
      const updated = await prisma.user.findUnique({ where: { id: user.id } })
      expect(await bcrypt.compare('brand-new-password', updated!.password)).toBe(true)
      // Old password no longer works (compare returns false)
      expect(await bcrypt.compare(password, updated!.password)).toBe(false)
      // All refresh tokens revoked
      const tokensAfter = await prisma.refreshToken.count({
        where: { userId: user.id, revoked: false },
      })
      expect(tokensAfter).toBe(0)
      // Reset token marked used
      const usedToken = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id },
      })
      expect(usedToken!.used).toBe(true)
    })

    it('should reject a token that has already been used', async () => {
      const { user } = await createTestUser('reset-twice@test.local')
      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const link = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)!
      const rawToken = link[1]

      await api.post('/api/auth/reset-password').send({ token: rawToken, password: 'first-new-pw' }).expect(200)
      const res = await api
        .post('/api/auth/reset-password')
        .send({ token: rawToken, password: 'second-new-pw' })
        .expect(400)
      expect(res.body.error.message).toMatch(/已被使用/)
    })

    it('consumes a reset link exactly once under concurrent requests', async () => {
      const { user } = await createTestUser('reset-concurrent@test.local')
      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const rawToken = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)![1]

      const attempts = await Promise.all([
        api.post('/api/auth/reset-password').send({ token: rawToken, password: 'parallel-password-a' }),
        api.post('/api/auth/reset-password').send({ token: rawToken, password: 'parallel-password-b' }),
      ])
      expect(attempts.map(attempt => attempt.status).sort()).toEqual([200, 400])

      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
      const firstWon = await bcrypt.compare('parallel-password-a', updated.password)
      const secondWon = await bcrypt.compare('parallel-password-b', updated.password)
      expect(Number(firstWon) + Number(secondWon)).toBe(1)
      expect(await prisma.passwordResetToken.count({ where: { userId: user.id, used: false } })).toBe(0)
    })
  })

  describe('POST /api/auth/password-change', () => {
    it('should reject unauthenticated password changes', async () => {
      await api
        .post('/api/auth/password-change')
        .send({ currentPassword: 'old-password', newPassword: 'new-password' })
        .expect(401)
    })

    it('should change the password and revoke existing refresh tokens', async () => {
      const { user, password } = await createTestUser('change-ok@test.local', 'current-password')
      const login = await loginAs(user.email, password)

      const res = await api
        .post('/api/auth/password-change')
        .set(authHeader(login.accessToken))
        .send({ currentPassword: password, newPassword: 'new-password' })
        .expect(200)

      expect(res.body.message).toBe('密码已修改，请重新登录')

      await api
        .post('/api/auth/refresh')
        .set('Cookie', login.cookies)
        .expect(401)

      await api
        .post('/api/auth/login')
        .send({ email: user.email, password })
        .expect(401)

      await api
        .post('/api/auth/login')
        .send({ email: user.email, password: 'new-password' })
        .expect(200)

      const activeTokens = await prisma.refreshToken.count({
        where: { userId: user.id, revoked: false },
      })
      expect(activeTokens).toBe(1)
    })

    it('should reject a wrong current password without changing the password', async () => {
      const { user, password } = await createTestUser('change-wrong@test.local', 'current-password')
      const login = await loginAs(user.email, password)

      const res = await api
        .post('/api/auth/password-change')
        .set(authHeader(login.accessToken))
        .send({ currentPassword: 'wrong-password', newPassword: 'new-password' })
        .expect(401)

      expect(res.body.error.message).toMatch(/密码/)

      await api
        .post('/api/auth/login')
        .send({ email: user.email, password })
        .expect(200)

      await api
        .post('/api/auth/login')
        .send({ email: user.email, password: 'new-password' })
        .expect(401)
    })

    it('invalidates outstanding reset links after a password change', async () => {
      const { user, password } = await createTestUser('change-invalidates-reset@test.local', 'current-password')
      const login = await loginAs(user.email, password)
      await api.post('/api/auth/forgot-password').send({ email: user.email }).expect(200)
      const rawToken = mailer.lastTo(user.email)!.text.match(/reset-password\/([a-f0-9]+)/)![1]

      await api
        .post('/api/auth/password-change')
        .set(authHeader(login.accessToken))
        .send({ currentPassword: password, newPassword: 'changed-password' })
        .expect(200)

      expect(await prisma.passwordResetToken.count({ where: { userId: user.id, used: false } })).toBe(0)
      await api
        .post('/api/auth/reset-password')
        .send({ token: rawToken, password: 'should-not-work' })
        .expect(400)
    })
  })

  describe('POST /api/auth/send-verification', () => {
    it('should return 401 when not authenticated', async () => {
      await api.post('/api/auth/send-verification').expect(401)
    })

    it('should create a token and email a verification link', async () => {
      const { user, password } = await createTestUser('verify@test.local')
      const { accessToken } = await loginAs(user.email, password)

      await api
        .post('/api/auth/send-verification')
        .set(authHeader(accessToken))
        .expect(200)

      const tokens = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } })
      expect(tokens).toHaveLength(1)
      const mail = mailer.lastTo(user.email)
      expect(mail).toBeDefined()
      expect(mail!.text).toMatch(/verify-email#token=[a-f0-9]+/)
    })
  })

  describe('email verification claim', () => {
    it('does not consume an anonymous legacy GET token', async () => {
      const res = await api
        .get('/api/auth/verify-email')
        .query({ token: 'not-a-real-token' })
        .expect(410)
      expect(res.body.error.code).toBe('BAD_REQUEST')
    })

    it('should mark the user as verified on a valid token', async () => {
      const { user, password } = await createTestUser('verify-ok@test.local')
      const { accessToken } = await loginAs(user.email, password)

      await api.post('/api/auth/send-verification').set(authHeader(accessToken)).expect(200)
      const rawToken = mailer.lastTo(user.email)!.text.match(/#token=([a-f0-9]+)/)![1]

      await api.get('/api/auth/verify-email').query({ token: rawToken }).expect(410)
      expect((await prisma.user.findUnique({ where: { id: user.id } }))!.emailVerified).toBeNull()

      await api
        .post('/api/auth/verify-email')
        .set(authHeader(accessToken))
        .send({ token: rawToken })
        .expect(200)

      const updated = await prisma.user.findUnique({ where: { id: user.id } })
      expect(updated!.emailVerified).toBeInstanceOf(Date)
    })

    it('requires the authenticated owner of the token and claims exactly once', async () => {
      const first = await createTestUser('verify-owner-a@test.local')
      const second = await createTestUser('verify-owner-b@test.local')
      const firstSession = await loginAs(first.user.email, first.password)
      const secondSession = await loginAs(second.user.email, second.password)

      await api.post('/api/auth/send-verification').set(authHeader(firstSession.accessToken)).expect(200)
      const rawToken = mailer.lastTo(first.user.email)!.text.match(/#token=([a-f0-9]+)/)![1]

      await api.post('/api/auth/verify-email').set(authHeader(secondSession.accessToken)).send({ token: rawToken }).expect(400)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: first.user.id } })).emailVerified).toBeNull()

      const attempts = await Promise.all([
        api.post('/api/auth/verify-email').set(authHeader(firstSession.accessToken)).send({ token: rawToken }),
        api.post('/api/auth/verify-email').set(authHeader(firstSession.accessToken)).send({ token: rawToken }),
      ])
      expect(attempts.map(attempt => attempt.status).sort()).toEqual([200, 400])
      const token = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: first.user.id } })
      expect(token.used).toBe(true)
    })

    it('invalidates an earlier verification token when resending', async () => {
      const { user, password } = await createTestUser('verify-reissue@test.local')
      const { accessToken } = await loginAs(user.email, password)
      await api.post('/api/auth/send-verification').set(authHeader(accessToken)).expect(200)
      const firstToken = mailer.lastTo(user.email)!.text.match(/#token=([a-f0-9]+)/)![1]
      await api.post('/api/auth/send-verification').set(authHeader(accessToken)).expect(200)
      const secondToken = mailer.lastTo(user.email)!.text.match(/#token=([a-f0-9]+)/)![1]
      expect(firstToken).not.toBe(secondToken)
      await api.post('/api/auth/verify-email').set(authHeader(accessToken)).send({ token: firstToken }).expect(400)
      await api.post('/api/auth/verify-email').set(authHeader(accessToken)).send({ token: secondToken }).expect(200)
    })
  })
})
